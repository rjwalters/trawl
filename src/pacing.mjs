// Per-origin request pacing that persists across separate trawl invocations.
//
// `Crawl-delay` used to be honoured only *within* one run (a sleep between
// the robots.txt fetch and the page fetch), so a shell loop of `trawl` calls
// got no spacing at all. This module records, per origin, when the last
// request was started and the last known (clamped) Crawl-delay, under a
// state directory on disk, and makes every gated request wait until
//
//     max(minimum interval, Crawl-delay)
//
// has elapsed since the previous one — whichever process made it.
//
// Coordination: an atomic rename keeps the JSON state from tearing, but it
// does not serialize read → wait → record → send. That needs a per-origin
// interprocess lock, held across exactly that window and released as soon as
// the request has been *initiated* (not completed), so a slow page never
// blocks the next process for longer than the pacing itself requires. There
// is deliberately no global lock: different origins never wait on each other.
//
// Failure behaviour is biased toward "still render": a missing or corrupt
// state file means "no prior request"; an unusable state directory produces
// one stderr warning and falls back to in-process pacing (so the robots.txt →
// page gap within one run is still honoured, but spacing across processes is
// not guaranteed). Lock contention that outlasts a finite budget is the one
// hard failure — reported as a PacingError *before* any unpaced request.
//
// Nothing fetched is ever written here: no URLs, credentials, cookies, or
// page content. Files are named by a digest of the canonical origin.
//
// Browser-free, and every side effect (clock, sleep, directory, diagnostics,
// liveness check) is injectable so the policy is testable deterministically.

import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { MAX_CRAWL_DELAY_MS } from "./robots.mjs";
import {
	LockTimeoutError,
	createFileLock,
	defaultIsAlive,
	defaultStateDir,
	originDigest,
	realSleep,
	writeJsonAtomic,
} from "./state.mjs";

// Re-exported: the state directory and file naming are shared with
// src/cooldown.mjs through src/state.mjs.
export { defaultStateDir, originDigest };

// The documented floor between two requests to one origin when robots.txt
// asks for nothing (or for less).
export const DEFAULT_MIN_INTERVAL_MS = 1000;

// The minimum interval shares Crawl-delay's cap, so no configuration can make
// a single wait unbounded.
export const MAX_MIN_INTERVAL_MS = MAX_CRAWL_DELAY_MS;

// How long to queue for another process's per-origin lock before giving up.
// A holder keeps the lock for at most one wait (<= MAX_CRAWL_DELAY_MS) plus
// the instant it takes to initiate a request, so this covers a holder that is
// mid-way through a maximal wait with another queued ahead of us.
export const DEFAULT_LOCK_TIMEOUT_MS = 2 * MAX_CRAWL_DELAY_MS;

// A lock this old cannot belong to a live holder: holders release right after
// initiating a request, so their hold time is bounded by one capped wait. Only
// consulted when the owner's liveness cannot be proven dead directly (another
// host, or a PID that may have been reused).
export const STALE_LOCK_MS = 5 * 60 * 1000;

const STATE_VERSION = 1;

export class PacingError extends Error {
	constructor(message) {
		super(message);
		this.name = "PacingError";
	}
}

// Accepts a number or a numeric string; returns milliseconds or throws. The
// bounds are checked here, before any network or browser work.
export function validateMinInterval(value, label = "minIntervalMs") {
	const n =
		typeof value === "string"
			? value.trim() === ""
				? Number.NaN
				: Number(value)
			: value;
	if (
		typeof n !== "number" ||
		!Number.isFinite(n) ||
		n < 0 ||
		n > MAX_MIN_INTERVAL_MS
	) {
		throw new Error(
			`${label} expects a number of milliseconds from 0 to ` +
				`${MAX_MIN_INTERVAL_MS}, got "${value}"`,
		);
	}
	return n;
}

// How long to wait before the next request. A `lastRequestAt` in the future
// (the clock went backwards, or another host's clock is ahead) is clamped:
// the wait never exceeds `requiredMs`, itself bounded by the caps above.
export function computeWaitMs({ now, lastRequestAt, requiredMs }) {
	if (!(requiredMs > 0) || lastRequestAt == null) return 0;
	const elapsed = now - lastRequestAt;
	return Math.min(requiredMs, Math.max(0, requiredMs - elapsed));
}

// Validate what came off disk field by field; anything implausible is
// "unknown", never trusted.
export function parseState(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return { lastRequestAt: null, crawlDelayMs: null };
	}
	if (!data || typeof data !== "object") {
		return { lastRequestAt: null, crawlDelayMs: null };
	}
	const last = data.lastRequestAt;
	const delay = data.crawlDelayMs;
	return {
		lastRequestAt:
			typeof last === "number" && Number.isFinite(last) && last > 0
				? last
				: null,
		crawlDelayMs:
			typeof delay === "number" &&
			Number.isFinite(delay) &&
			delay >= 0 &&
			delay <= MAX_CRAWL_DELAY_MS
				? delay
				: null,
	};
}

export function createPacer({
	origin,
	stateDir = defaultStateDir(),
	minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
	now = Date.now,
	sleep = realSleep,
	warn = (message) => process.stderr.write(`trawl: ${message}\n`),
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
	staleLockMs = STALE_LOCK_MS,
	isAlive = defaultIsAlive,
	pid = process.pid,
	host = hostname(),
} = {}) {
	if (!origin) throw new Error("createPacer requires an origin");
	const minimum = validateMinInterval(minIntervalMs);
	const dir = path.join(stateDir, "pacing");
	const digest = originDigest(origin);
	const statePath = path.join(dir, `${digest}.json`);
	const lockPath = path.join(dir, `${digest}.lock`);

	// What this process itself knows, so pacing still works (within the run)
	// when the directory is unusable, and a vanished state file cannot make
	// us forget a request we just made.
	let local = { lastRequestAt: null, crawlDelayMs: null };
	let degraded = false;

	const degrade = (err) => {
		if (degraded) return;
		degraded = true;
		warn(
			`pacing state directory ${dir} is unusable ` +
				`(${err?.code ?? err?.message ?? err}); pacing continues within this ` +
				"run only, so spacing across separate trawl processes is not " +
				"guaranteed.",
		);
	};

	const lock = createFileLock({
		lockPath,
		timeoutMs: lockTimeoutMs,
		staleMs: staleLockMs,
		now,
		sleep,
		isAlive,
		pid,
		host,
	});

	async function acquire() {
		if (degraded) return null;
		try {
			mkdirSync(dir, { recursive: true });
			return await lock.acquire();
		} catch (err) {
			if (err instanceof LockTimeoutError) {
				throw new PacingError(
					`pacing: gave up after ${lockTimeoutMs}ms waiting for another ` +
						`trawl process to finish pacing requests to ${origin}. ` +
						"Retry, or pass --no-pacing to skip cross-run pacing.",
				);
			}
			degrade(err);
			return null;
		}
	}

	function readState() {
		try {
			return parseState(readFileSync(statePath, "utf8"));
		} catch {
			return { lastRequestAt: null, crawlDelayMs: null };
		}
	}

	function writeState(state) {
		try {
			writeJsonAtomic(statePath, { version: STATE_VERSION, ...state });
		} catch (err) {
			degrade(err);
		}
	}

	// Wait for this origin's turn, record the attempt, then call `start()` to
	// initiate the request. The lock is released as soon as `start()` has
	// returned its promise; the request itself completes unlocked.
	//
	//   crawlDelayMs   a freshly learned (clamped) Crawl-delay: used for this
	//                  wait and persisted for the next run.
	//   useStoredDelay when no fresh delay is given, honour the last one stored
	//                  (default). `false` = minimum interval only, e.g. under
	//                  --ignore-robots.
	//   admit          called after the wait, immediately before the attempt
	//                  is recorded and `start()` runs; if it throws, nothing
	//                  is recorded or sent and the error propagates. Used to
	//                  re-check a cooldown another process may have recorded
	//                  while this one waited (src/cooldown.mjs).
	async function gate(
		start,
		{ crawlDelayMs, useStoredDelay = true, admit } = {},
	) {
		const releaseLock = await acquire();
		let promise;
		try {
			const disk = degraded ? local : readState();
			const lastRequestAt = Math.max(
				disk.lastRequestAt ?? 0,
				local.lastRequestAt ?? 0,
			) || null;
			const knownDelay = disk.crawlDelayMs ?? local.crawlDelayMs;
			const fresh =
				typeof crawlDelayMs === "number" && Number.isFinite(crawlDelayMs)
					? Math.min(Math.max(crawlDelayMs, 0), MAX_CRAWL_DELAY_MS)
					: null;
			const delay =
				fresh ?? (useStoredDelay ? (knownDelay ?? 0) : 0);
			const required = Math.max(minimum, delay);

			// Re-check the clock after every sleep, but never sleep more than
			// `required` in total, whatever the clock does meanwhile.
			let slept = 0;
			for (;;) {
				const wait = computeWaitMs({
					now: now(),
					lastRequestAt,
					requiredMs: required,
				});
				const budget = required - slept;
				if (wait <= 0 || budget <= 0) break;
				const step = Math.min(wait, budget);
				await sleep(step);
				slept += step;
			}

			admit?.();

			const state = {
				lastRequestAt: now(),
				crawlDelayMs: fresh ?? knownDelay ?? null,
			};
			local = state;
			if (!degraded) writeState(state);
			promise = start();
		} finally {
			releaseLock?.();
		}
		return await promise;
	}

	return {
		gate,
		get degraded() {
			return degraded;
		},
		statePath,
		lockPath,
	};
}
