// Cross-run pacing (src/pacing.mjs). Browser-free: the policy is driven by an
// injected clock/sleep and a temporary state directory, and the interprocess
// guarantees are checked with real, independent Node processes. Nothing here
// touches the real ~/.cache.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MIN_INTERVAL_MS,
	MAX_MIN_INTERVAL_MS,
	PacingError,
	computeWaitMs,
	createPacer,
	defaultStateDir,
	originDigest,
	pacingOrigin,
	parseState,
	validateMinInterval,
} from "../src/pacing.mjs";
import { MAX_CRAWL_DELAY_MS } from "../src/robots.mjs";

const ORIGIN = "https://example.test";
const PACING_URL = new URL("../src/pacing.mjs", import.meta.url).href;

function stateDir() {
	return mkdtempSync(path.join(tmpdir(), "trawl-pacing-"));
}

// A deterministic clock: sleeping advances it by exactly the requested time.
function fakeClock(start = 1_700_000_000_000) {
	const clock = {
		t: start,
		sleeps: [],
		now: () => clock.t,
		sleep: async (ms) => {
			clock.sleeps.push(ms);
			clock.t += ms;
		},
		get slept() {
			return clock.sleeps.reduce((a, b) => a + b, 0);
		},
	};
	return clock;
}

function pacer(dir, clock, extra = {}) {
	return createPacer({
		origin: ORIGIN,
		stateDir: dir,
		now: clock.now,
		sleep: clock.sleep,
		warn: () => {},
		...extra,
	});
}

const noop = async () => "sent";

// --- pure helpers ---

test("validateMinInterval accepts 0..cap and numeric strings", () => {
	assert.equal(validateMinInterval(0), 0);
	assert.equal(validateMinInterval("250"), 250);
	assert.equal(validateMinInterval(MAX_MIN_INTERVAL_MS), MAX_MIN_INTERVAL_MS);
	assert.equal(MAX_MIN_INTERVAL_MS, MAX_CRAWL_DELAY_MS);
});

for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_MIN_INTERVAL_MS + 1, "", "  ", "abc", "1e9", null, true]) {
	test(`validateMinInterval rejects ${JSON.stringify(bad) ?? String(bad)}`, () => {
		assert.throws(() => validateMinInterval(bad, "--min-interval"), /--min-interval expects/);
	});
}

test("pacingOrigin keys by scheme + host + effective port, never path", () => {
	assert.equal(pacingOrigin("https://a.test/x?y=1"), "https://a.test");
	assert.equal(pacingOrigin("https://a.test:443/other"), "https://a.test");
	assert.equal(pacingOrigin("http://a.test:80/"), "http://a.test");
	assert.equal(pacingOrigin("http://a.test:8080/"), "http://a.test:8080");
	assert.notEqual(pacingOrigin("http://a.test/"), pacingOrigin("https://a.test/"));
	assert.equal(pacingOrigin("file:///tmp/x.html"), null);
	assert.equal(pacingOrigin("data:text/html,hi"), null);
	assert.equal(pacingOrigin("not a url"), null);
});

test("defaultStateDir: TRAWL_STATE_DIR, then XDG_CACHE_HOME, then ~/.cache", () => {
	assert.equal(defaultStateDir({ TRAWL_STATE_DIR: "/s" }, "/h"), "/s");
	assert.equal(defaultStateDir({ XDG_CACHE_HOME: "/x" }, "/h"), path.join("/x", "trawl"));
	assert.equal(defaultStateDir({}, "/h"), path.join("/h", ".cache", "trawl"));
	// The XDG spec says relative paths are invalid and must be ignored.
	assert.equal(defaultStateDir({ XDG_CACHE_HOME: "rel" }, "/h"), path.join("/h", ".cache", "trawl"));
});

test("computeWaitMs clamps a future timestamp to the required delay", () => {
	assert.equal(computeWaitMs({ now: 1000, lastRequestAt: null, requiredMs: 500 }), 0);
	assert.equal(computeWaitMs({ now: 1000, lastRequestAt: 800, requiredMs: 500 }), 300);
	assert.equal(computeWaitMs({ now: 1000, lastRequestAt: 100, requiredMs: 500 }), 0);
	assert.equal(computeWaitMs({ now: 1000, lastRequestAt: 1e12, requiredMs: 500 }), 500);
	assert.equal(computeWaitMs({ now: 1000, lastRequestAt: 999, requiredMs: 0 }), 0);
});

test("parseState validates every field and treats junk as unknown", () => {
	const none = { lastRequestAt: null, crawlDelayMs: null };
	assert.deepEqual(parseState("{not json"), none);
	assert.deepEqual(parseState("null"), none);
	assert.deepEqual(parseState('"str"'), none);
	assert.deepEqual(parseState('{"lastRequestAt":"5","crawlDelayMs":-1}'), none);
	assert.deepEqual(
		parseState(`{"lastRequestAt":5,"crawlDelayMs":${MAX_CRAWL_DELAY_MS + 1}}`),
		{ lastRequestAt: 5, crawlDelayMs: null },
	);
	assert.deepEqual(parseState('{"lastRequestAt":5,"crawlDelayMs":0}'), {
		lastRequestAt: 5,
		crawlDelayMs: 0,
	});
});

// --- policy, with an injected clock ---

test("the first request to an origin does not wait", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	assert.equal(await pacer(dir, clock).gate(noop), "sent");
	assert.deepEqual(clock.sleeps, []);
});

test("a second invocation waits out the minimum interval since the first", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock).gate(noop);
	clock.t += 300;
	// A fresh pacer models a separate trawl process: it only knows the disk.
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, [DEFAULT_MIN_INTERVAL_MS - 300]);
});

test("no wait once the interval has already elapsed", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock).gate(noop);
	clock.t += 5000;
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, []);
});

test("different origins never delay each other", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock).gate(noop);
	await pacer(dir, clock, { origin: "https://other.test" }).gate(noop);
	await pacer(dir, clock, { origin: "https://example.test:8443" }).gate(noop);
	assert.deepEqual(clock.sleeps, []);
});

test("a larger Crawl-delay beats the minimum, and is remembered for the next run", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop); // robots.txt: nothing known yet
	await p.gate(noop, { crawlDelayMs: 3000 }); // page, after learning Crawl-delay
	assert.deepEqual(clock.sleeps, [3000]);
	// Next run's robots.txt fetch is paced on the stored delay.
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, [3000, 3000]);
});

test("the minimum wins when it is larger than Crawl-delay", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock, { minIntervalMs: 2000 });
	await p.gate(noop);
	await p.gate(noop, { crawlDelayMs: 500 });
	assert.deepEqual(clock.sleeps, [2000]);
});

test("a fresh policy of 'no delay' replaces a stored one", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock, { minIntervalMs: 0 }).gate(noop, { crawlDelayMs: 4000 });
	clock.t += 10_000;
	const p = pacer(dir, clock, { minIntervalMs: 0 });
	await p.gate(noop); // robots.txt fetch; succeeds and advertises no delay
	await p.gate(noop, { crawlDelayMs: 0 });
	await pacer(dir, clock, { minIntervalMs: 0 }).gate(noop);
	assert.deepEqual(clock.sleeps, []);
});

test("a zero minimum still honours Crawl-delay", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock, { minIntervalMs: 0 });
	await p.gate(noop);
	await p.gate(noop, { crawlDelayMs: 1500 });
	await p.gate(noop);
	assert.deepEqual(clock.sleeps, [1500, 1500]);
});

test("a zero minimum with no Crawl-delay never waits", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock, { minIntervalMs: 0 });
	await p.gate(noop);
	await p.gate(noop);
	assert.deepEqual(clock.sleeps, []);
});

test("useStoredDelay: false (--ignore-robots) paces on the minimum only", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock).gate(noop, { crawlDelayMs: 5000 });
	await pacer(dir, clock).gate(noop, { useStoredDelay: false });
	assert.deepEqual(clock.sleeps, [DEFAULT_MIN_INTERVAL_MS]);
	// ...and it does not erase the stored policy for a robots-honouring run.
	clock.t += 1;
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, [DEFAULT_MIN_INTERVAL_MS, 4999]);
});

test("an absurd Crawl-delay is capped at MAX_CRAWL_DELAY_MS", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	await p.gate(noop, { crawlDelayMs: 86_400_000 });
	assert.deepEqual(clock.sleeps, [MAX_CRAWL_DELAY_MS]);
});

test("a corrupt state file is treated as no prior request", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	writeFileSync(p.statePath, "\u0000garbage{");
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, []);
});

test("a timestamp in the future waits at most the required delay", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	writeFileSync(
		p.statePath,
		JSON.stringify({ version: 1, lastRequestAt: clock.t + 365 * 86_400_000, crawlDelayMs: null }),
	);
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, [DEFAULT_MIN_INTERVAL_MS]);
});

test("a clock that keeps going backwards cannot extend the total wait", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await pacer(dir, clock).gate(noop);
	// Every sleep "returns" to a time *earlier* than before it started.
	const rollback = async (ms) => {
		clock.sleeps.push(ms);
		clock.t -= 10_000;
	};
	await pacer(dir, clock, { sleep: rollback }).gate(noop);
	assert.equal(clock.slept, DEFAULT_MIN_INTERVAL_MS);
});

test("an attempt is recorded even when the request itself fails", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	await assert.rejects(
		pacer(dir, clock).gate(async () => {
			throw new Error("ECONNREFUSED");
		}),
		/ECONNREFUSED/,
	);
	await pacer(dir, clock).gate(noop);
	assert.deepEqual(clock.sleeps, [DEFAULT_MIN_INTERVAL_MS]);
});

test("state holds no URL, path, or origin text — only timestamps and the delay", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = createPacer({
		origin: "https://user:secret@example.test",
		stateDir: dir,
		now: clock.now,
		sleep: clock.sleep,
		warn: () => {},
	});
	await p.gate(noop, { crawlDelayMs: 1000 });
	const files = readdirSync(path.join(dir, "pacing"));
	assert.deepEqual(files, [`${originDigest("https://user:secret@example.test")}.json`]);
	const raw = readFileSync(p.statePath, "utf8");
	assert.doesNotMatch(raw, /example|secret|user|https?:/);
	assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
		"crawlDelayMs",
		"lastRequestAt",
		"version",
	]);
});

test("the lock is released once the request is initiated, not when it completes", async () => {
	const dir = stateDir();
	const p = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, warn: () => {} });
	let finish;
	let lockedDuringStart;
	const pending = p.gate(() => {
		lockedDuringStart = existsSync(p.lockPath);
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	// Let gate() run up to and past start().
	for (let i = 0; i < 20 && finish === undefined; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.equal(lockedDuringStart, true, "lock should be held while initiating");
	assert.equal(existsSync(p.lockPath), false, "lock should be gone while the request is in flight");
	finish("done");
	assert.equal(await pending, "done");
});

// --- unusable state directory ---

test("an unwritable state dir warns once and falls back to in-run pacing", async () => {
	const parent = stateDir();
	const notADir = path.join(parent, "file");
	writeFileSync(notADir, "occupied");
	const clock = fakeClock();
	const warnings = [];
	const p = pacer(notADir, clock, { warn: (m) => warnings.push(m) });
	assert.equal(await p.gate(noop), "sent");
	assert.equal(await p.gate(noop, { crawlDelayMs: 2000 }), "sent");
	assert.equal(p.degraded, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /unusable/);
	assert.match(warnings[0], /not\s+guaranteed/);
	// Pacing within the run still happened.
	assert.deepEqual(clock.sleeps, [2000]);
});

// --- the lock: contention, stale recovery ---

function writeLock(p, owner) {
	writeFileSync(p.lockPath, JSON.stringify(owner));
}

test("a live holder makes acquisition time out with a PacingError, and nothing is sent", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock, { lockTimeoutMs: 500 });
	await p.gate(noop); // creates the directory
	writeLock(p, { token: "other", pid: 4242, host: hostname(), createdAt: clock.t });
	let sent = false;
	await assert.rejects(
		pacer(dir, clock, { lockTimeoutMs: 500, isAlive: () => true }).gate(async () => {
			sent = true;
		}),
		(err) => err instanceof PacingError && /--no-pacing/.test(err.message),
	);
	assert.equal(sent, false);
	// The live holder's lock is untouched.
	assert.equal(JSON.parse(readFileSync(p.lockPath, "utf8")).token, "other");
});

test("a lock left by a dead process on this host is recovered", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	writeLock(p, { token: "crashed", pid: 4242, host: hostname(), createdAt: clock.t });
	clock.t += 5000;
	assert.equal(
		await pacer(dir, clock, { lockTimeoutMs: 100, isAlive: () => false }).gate(noop),
		"sent",
	);
	assert.equal(existsSync(p.lockPath), false);
});

test("a lock from a real exited process is recovered (real liveness check)", async () => {
	const dir = stateDir();
	const p = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, warn: () => {} });
	await p.gate(noop);
	const { pid } = spawnSync(process.execPath, ["-e", ""]);
	writeLock(p, { token: "gone", pid, host: hostname(), createdAt: Date.now() });
	const q = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, lockTimeoutMs: 1000, warn: () => {} });
	assert.equal(await q.gate(noop), "sent");
});

test("another host's lock is only evicted once it is ancient", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	writeLock(p, { token: "remote", pid: 1, host: "elsewhere.invalid", createdAt: clock.t });
	await assert.rejects(
		pacer(dir, clock, { lockTimeoutMs: 200, staleLockMs: 60_000 }).gate(noop),
		PacingError,
	);
	clock.t += 61_000;
	assert.equal(
		await pacer(dir, clock, { lockTimeoutMs: 200, staleLockMs: 60_000 }).gate(noop),
		"sent",
	);
});

test("a live PID's lock is not evicted just for being slow, only once impossibly old", async () => {
	const dir = stateDir();
	const clock = fakeClock();
	const p = pacer(dir, clock);
	await p.gate(noop);
	writeLock(p, { token: "slow", pid: 4242, host: hostname(), createdAt: clock.t });
	clock.t += 30_000; // a slow but plausible holder
	await assert.rejects(
		pacer(dir, clock, { lockTimeoutMs: 100, isAlive: () => true, staleLockMs: 60_000 }).gate(noop),
		PacingError,
	);
	clock.t += 60_000; // older than any real hold: the PID was reused
	assert.equal(
		await pacer(dir, clock, { lockTimeoutMs: 100, isAlive: () => true, staleLockMs: 60_000 }).gate(noop),
		"sent",
	);
});

test("an unreadable lock file is recovered after a short grace period", async () => {
	const dir = stateDir();
	const p = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, warn: () => {} });
	await p.gate(noop);
	writeFileSync(p.lockPath, "");
	const old = new Date(Date.now() - 60_000);
	utimesSync(p.lockPath, old, old);
	const q = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, lockTimeoutMs: 1000, warn: () => {} });
	assert.equal(await q.gate(noop), "sent");
});

test("concurrent gates in one process are serialized with the required spacing", async () => {
	const dir = stateDir();
	const starts = [];
	const mk = () => createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 200, warn: () => {} });
	await Promise.all(
		[mk(), mk(), mk()].map((p) =>
			p.gate(async () => {
				starts.push(Date.now());
			}),
		),
	);
	starts.sort((a, b) => a - b);
	assert.ok(starts[1] - starts[0] >= 195, `gap ${starts[1] - starts[0]}ms`);
	assert.ok(starts[2] - starts[1] >= 195, `gap ${starts[2] - starts[1]}ms`);
});

// --- independent processes sharing one state dir ---

// Each child waits until a shared wall-clock instant (so they really contend),
// then gates one "request" and prints the time it was initiated.
const CHILD = `
const { createPacer } = await import(process.env.PACING_URL);
const at = Number(process.env.START_AT);
while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
const p = createPacer({
	origin: process.env.ORIGIN,
	stateDir: process.env.STATE_DIR,
	minIntervalMs: Number(process.env.INTERVAL),
});
await p.gate(async () => { process.stdout.write(String(Date.now())); });
`;

function runChild(env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
			env: { ...process.env, PACING_URL, ...env },
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
			else resolve(Number(out));
		});
	});
}

test("two independent processes are serialized with the required spacing", async () => {
	const dir = stateDir();
	const env = {
		STATE_DIR: dir,
		ORIGIN,
		INTERVAL: "400",
		START_AT: String(Date.now() + 700),
	};
	const [a, b] = await Promise.all([runChild(env), runChild(env)]);
	const gap = Math.abs(a - b);
	assert.ok(gap >= 390, `request starts only ${gap}ms apart`);
	// The two did contend (started together), so the gap is pacing, not luck.
	assert.ok(gap < 400 + 1500, `unexpectedly large gap ${gap}ms`);
});

test("an independent process on another origin does not wait on a primed one", async () => {
	const dir = stateDir();
	const base = { STATE_DIR: dir, INTERVAL: "3000" };
	// Prime one origin: a second request to it would have to wait ~3s.
	await runChild({ ...base, ORIGIN: "https://one.test", START_AT: "0" });
	const startAt = Date.now() + 500;
	const [other, same] = await Promise.all([
		runChild({ ...base, ORIGIN: "https://two.test", START_AT: String(startAt) }),
		runChild({ ...base, ORIGIN: "https://one.test", START_AT: String(startAt) }),
	]);
	assert.ok(other - startAt < 1000, `other origin delayed ${other - startAt}ms`);
	assert.ok(same - startAt >= 1500, `same origin was not paced (${same - startAt}ms)`);
});

test("a lock orphaned by a SIGKILLed process does not strand the origin", async () => {
	const dir = stateDir();
	const p = createPacer({ origin: ORIGIN, stateDir: dir, minIntervalMs: 0, warn: () => {} });
	await p.gate(noop);
	// A child that takes the lock and then sits in a 60s wait holding it (the
	// request just made above is what it has to wait out).
	const holder = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { createPacer } = await import(${JSON.stringify(PACING_URL)});
			 const p = createPacer({ origin: ${JSON.stringify(ORIGIN)}, stateDir: ${JSON.stringify(dir)}, minIntervalMs: 60000 });
			 process.stdout.write("holding");
			 await p.gate(async () => {});`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise((resolve) => holder.stdout.once("data", resolve));
	// Give it a moment to actually take the lock.
	for (let i = 0; i < 100 && !existsSync(p.lockPath); i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(existsSync(p.lockPath), true, "holder never took the lock");
	holder.kill("SIGKILL");
	await new Promise((resolve) => holder.once("close", resolve));
	const q = createPacer({
		origin: ORIGIN,
		stateDir: dir,
		minIntervalMs: 0,
		lockTimeoutMs: 2000,
		warn: () => {},
	});
	assert.equal(await q.gate(noop), "sent");
});
