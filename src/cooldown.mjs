// Per-origin cooldowns after a 429 / 503, remembered across invocations.
//
// When an origin answers a page navigation with 429 Too Many Requests or 503
// Service Unavailable, a loop of `trawl` calls used to retry it immediately.
// This module records, per origin, until when the origin asked to be left
// alone — from `Retry-After` (delta-seconds or an HTTP-date) when it sent one,
// else an exponential backoff (60 s × 2^(n−1), capped at 1 h) — and refuses
// a later request to that origin, before any network or browser work, until
// the cooldown has passed. The refusal is a CooldownError (CLI exit 4).
//
// Policy, in one place:
//   - 429 and 503 share one per-origin failure streak, Retry-After or not.
//   - A valid Retry-After wins outright, even when longer than the fallback
//     cap; zero or a past date means "no wait". Anything else (malformed,
//     negative, absurdly large) falls back to the backoff.
//   - The streak survives the cooldown's expiry, so repeated failures keep
//     backing off; it is reset by a 2xx navigation response, or by 24 h
//     without a recorded failure. Other statuses and transport errors neither
//     extend nor reset it.
//   - An update never shortens a later cooldown already on disk, and a 2xx
//     only clears the record *generation* its request was admitted against,
//     so an older success cannot erase a newer failure from another process.
//
// Storage: `<stateDir>/cooldown/<digest of origin>.json`, versioned, holding
// only the expiry, the failure count, the last failure's time and status, and
// a generation counter. Updates take a short per-origin interprocess lock
// (src/state.mjs) around read → modify → write only; it is never held across
// a navigation. Reads are lock-free (writes are atomic renames).
//
// Failure behaviour: a missing, corrupt, or unrecognised file means "no
// cooldown". An unreadable or unwritable state directory, or a lock that
// cannot be had within a few seconds, produces one stderr warning and the
// rest of the call runs in-memory: cooldowns it learns still apply to its
// own later requests, and a cooldown it has already read is still enforced.
//
// Browser-free, and the clock, directory, and diagnostics are injectable.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	LockTimeoutError,
	createFileLock,
	defaultStateDir,
	originDigest,
	stateOrigin,
	writeJsonAtomic,
} from "./state.mjs";

export const COOLDOWN_STATUSES = new Set([429, 503]);

export const FALLBACK_BASE_MS = 60 * 1000;
export const FALLBACK_CAP_MS = 60 * 60 * 1000;
// A streak with no new failure for this long starts over.
export const STREAK_RESET_MS = 24 * 60 * 60 * 1000;

// Holders keep a cooldown lock only for one read → modify → write, so a
// short wait is plenty; anything longer is a stuck or foreign lock.
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const STALE_LOCK_MS = 30 * 1000;

// The largest instant a JavaScript Date can represent.
const MAX_TIME_MS = 8.64e15;
const STATE_VERSION = 1;
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

export const cooldownOrigin = stateOrigin;

export class CooldownError extends Error {
	constructor({ origin, until, now, status, retrySuppressed = false }) {
		const remainingMs = Math.max(0, until - now);
		const why = status ? `HTTP ${status}` : "a 429/503 response";
		super(
			`${origin} is cooling down after ${why} until ` +
				`${new Date(until).toISOString()} (${formatDuration(remainingMs)} ` +
				"from now)" +
				(retrySuppressed
					? "; the networkidle-fallback retry was not sent"
					: "") +
				". Wait until then, or pass --ignore-cooldown (ignoreCooldown: " +
				"true) to request it anyway.",
		);
		this.name = "CooldownError";
		this.code = "TRAWL_COOLDOWN";
		this.origin = origin;
		this.until = until;
		this.remainingMs = remainingMs;
		this.status = status ?? null;
	}
}

// "1h 2m 3s", "45s", "0s". Rounds up so "0s" only ever means expired.
export function formatDuration(ms) {
	let s = Math.ceil(Math.max(0, ms) / 1000);
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	const parts = [];
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (s || parts.length === 0) parts.push(`${s}s`);
	return parts.join(" ");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const DAY = `(?:${DAYS.join("|")})`;
const LONG_DAY = `(?:${LONG_DAYS.join("|")})`;
const MONTH = `(${MONTHS.join("|")})`;
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
// RFC 9110 §5.6.7: IMF-fixdate, and the two obsolete forms recipients must
// still accept.
const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
const RFC850_DATE = new RegExp(
	`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`,
);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`);

function utc(year, month, day, h, m, s) {
	if (h > 23 || m > 59 || s > 60) return null;
	// A leap second is the next instant, as far as a cooldown is concerned.
	const t = Date.UTC(year, month, day, h, m, Math.min(s, 59)) + (s === 60 ? 1000 : 0);
	const d = new Date(t);
	// Rejects Feb 30 and friends, which Date.UTC would silently roll over.
	if (d.getUTCDate() !== day || d.getUTCMonth() !== month) return null;
	return t;
}

// An HTTP-date in any of its three forms, as epoch ms; null when invalid.
// Only for Retry-After here, so a non-GMT or loosely formatted date is
// treated as malformed rather than guessed at (Date.parse would accept far
// more than the RFC does).
export function parseHttpDate(value, now = Date.now()) {
	let m = IMF_FIXDATE.exec(value);
	if (m) {
		return utc(Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1]), +m[4], +m[5], +m[6]);
	}
	m = RFC850_DATE.exec(value);
	if (m) {
		// Two-digit years: RFC 9110 says one more than 50 years in the future
		// is the most recent past year with those digits.
		let year = 2000 + Number(m[3]);
		const thisYear = new Date(now).getUTCFullYear();
		while (year > thisYear + 50) year -= 100;
		return utc(year, MONTHS.indexOf(m[2]), Number(m[1]), +m[4], +m[5], +m[6]);
	}
	m = ASCTIME_DATE.exec(value);
	if (m) {
		return utc(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2].trim()), +m[3], +m[4], +m[5]);
	}
	return null;
}

// How long `Retry-After` asks us to wait, in ms, measured from `receivedAt`;
// null when the header is absent or unusable (the caller falls back).
// Zero and past dates are a valid "0".
export function parseRetryAfter(value, receivedAt = Date.now()) {
	if (typeof value !== "string") return null;
	const v = value.trim();
	if (v === "") return null;
	let delayMs;
	if (/^\d+$/.test(v)) {
		const seconds = Number(v);
		if (!Number.isSafeInteger(seconds)) return null;
		delayMs = seconds * 1000;
	} else {
		const at = parseHttpDate(v, receivedAt);
		if (at === null) return null;
		delayMs = Math.max(0, at - receivedAt);
	}
	if (!Number.isFinite(delayMs) || receivedAt + delayMs > MAX_TIME_MS) {
		return null;
	}
	return delayMs;
}

// 60 s × 2^(failures − 1), capped at 1 h. The exponent is clamped first so
// no streak length can overflow it.
export function fallbackDelayMs(failures) {
	const n = Math.max(1, Math.floor(Number(failures) || 1));
	const exponent = Math.min(n - 1, 16);
	return Math.min(FALLBACK_CAP_MS, FALLBACK_BASE_MS * 2 ** exponent);
}

const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TIME_MS;

// Validate a record off disk field by field; anything implausible makes the
// whole record unusable (null), never partially trusted.
export function parseRecord(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || data.version !== STATE_VERSION) {
		return null;
	}
	const { until, failures, lastFailureAt, generation, status } = data;
	if (!isTime(until)) return null;
	if (!Number.isSafeInteger(failures) || failures < 0) return null;
	if (lastFailureAt !== null && !isTime(lastFailureAt)) return null;
	if (!Number.isSafeInteger(generation) || generation < 1) return null;
	if (status !== null && !COOLDOWN_STATUSES.has(status)) return null;
	return { until, failures, lastFailureAt, generation, status };
}

// The record after one more 429/503 received at `now`.
export function nextFailureRecord(prev, { now, status, retryAfter }) {
	const fresh =
		prev?.lastFailureAt != null && now - prev.lastFailureAt < STREAK_RESET_MS;
	const failures = (fresh ? prev.failures : 0) + 1;
	const delay = parseRetryAfter(retryAfter, now) ?? fallbackDelayMs(failures);
	return {
		until: Math.max(now + delay, prev?.until ?? 0),
		failures,
		lastFailureAt: now,
		generation: (prev?.generation ?? 0) + 1,
		status: COOLDOWN_STATUSES.has(status) ? status : null,
	};
}

// The record after a 2xx: streak and expiry cleared, generation advanced
// (never deleted, so a request admitted against an older generation can
// still tell that something changed since).
export function clearedRecord(prev) {
	return {
		until: 0,
		failures: 0,
		lastFailureAt: null,
		generation: (prev?.generation ?? 0) + 1,
		status: null,
	};
}

// The later of two views of one origin's record.
function laterOf(a, b) {
	if (!a) return b ?? null;
	if (!b) return a;
	const newer = b.generation > a.generation ? b : a;
	return { ...newer, until: Math.max(a.until, b.until) };
}

export function createCooldownStore({
	stateDir = defaultStateDir(),
	now = Date.now,
	warn = (message) => process.stderr.write(`trawl: ${message}\n`),
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
	staleLockMs = STALE_LOCK_MS,
	sleep,
	isAlive,
	pid,
	host,
} = {}) {
	const dir = path.join(stateDir, "cooldown");

	// What this call itself knows per origin: survives a failed write, and
	// covers a degraded store.
	const local = new Map();
	// The generation this call last saw (or wrote) per origin; a 2xx may only
	// clear that one. 0 = "no record when we looked".
	const known = new Map();
	let degraded = false;
	// Persistence is serialized within the call, and never rejects.
	let chain = Promise.resolve();

	const degrade = (err) => {
		if (degraded) return;
		degraded = true;
		const why =
			err instanceof LockTimeoutError
				? `its lock stayed busy for ${lockTimeoutMs}ms`
				: (err?.code ?? err?.message ?? String(err));
		warn(
			`cooldown state directory ${dir} is unusable (${why}); cooldowns ` +
				"from earlier runs may be missed and new ones last only for this run.",
		);
	};

	const files = (origin) => {
		const digest = originDigest(origin);
		return {
			statePath: path.join(dir, `${digest}.json`),
			lockPath: path.join(dir, `${digest}.lock`),
		};
	};

	function readDisk(origin) {
		if (degraded) return null;
		try {
			return parseRecord(readFileSync(files(origin).statePath, "utf8"));
		} catch (err) {
			// No file — or a path that cannot hold one — is simply "no
			// cooldown"; that only becomes a problem (and a warning) if this run
			// has one to write. Anything else (EACCES, EISDIR, EIO) is reported.
			if (!ABSENT.has(err?.code)) degrade(err);
			return null;
		}
	}

	// The freshest view of `origin`: what is on disk merged with what this
	// call already knows. Remembers the generation for a later 2xx.
	function read(origin) {
		const record = laterOf(local.get(origin), readDisk(origin));
		if (record) local.set(origin, record);
		if (!known.has(origin)) known.set(origin, record?.generation ?? 0);
		return record;
	}

	function active(origin) {
		const record = read(origin);
		const t = now();
		return record && record.until > t ? { record, now: t } : null;
	}

	// Throws CooldownError while `origin` is cooling down.
	function check(origin, { retrySuppressed = false } = {}) {
		if (!origin) return;
		const hit = active(origin);
		if (!hit) return;
		throw new CooldownError({
			origin,
			until: hit.record.until,
			now: hit.now,
			status: hit.record.status,
			retrySuppressed,
		});
	}

	async function update(origin, modify) {
		if (degraded) return null;
		const { statePath, lockPath } = files(origin);
		let release;
		try {
			mkdirSync(dir, { recursive: true });
			release = await createFileLock({
				lockPath,
				timeoutMs: lockTimeoutMs,
				staleMs: staleLockMs,
				now,
				...(sleep && { sleep }),
				...(isAlive && { isAlive }),
				...(pid !== undefined && { pid }),
				...(host !== undefined && { host }),
			}).acquire();
		} catch (err) {
			degrade(err);
			return null;
		}
		try {
			let disk = null;
			try {
				disk = parseRecord(readFileSync(statePath, "utf8"));
			} catch (err) {
				if (!ABSENT.has(err?.code)) throw err;
			}
			const next = modify(disk);
			if (!next) return disk;
			writeJsonAtomic(statePath, { version: STATE_VERSION, ...next });
			return next;
		} catch (err) {
			degrade(err);
			return null;
		} finally {
			release();
		}
	}

	const enqueue = (job) => {
		chain = chain.then(job).catch((err) => degrade(err));
		return chain;
	};

	// A 429/503 main-frame response. The in-memory record is updated
	// synchronously, so a later request in the same call sees it even before
	// (or without) the write landing.
	function recordFailure(origin, { status, retryAfter, receivedAt = now() }) {
		if (!origin) return chain;
		const event = { now: receivedAt, status, retryAfter };
		local.set(origin, nextFailureRecord(read(origin), event));
		return enqueue(async () => {
			const written = await update(origin, (disk) =>
				nextFailureRecord(disk, event),
			);
			if (written) {
				local.set(origin, laterOf(local.get(origin), written));
				known.set(origin, written.generation);
			}
		});
	}

	// A 2xx main-frame response: clear the streak, but only if nobody has
	// recorded a failure since this call last looked.
	function recordSuccess(origin) {
		if (!origin || !known.has(origin)) return chain;
		const seen = known.get(origin);
		const mine = local.get(origin);
		// Nothing on record when this call looked (or already clear), and no
		// failure of its own since: there is nothing this success may clear,
		// so don't even create the directory.
		const clear = (r) => !r || (r.failures === 0 && r.until === 0);
		if (seen === 0 && clear(mine)) return chain;
		if (mine && mine.generation === seen) {
			local.set(origin, clearedRecord(mine));
		}
		return enqueue(async () => {
			const expected = known.get(origin);
			let cleared = null;
			await update(origin, (disk) => {
				const gen = disk?.generation ?? 0;
				if (gen !== expected) return null;
				if (!disk || (disk.failures === 0 && disk.until === 0)) return null;
				cleared = clearedRecord(disk);
				return cleared;
			});
			if (cleared && !degraded) {
				local.set(origin, cleared);
				known.set(origin, cleared.generation);
			}
		});
	}

	return {
		check,
		read,
		recordFailure,
		recordSuccess,
		// Resolves once every write queued so far has finished (or failed and
		// been reported). Never rejects.
		flush: () => chain,
		get degraded() {
			return degraded;
		},
		dir,
		statePathFor: (origin) => files(origin).statePath,
	};
}
