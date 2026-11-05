// Direct tests for src/state.mjs: the interprocess lock's stale-lock rules,
// atomic JSON writes, and origin canonicalisation.
//
// Every clock, sleep, liveness check, pid and host is injected, so nothing here
// waits on the wall clock or touches another process. Each test works in its
// own temporary directory, removed afterwards.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
	LockTimeoutError,
	createFileLock,
	originDigest,
	stateOrigin,
	writeJsonAtomic,
} from "../src/state.mjs";

const STALE_MS = 10_000;
const GRACE_MS = 5000; // UNREADABLE_LOCK_GRACE_MS (not exported)
const HOST = "this-host";

const roots = [];
function freshDir() {
	const d = mkdtempSync(path.join(tmpdir(), "trawl-state-test-"));
	roots.push(d);
	return d;
}
after(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// A fake clock whose sleep advances time instead of waiting.
function clock(start = 1_000_000) {
	const c = {
		t: start,
		now: () => c.t,
		sleep: async (ms) => {
			c.t += ms;
		},
	};
	return c;
}

function setup(overrides = {}) {
	const dir = freshDir();
	const c = clock();
	const lockPath = path.join(dir, "o.lock");
	const lock = createFileLock({
		lockPath,
		timeoutMs: 0,
		staleMs: STALE_MS,
		now: c.now,
		sleep: c.sleep,
		isAlive: () => true,
		pid: 4242,
		host: HOST,
		...overrides,
	});
	return { dir, c, lockPath, lock };
}

const writeOwner = (lockPath, owner) =>
	writeFileSync(lockPath, JSON.stringify(owner));
const owner = (over = {}) => ({
	token: "theirs",
	pid: 999,
	host: HOST,
	createdAt: 0,
	...over,
});
const readOwner = (lockPath) => JSON.parse(readFileSync(lockPath, "utf8"));
const leftovers = (dir) => readdirSync(dir).filter((f) => f !== "o.lock");

async function assertBusy(lock) {
	await assert.rejects(lock.acquire(), LockTimeoutError);
}

// --- basic acquire / release ---------------------------------------------

test("acquire writes an owner record and release removes it", async () => {
	const { c, lockPath, lock } = setup();
	const release = await lock.acquire();
	const o = readOwner(lockPath);
	assert.equal(o.pid, 4242);
	assert.equal(o.host, HOST);
	assert.equal(o.createdAt, c.t);
	assert.match(o.token, /^4242-[0-9a-f]{16}$/);
	release();
	assert.equal(existsSync(lockPath), false);
});

test("release leaves a lock that now belongs to someone else", async () => {
	const { lockPath, lock } = setup();
	const release = await lock.acquire();
	writeOwner(lockPath, owner({ token: "usurper", createdAt: 1_000_000 }));
	release();
	assert.equal(readOwner(lockPath).token, "usurper");
});

// --- stale-lock rules ----------------------------------------------------

test("another host's lock: only age decides, PID is ignored", async () => {
	const isAlive = () => {
		throw new Error("isAlive must not be consulted for another host");
	};
	const { c, lockPath, lock } = setup({ isAlive });
	// Fresh: kept, even though its PID would be "dead" here.
	writeOwner(lockPath, owner({ host: "elsewhere", createdAt: c.t }));
	await assertBusy(lock);
	assert.equal(readOwner(lockPath).token, "theirs");
	// Exactly staleMs old: still kept (strictly greater evicts).
	writeOwner(lockPath, owner({ host: "elsewhere", createdAt: c.t - STALE_MS }));
	await assertBusy(lock);
	// One ms older: evicted.
	writeOwner(
		lockPath,
		owner({ host: "elsewhere", createdAt: c.t - STALE_MS - 1 }),
	);
	const release = await lock.acquire();
	assert.equal(readOwner(lockPath).pid, 4242);
	release();
});

test("same host, dead PID: evicted regardless of age", async () => {
	const { c, lockPath, lock } = setup({ isAlive: () => false });
	writeOwner(lockPath, owner({ createdAt: c.t }));
	const release = await lock.acquire();
	assert.equal(readOwner(lockPath).pid, 4242);
	release();
	assert.deepEqual(leftovers(path.dirname(lockPath)), []);
});

test("same host, live PID: kept until older than staleMs (PID reuse)", async () => {
	const { c, lockPath, lock } = setup({ isAlive: () => true });
	writeOwner(lockPath, owner({ createdAt: c.t - STALE_MS }));
	await assertBusy(lock);
	assert.equal(readOwner(lockPath).token, "theirs");
	writeOwner(lockPath, owner({ createdAt: c.t - STALE_MS - 1 }));
	const release = await lock.acquire();
	assert.equal(readOwner(lockPath).pid, 4242);
	release();
});

test("clock skew: a createdAt too far in the future is evicted", async () => {
	const { c, lockPath, lock } = setup({ isAlive: () => true });
	// Exactly staleMs ahead: inside the bound, kept.
	writeOwner(lockPath, owner({ createdAt: c.t + STALE_MS }));
	await assertBusy(lock);
	assert.equal(readOwner(lockPath).token, "theirs");
	// One ms further: evicted.
	writeOwner(lockPath, owner({ createdAt: c.t + STALE_MS + 1 }));
	const release = await lock.acquire();
	assert.equal(readOwner(lockPath).pid, 4242);
	release();
});

test("clock skew applies to another host's lock too", async () => {
	const { c, lockPath, lock } = setup();
	writeOwner(
		lockPath,
		owner({ host: "elsewhere", createdAt: c.t + STALE_MS + 1 }),
	);
	const release = await lock.acquire();
	release();
});

// --- unreadable owner record ---------------------------------------------

for (const [label, content] of [
	["empty", ""],
	["not JSON", "{oops"],
	["wrong shape", JSON.stringify({ token: "x", pid: "1", host: HOST })],
]) {
	test(`unreadable owner record (${label}): kept for the grace period, then evicted`, async () => {
		const { c, lockPath, lock } = setup();
		writeFileSync(lockPath, content);
		const { mtimeMs } = statSync(lockPath);
		c.t = mtimeMs + GRACE_MS - 1;
		await assertBusy(lock);
		assert.equal(existsSync(lockPath), true);
		c.t = mtimeMs + GRACE_MS; // exactly the grace: still kept
		await assertBusy(lock);
		c.t = mtimeMs + GRACE_MS + 1;
		const release = await lock.acquire();
		assert.equal(readOwner(lockPath).pid, 4242);
		release();
		assert.deepEqual(leftovers(path.dirname(lockPath)), []);
	});
}

test("unreadable record's age comes from the file's mtime", async () => {
	const { c, lockPath, lock } = setup();
	writeFileSync(lockPath, "");
	const old = new Date(c.t - 60_000);
	utimesSync(lockPath, old, old);
	const release = await lock.acquire();
	release();
});

// --- the eviction race ---------------------------------------------------

test("evicting moves a fresh lock by mistake: it is restored, not lost", async () => {
	const { dir, c, lockPath } = setup();
	let calls = 0;
	const lock = createFileLock({
		lockPath,
		timeoutMs: 100,
		staleMs: STALE_MS,
		now: c.now,
		sleep: c.sleep,
		pid: 4242,
		host: HOST,
		// Called after the stale record was read and before it is renamed away.
		// Pretend its owner is dead, but swap in a fresh lock first.
		isAlive: () => {
			calls += 1;
			if (calls === 1) {
				writeOwner(
					lockPath,
					owner({ token: "fresh", pid: 777, createdAt: c.t }),
				);
				return false;
			}
			return true; // the fresh holder is alive
		},
	});
	writeOwner(lockPath, owner({ token: "stale", createdAt: c.t }));
	await assert.rejects(lock.acquire(), LockTimeoutError);
	assert.ok(calls >= 2, "acquisition retried after the restore");
	assert.equal(readOwner(lockPath).token, "fresh", "fresh lock was lost");
	assert.deepEqual(leftovers(dir), [], "tomb left behind");
});

test("a lock that vanishes mid-eviction is simply retried", async () => {
	const { c, lockPath } = setup();
	let calls = 0;
	const lock = createFileLock({
		lockPath,
		timeoutMs: 0,
		staleMs: STALE_MS,
		now: c.now,
		sleep: c.sleep,
		pid: 4242,
		host: HOST,
		isAlive: () => {
			calls += 1;
			rmSync(lockPath); // owner released it between read and rename
			return false;
		},
	});
	writeOwner(lockPath, owner({ createdAt: c.t }));
	const release = await lock.acquire();
	assert.equal(calls, 1);
	assert.equal(readOwner(lockPath).pid, 4242);
	release();
});

// --- timeout and I/O errors ----------------------------------------------

test("LockTimeoutError after timeoutMs, using only injected time", async () => {
	const { c, lockPath } = setup();
	const lock = createFileLock({
		lockPath,
		timeoutMs: 200,
		staleMs: STALE_MS,
		now: c.now,
		sleep: c.sleep,
		isAlive: () => true,
		pid: 4242,
		host: HOST,
	});
	writeOwner(lockPath, owner({ createdAt: c.t }));
	const started = c.t;
	await assert.rejects(lock.acquire(), (err) => {
		assert.ok(err instanceof LockTimeoutError);
		assert.equal(err.name, "LockTimeoutError");
		assert.equal(err.lockPath, lockPath);
		assert.equal(err.timeoutMs, 200);
		assert.match(err.message, /200ms/);
		return true;
	});
	assert.ok(c.t - started >= 200, "gave up before the budget");
	assert.equal(readOwner(lockPath).token, "theirs", "holder's lock removed");
});

test("a lock freed while waiting is acquired", async () => {
	const { c, lockPath } = setup();
	let sleeps = 0;
	const lock = createFileLock({
		lockPath,
		timeoutMs: 1000,
		staleMs: STALE_MS,
		now: c.now,
		sleep: async (ms) => {
			sleeps += 1;
			c.t += ms;
			if (sleeps === 2) rmSync(lockPath);
		},
		isAlive: () => true,
		pid: 4242,
		host: HOST,
	});
	writeOwner(lockPath, owner({ createdAt: c.t }));
	const release = await lock.acquire();
	assert.equal(sleeps, 2);
	release();
});

test("a missing lock directory rethrows ENOENT instead of waiting", async () => {
	const dir = freshDir();
	const lock = createFileLock({
		lockPath: path.join(dir, "no-such-dir", "o.lock"),
		timeoutMs: 1000,
		staleMs: STALE_MS,
		sleep: async () => assert.fail("must not sleep on an I/O error"),
	});
	await assert.rejects(lock.acquire(), { code: "ENOENT" });
});

test("a lock path under a regular file rethrows ENOTDIR", async () => {
	const dir = freshDir();
	const file = path.join(dir, "plain");
	writeFileSync(file, "");
	const lock = createFileLock({
		lockPath: path.join(file, "o.lock"),
		timeoutMs: 1000,
		staleMs: STALE_MS,
		sleep: async () => assert.fail("must not sleep on an I/O error"),
	});
	await assert.rejects(lock.acquire(), { code: "ENOTDIR" });
});

// --- writeJsonAtomic -----------------------------------------------------

test("writeJsonAtomic writes the JSON and leaves no temp file", () => {
	const dir = freshDir();
	const file = path.join(dir, "state.json");
	writeJsonAtomic(file, { a: 1 });
	writeJsonAtomic(file, { a: 2, b: [true] });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2, b: [true] });
	assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("writeJsonAtomic removes its temp file and rethrows on failure", () => {
	const dir = freshDir();
	const target = path.join(dir, "state.json");
	mkdirSync(target); // renaming a file over a directory fails
	assert.throws(() => writeJsonAtomic(target, { a: 1 }));
	assert.deepEqual(readdirSync(dir), ["state.json"]);
	assert.equal(statSync(target).isDirectory(), true);
});

test("writeJsonAtomic into a missing directory throws cleanly", () => {
	const dir = freshDir();
	assert.throws(
		() => writeJsonAtomic(path.join(dir, "nope", "state.json"), {}),
		{ code: "ENOENT" },
	);
	assert.deepEqual(readdirSync(dir), []);
});

// --- stateOrigin / originDigest ------------------------------------------

test("stateOrigin canonicalises case, default ports and paths", () => {
	assert.equal(stateOrigin("https://A.com:443/x?y#z"), "https://a.com");
	assert.equal(stateOrigin("https://a.com"), "https://a.com");
	assert.equal(stateOrigin("http://A.com:80/"), "http://a.com");
	assert.equal(stateOrigin("http://a.com:8080/p"), "http://a.com:8080");
	assert.equal(stateOrigin("https://a.com:80"), "https://a.com:80");
});

test("stateOrigin returns null for non-http(s) and unparseable input", () => {
	for (const u of [
		"file:///etc/passwd",
		"ftp://a.com/",
		"data:text/plain,hi",
		"about:blank",
		"not a url",
		"",
	]) {
		assert.equal(stateOrigin(u), null, u);
	}
});

test("originDigest is stable, 32 hex chars, and shared by equivalent origins", () => {
	const a = originDigest(stateOrigin("https://A.com:443/x"));
	const b = originDigest(stateOrigin("https://a.com"));
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, originDigest(stateOrigin("http://a.com")));
	assert.notEqual(a, originDigest(stateOrigin("https://a.com:8443")));
});

// --- hygiene -------------------------------------------------------------

test("no lock, tomb or temp files survive the suite's own temp dirs", () => {
	for (const d of roots) {
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) {
			// Dirs that deliberately keep a holder's lock or a fixture are fine;
			// what must never appear is a tomb or a temp file.
			assert.doesNotMatch(f, /\.stale-|\.tmp$/, `${d}/${f}`);
		}
	}
});
