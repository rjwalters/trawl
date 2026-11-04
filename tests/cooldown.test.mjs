// Per-origin cooldowns after 429/503 (src/cooldown.mjs) and their wiring into
// render(), the CLI and the MCP server.
//
// The policy is driven by an injected clock and a temporary state directory;
// the interprocess guarantees are checked with real, independent Node
// processes; the renderer integration uses loopback servers and counts the
// requests they receive. Nothing here reads or writes the real ~/.cache.

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutablePath } from "../src/browser.mjs";
import { parseArgs } from "../src/cli.mjs";
import {
	CooldownError,
	FALLBACK_CAP_MS,
	STREAK_RESET_MS,
	clearedRecord,
	createCooldownStore,
	fallbackDelayMs,
	formatDuration,
	nextFailureRecord,
	parseHttpDate,
	parseRecord,
	parseRetryAfter,
} from "../src/cooldown.mjs";
import { callTool } from "../src/mcp.mjs";
import { createPacer } from "../src/pacing.mjs";
import { CooldownError as ExportedCooldownError, render } from "../src/render.mjs";

// render() defaults to $TRAWL_STATE_DIR; never let it fall through to the
// user's real cache.
process.env.TRAWL_STATE_DIR = mkdtempSync(path.join(tmpdir(), "trawl-state-"));

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const browser = { skip: haveBrowser ? false : "no Chromium binary installed" };

const ORIGIN = "https://example.test";
const COOLDOWN_URL = new URL("../src/cooldown.mjs", import.meta.url).href;
const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const NO_BROWSER = { executablePath: path.join(tmpdir(), "trawl-no-such-chrome") };
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

const freshDir = () => mkdtempSync(path.join(tmpdir(), "trawl-cooldown-"));

function clock(start = T0) {
	const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
	return c;
}

function store(dir, c, extra = {}) {
	const warnings = [];
	const s = createCooldownStore({
		stateDir: dir,
		now: c.now,
		warn: (m) => warnings.push(m),
		...extra,
	});
	s.warnings = warnings;
	return s;
}

const readRecord = (s, origin = ORIGIN) =>
	parseRecord(readFileSync(s.statePathFor(origin), "utf8"));

// --- Retry-After ---

test("Retry-After delta-seconds, with surrounding whitespace", () => {
	assert.equal(parseRetryAfter("120", T0), 120_000);
	assert.equal(parseRetryAfter("  7\t", T0), 7000);
	assert.equal(parseRetryAfter("0", T0), 0);
	// Longer than the fallback cap is honoured as sent.
	assert.equal(parseRetryAfter("86400", T0), 86_400_000);
});

test("Retry-After HTTP-date in all three RFC 9110 forms", () => {
	const at = T0 + 90_000; // Tue, 03 Nov 2026 12:01:30 GMT
	assert.equal(parseRetryAfter("Tue, 03 Nov 2026 12:01:30 GMT", T0), 90_000);
	assert.equal(parseRetryAfter("Tuesday, 03-Nov-26 12:01:30 GMT", T0), 90_000);
	assert.equal(parseRetryAfter("Tue Nov  3 12:01:30 2026", T0), 90_000);
	assert.equal(parseHttpDate("Tue, 03 Nov 2026 12:01:30 GMT"), at);
});

test("Retry-After zero or a past date means no wait", () => {
	assert.equal(parseRetryAfter("Mon, 02 Nov 2026 12:00:00 GMT", T0), 0);
	assert.equal(parseRetryAfter("Tue, 03 Nov 2026 12:00:00 GMT", T0), 0);
});

test("malformed, negative and overflowing Retry-After values are unusable", () => {
	for (const bad of [
		undefined,
		"",
		"   ",
		"12junk",
		"-5",
		"+5",
		"1.5",
		"1e3",
		"0x10",
		"Infinity",
		"99999999999999999999",
		// Safe integer seconds, but past the largest representable Date.
		"9007199254740991",
		"Tue, 30 Feb 2026 12:00:00 GMT",
		"Tue, 03 Nov 2026 25:00:00 GMT",
		"Tue, 03 Nov 2026 12:00:00 UTC",
		"2026-11-03T12:01:30Z",
		"tomorrow",
	]) {
		assert.equal(parseRetryAfter(bad, T0), null, `accepted ${JSON.stringify(bad)}`);
	}
});

// --- backoff policy ---

test("fallback is 60s doubling per failure, capped at 1h, without overflow", () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 7, 8].map(fallbackDelayMs),
		[60, 120, 240, 480, 960, 1920, 3600, 3600].map((s) => s * 1000),
	);
	assert.equal(fallbackDelayMs(1e9), FALLBACK_CAP_MS);
	assert.equal(fallbackDelayMs(Number.MAX_SAFE_INTEGER), FALLBACK_CAP_MS);
});

test("429 and 503 share a streak, Retry-After or not, and it survives expiry", () => {
	let r = nextFailureRecord(null, { now: T0, status: 503 });
	assert.deepEqual(r, { until: T0 + 60_000, failures: 1, lastFailureAt: T0, generation: 1, status: 503 });
	// A valid Retry-After sets the expiry but still counts toward the streak.
	r = nextFailureRecord(r, { now: T0 + 70_000, status: 429, retryAfter: "5" });
	assert.equal(r.failures, 2);
	assert.equal(r.until, T0 + 75_000);
	assert.equal(r.status, 429);
	// Past that expiry, the next fallback is the third step: 4 minutes.
	r = nextFailureRecord(r, { now: T0 + 100_000, status: 503, retryAfter: "junk" });
	assert.equal(r.failures, 3);
	assert.equal(r.until, T0 + 100_000 + 240_000);
	assert.equal(r.generation, 3);
});

test("a streak with no failure for 24h starts over", () => {
	let r = { until: T0 + 3_600_000, failures: 7, lastFailureAt: T0, generation: 7, status: 503 };
	const later = T0 + STREAK_RESET_MS;
	r = nextFailureRecord(r, { now: later, status: 503 });
	assert.equal(r.failures, 1);
	assert.equal(r.until, later + 60_000);
	// The generation keeps counting, so older readers can still tell.
	assert.equal(r.generation, 8);
});

test("an update never shortens a later expiry", () => {
	const prev = { until: T0 + 7_200_000, failures: 1, lastFailureAt: T0, generation: 1, status: 429 };
	const r = nextFailureRecord(prev, { now: T0 + 1000, status: 503, retryAfter: "1" });
	assert.equal(r.until, T0 + 7_200_000);
});

test("a cleared record resets the streak but advances the generation", () => {
	assert.deepEqual(clearedRecord({ generation: 4 }), {
		until: 0,
		failures: 0,
		lastFailureAt: null,
		generation: 5,
		status: null,
	});
});

test("stored records are validated field by field", () => {
	const good = { version: 1, until: T0, failures: 1, lastFailureAt: T0, generation: 1, status: 503 };
	assert.deepEqual(parseRecord(JSON.stringify(good)), {
		until: T0,
		failures: 1,
		lastFailureAt: T0,
		generation: 1,
		status: 503,
	});
	for (const [label, bad] of [
		["not JSON", "{"],
		["null", "null"],
		["an array", "[]"],
		["no version", JSON.stringify({ ...good, version: undefined })],
		["a future version", JSON.stringify({ ...good, version: 2 })],
		["string until", JSON.stringify({ ...good, until: String(T0) })],
		["negative until", JSON.stringify({ ...good, until: -1 })],
		["huge until", JSON.stringify({ ...good, until: 1e300 })],
		["fractional failures", JSON.stringify({ ...good, failures: 1.5 })],
		["negative failures", JSON.stringify({ ...good, failures: -1 })],
		["bad lastFailureAt", JSON.stringify({ ...good, lastFailureAt: "x" })],
		["zero generation", JSON.stringify({ ...good, generation: 0 })],
		["other status", JSON.stringify({ ...good, status: 500 })],
	]) {
		assert.equal(parseRecord(bad), null, label);
	}
});

test("formatDuration rounds up and drops empty units", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(1), "1s");
	assert.equal(formatDuration(59_001), "1m");
	assert.equal(formatDuration(3_723_000), "1h 2m 3s");
	assert.equal(formatDuration(3_600_000), "1h");
});

// --- the store ---

test("a recorded cooldown refuses later readers until it expires", async () => {
	const dir = freshDir();
	const c = clock();
	const a = store(dir, c);
	a.recordFailure(ORIGIN, { status: 503, retryAfter: "120" });
	await a.flush();

	// A separate store (a later run) sees it on disk.
	const b = store(dir, c);
	c.advance(30_000);
	assert.throws(
		() => b.check(ORIGIN),
		(err) => {
			assert.ok(err instanceof CooldownError);
			assert.equal(err.code, "TRAWL_COOLDOWN");
			assert.equal(err.origin, ORIGIN);
			assert.equal(err.until, T0 + 120_000);
			assert.equal(err.remainingMs, 90_000);
			assert.equal(err.status, 503);
			assert.match(err.message, /^https:\/\/example\.test is cooling down after HTTP 503 until 2026-11-03T12:02:00\.000Z \(1m 30s from now\)/);
			assert.match(err.message, /--ignore-cooldown/);
			return true;
		},
	);
	// Another origin is unaffected.
	b.check("https://other.test");
	c.advance(90_000);
	b.check(ORIGIN);
	assert.deepEqual(a.warnings.concat(b.warnings), []);
});

test("a zero Retry-After records the failure without a wait", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	s.recordFailure(ORIGIN, { status: 429, retryAfter: "0" });
	await s.flush();
	s.check(ORIGIN);
	assert.equal(readRecord(s).failures, 1);
});

test("the streak is kept on disk after expiry, and a 2xx clears it", async () => {
	const dir = freshDir();
	const c = clock();
	let s = store(dir, c);
	s.recordFailure(ORIGIN, { status: 503 });
	await s.flush();
	c.advance(61_000);

	s = store(dir, c);
	s.check(ORIGIN);
	s.recordFailure(ORIGIN, { status: 503 });
	await s.flush();
	assert.equal(readRecord(s).failures, 2);
	assert.equal(readRecord(s).until, c.t + 120_000);
	c.advance(121_000);

	s = store(dir, c);
	s.check(ORIGIN);
	s.recordSuccess(ORIGIN);
	await s.flush();
	assert.deepEqual(readRecord(s), clearedRecord({ generation: 2 }));

	s = store(dir, c);
	s.read(ORIGIN);
	s.recordFailure(ORIGIN, { status: 503 });
	await s.flush();
	assert.equal(readRecord(s).failures, 1);
	assert.equal(readRecord(s).until, c.t + 60_000);
});

test("a 2xx with nothing on record writes nothing", async () => {
	const dir = freshDir();
	const s = store(dir, clock());
	s.read(ORIGIN);
	s.recordSuccess(ORIGIN);
	await s.flush();
	assert.deepEqual(readdirSync(dir), []);
});

test("an older success does not erase a newer failure", async () => {
	const dir = freshDir();
	const c = clock();
	const older = store(dir, c);
	older.read(ORIGIN); // admitted with no record (generation 0)
	const newer = store(dir, c);
	newer.recordFailure(ORIGIN, { status: 429, retryAfter: "60" });
	await newer.flush();
	older.recordSuccess(ORIGIN);
	await older.flush();
	assert.equal(readRecord(newer).failures, 1);
	assert.equal(readRecord(newer).until, T0 + 60_000);

	// Same with an existing record: admitted against generation 1, a newer
	// failure makes it 2, and the older success must leave it alone.
	const older2 = store(dir, c);
	older2.read(ORIGIN);
	newer.recordFailure(ORIGIN, { status: 503, retryAfter: "60" });
	await newer.flush();
	older2.recordSuccess(ORIGIN);
	await older2.flush();
	assert.equal(readRecord(newer).failures, 2);
	assert.equal(readRecord(newer).generation, 2);
});

test("a run's own success clears its own earlier failure", async () => {
	const dir = freshDir();
	const s = store(dir, clock());
	s.read(ORIGIN);
	s.recordFailure(ORIGIN, { status: 503 });
	s.recordSuccess(ORIGIN);
	await s.flush();
	assert.equal(readRecord(s).failures, 0);
	s.check(ORIGIN);
});

test("missing and corrupt state mean no cooldown, silently", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	s.check(ORIGIN);
	mkdirSync(path.dirname(s.statePathFor(ORIGIN)), { recursive: true });
	for (const junk of ["", "{", '{"version":1,"until":"soon"}', "\u0000\u0000"]) {
		writeFileSync(s.statePathFor(ORIGIN), junk);
		store(dir, c).check(ORIGIN);
	}
	// A failure over a corrupt file starts a fresh record.
	const t = store(dir, c);
	t.recordFailure(ORIGIN, { status: 503 });
	await t.flush();
	assert.equal(readRecord(t).failures, 1);
	assert.deepEqual(s.warnings.concat(t.warnings), []);
});

test("an unwritable state dir warns once and keeps the cooldown in memory", async () => {
	const parent = freshDir();
	const dir = path.join(parent, "occupied");
	writeFileSync(dir, "a file, not a directory");
	const c = clock();
	const s = store(dir, c);
	s.check(ORIGIN); // reading through a file is just "nothing there"
	assert.deepEqual(s.warnings, []);
	s.recordFailure(ORIGIN, { status: 503, retryAfter: "30" });
	await s.flush();
	assert.throws(() => s.check(ORIGIN), CooldownError);
	s.recordFailure(ORIGIN, { status: 503 });
	await s.flush();
	assert.equal(s.warnings.length, 1);
	assert.match(s.warnings[0], /cooldown state directory .* is unusable \(E\w+\)/);
	assert.equal(s.degraded, true);
});

test("an unreadable record warns, and a cooldown already read stays enforced", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c);
	// The record path is a directory: reading it is EISDIR, not "absent".
	mkdirSync(s.statePathFor(ORIGIN), { recursive: true });
	s.check(ORIGIN);
	assert.equal(s.warnings.length, 1);

	const ok = freshDir();
	const seed = store(ok, c);
	seed.recordFailure(ORIGIN, { status: 429, retryAfter: "600" });
	await seed.flush();
	const t = store(ok, c);
	assert.throws(() => t.check(ORIGIN), CooldownError);
	// The directory goes away under us; what was already read still holds.
	rmSync(ok, { recursive: true, force: true });
	writeFileSync(ok, "now a file");
	t.recordFailure("https://elsewhere.test", { status: 503 });
	await t.flush();
	assert.equal(t.degraded, true);
	assert.throws(() => t.check(ORIGIN), CooldownError);
});

test("a busy lock is bounded: warn, keep the cooldown in memory", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c, {
		lockTimeoutMs: 200,
		sleep: async (ms) => c.advance(ms),
	});
	mkdirSync(s.dir, { recursive: true });
	const lockPath = s.statePathFor(ORIGIN).replace(/\.json$/, ".lock");
	// Held by a live process on this host (us), freshly.
	writeFileSync(
		lockPath,
		JSON.stringify({ token: "other", pid: process.pid, host: hostname(), createdAt: c.t }),
	);
	s.recordFailure(ORIGIN, { status: 503, retryAfter: "60" });
	await s.flush();
	assert.equal(s.warnings.length, 1);
	assert.match(s.warnings[0], /lock stayed busy for 200ms/);
	assert.throws(() => s.check(ORIGIN), CooldownError);
	assert.equal(existsSync(s.statePathFor(ORIGIN)), false);
	assert.equal(existsSync(lockPath), true, "someone else's lock was removed");
});

test("a lock left by a dead process is recovered", async () => {
	const dir = freshDir();
	const c = clock();
	const s = store(dir, c, { lockTimeoutMs: 200, sleep: async (ms) => c.advance(ms) });
	mkdirSync(s.dir, { recursive: true });
	const { pid: deadPid } = spawnSync(process.execPath, ["-e", ""]);
	const lockPath = s.statePathFor(ORIGIN).replace(/\.json$/, ".lock");
	writeFileSync(
		lockPath,
		JSON.stringify({ token: "gone", pid: deadPid, host: hostname(), createdAt: c.t }),
	);
	s.recordFailure(ORIGIN, { status: 503 });
	await s.flush();
	assert.deepEqual(s.warnings, []);
	assert.equal(readRecord(s).failures, 1);
	assert.equal(existsSync(lockPath), false);
});

test("non-http(s) origins are ignored", async () => {
	const dir = freshDir();
	const s = store(dir, clock());
	s.check(null);
	s.recordFailure(null, { status: 503 });
	await s.flush();
	assert.deepEqual(readdirSync(dir), []);
});

// --- independent processes sharing one state dir ---

// Waits for a shared instant (so the children really contend), then records
// one failure.
const CHILD = `
const { createCooldownStore } = await import(process.env.COOLDOWN_URL);
const at = Number(process.env.START_AT);
while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
const s = createCooldownStore({ stateDir: process.env.STATE_DIR });
s.recordFailure(process.env.ORIGIN, {
	status: Number(process.env.STATUS),
	retryAfter: process.env.RETRY_AFTER,
});
await s.flush();
if (s.degraded) process.exit(9);
`;

function runChild(env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
			env: { ...process.env, COOLDOWN_URL, ORIGIN, STATUS: "503", ...env },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let err = "";
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
			else resolve();
		});
	});
}

test("concurrent processes serialize their updates and keep the longest expiry", async () => {
	const dir = freshDir();
	const startAt = String(Date.now() + 600);
	const delays = ["3600", "5", "60", "10", "1800", "1"];
	const before = Date.now();
	await Promise.all(
		delays.map((d) => runChild({ STATE_DIR: dir, START_AT: startAt, RETRY_AFTER: d })),
	);
	const s = createCooldownStore({ stateDir: dir, warn: () => {} });
	const raw = readFileSync(s.statePathFor(ORIGIN), "utf8");
	const record = parseRecord(raw);
	assert.ok(record, `unparseable state: ${raw}`);
	// Every update landed (no lost read-modify-write) ...
	assert.equal(record.failures, delays.length);
	assert.equal(record.generation, delays.length);
	// ... and the hour-long one survived the shorter ones written after it.
	assert.ok(record.until >= before + 3_600_000, `expiry shortened to ${record.until}`);
	assert.ok(record.until <= Date.now() + 3_600_000);
	// No temp or lock files left behind.
	assert.deepEqual(readdirSync(s.dir), [path.basename(s.statePathFor(ORIGIN))]);
});

test("a success in this process does not erase a failure another process recorded meanwhile", async () => {
	const dir = freshDir();
	const here = createCooldownStore({ stateDir: dir, warn: () => {} });
	here.read(ORIGIN); // admitted: nothing on record
	await runChild({ STATE_DIR: dir, START_AT: "0", RETRY_AFTER: "600" });
	here.recordSuccess(ORIGIN);
	await here.flush();
	const record = readRecord(here);
	assert.equal(record.failures, 1);
	assert.ok(record.until > Date.now() + 500_000);
	assert.throws(() => createCooldownStore({ stateDir: dir }).check(ORIGIN), CooldownError);
});

// --- render() admission, without a browser ---

async function seed(stateDir, origin, { status = 503, retryAfter = "600" } = {}) {
	const s = createCooldownStore({ stateDir, warn: () => {} });
	s.recordFailure(origin, { status, retryAfter });
	await s.flush();
	return s;
}

// A loopback server whose responses are set per path, counting every hit.
async function serve(routes) {
	const hits = [];
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url, "http://127.0.0.1");
		hits.push(pathname);
		const route = routes[pathname];
		if (route === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (typeof route === "function") return route(req, res);
		res.writeHead(200, {
			"content-type": pathname.endsWith(".txt") ? "text/plain" : "text/html",
		});
		res.end(route);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		hits,
		count: (p) => hits.filter((h) => h === p).length,
		close: () => {
			server.closeAllConnections?.();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}

const ROBOTS = "User-agent: *\nAllow: /\n";

const respond = (status, headers = {}, body = `<!doctype html><title>${status}</title><h1>Status ${status} page with enough ordinary words in it.</h1>`) =>
	(_req, res) => {
		res.writeHead(status, { "content-type": "text/html", ...headers });
		res.end(body);
	};

test("render() re-exports CooldownError", () => {
	assert.equal(ExportedCooldownError, CooldownError);
});

test("a cooling-down origin is refused before robots.txt or browser resolution", async () => {
	const stateDir = freshDir();
	const origin = "http://127.0.0.1:9";
	await seed(stateDir, origin);
	for (const extra of [{}, { ignoreRobots: true }, { pacing: false }]) {
		let fetched = 0;
		await assert.rejects(
			() =>
				render(`${origin}/page`, {
					...NO_BROWSER,
					...extra,
					stateDir,
					fetch: async () => {
						fetched++;
						return new Response(ROBOTS);
					},
				}),
			(err) => err instanceof CooldownError && err.origin === origin,
		);
		assert.equal(fetched, 0, `fetched robots.txt with ${JSON.stringify(extra)}`);
	}
	// Pacing recorded nothing either: refused requests are not attempts.
	assert.equal(existsSync(path.join(stateDir, "pacing")), false);
});

test("ignoreCooldown gets past admission; other origins are unaffected", async () => {
	const stateDir = freshDir();
	await seed(stateDir, "http://127.0.0.1:9");
	const fetch = async () => new Response(ROBOTS);
	await assert.rejects(
		() => render("http://127.0.0.1:9/page", { ...NO_BROWSER, stateDir, fetch, ignoreCooldown: true }),
		/Chromium binary not found/,
	);
	// Same host, different port: a different origin.
	await assert.rejects(
		() => render("http://127.0.0.1:10/page", { ...NO_BROWSER, stateDir, fetch }),
		/Chromium binary not found/,
	);
	// The override deleted nothing.
	await assert.rejects(
		() => render("http://127.0.0.1:9/page", { ...NO_BROWSER, stateDir, fetch }),
		CooldownError,
	);
});

test("a non-http(s) URL never touches the cooldown state", async () => {
	const stateDir = freshDir();
	const file = path.join(freshDir(), "page.html");
	writeFileSync(file, "<h1>x</h1>");
	await assert.rejects(
		() => render(pathToFileURL(file).href, { ...NO_BROWSER, stateDir }),
		/Chromium binary not found/,
	);
	assert.deepEqual(readdirSync(stateDir), []);
});

test("a 503 robots.txt is a robots refusal, never a cooldown", async () => {
	const stateDir = freshDir();
	const s = await serve({ "/robots.txt": respond(503, { "retry-after": "600" }, "busy") });
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, { ...NO_BROWSER, stateDir }),
			/robots\.txt is unreachable/,
		);
	} finally {
		await s.close();
	}
	assert.equal(existsSync(path.join(stateDir, "cooldown")), false);
});

test("a cooldown recorded during the pacing wait refuses the paced request", async () => {
	const stateDir = freshDir();
	const origin = "http://127.0.0.1:9";
	// Prime pacing so the next request to this origin waits ~1.5s.
	await createPacer({ origin, stateDir, minIntervalMs: 0 }).gate(async () => {});
	const pacingFile = readdirSync(path.join(stateDir, "pacing")).find((f) => f.endsWith(".json"));
	const pacedBefore = readFileSync(path.join(stateDir, "pacing", pacingFile), "utf8");
	let fetched = 0;
	const rendering = render(`${origin}/page`, {
		...NO_BROWSER,
		stateDir,
		minIntervalMs: 1500,
		fetch: async () => {
			fetched++;
			return new Response(ROBOTS);
		},
	});
	await new Promise((r) => setTimeout(r, 300));
	await seed(stateDir, origin);
	await assert.rejects(rendering, CooldownError);
	assert.equal(fetched, 0);
	// The refused request was not recorded as a pacing attempt.
	assert.equal(readFileSync(path.join(stateDir, "pacing", pacingFile), "utf8"), pacedBefore);
});

test("MCP reports a cooldown refusal as a tool error", async () => {
	const origin = "http://127.0.0.1:9";
	await seed(process.env.TRAWL_STATE_DIR, origin);
	const result = await callTool("fetch_page", { url: `${origin}/page` }, { env: {} });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /^trawl: http:\/\/127\.0\.0\.1:9 is cooling down/);
});

test("--ignore-cooldown parses as a boolean flag", () => {
	assert.equal(parseArgs(["https://x.test", "--ignore-cooldown"])["--ignore-cooldown"], true);
	assert.throws(() => parseArgs(["--ignore-cooldown=1"]), /Unknown option/);
});

// --- render() against a real browser ---

for (const status of [503, 429]) {
	test(`a main-frame ${status} is returned, recorded, and refuses the next run`, browser, async () => {
		const stateDir = freshDir();
		let pageResponse = respond(status, { "retry-after": "120" });
		const s = await serve({
			"/robots.txt": ROBOTS,
			"/page": (req, res) => pageResponse(req, res),
		});
		const run = (extra = {}) => render(`${s.origin}/page`, { stateDir, minIntervalMs: 0, ...extra });
		try {
			const first = await run();
			assert.equal(first.status, status);
			assert.match(first.body, new RegExp(`Status ${status}`));
			const rec = parseRecord(
				readFileSync(createCooldownStore({ stateDir }).statePathFor(s.origin), "utf8"),
			);
			assert.equal(rec.failures, 1);
			assert.equal(rec.status, status);
			assert.ok(rec.until > Date.now() + 100_000);

			const hits = s.hits.length;
			await assert.rejects(() => run(), (err) => err instanceof CooldownError && err.origin === s.origin);
			await assert.rejects(() => run({ ignoreRobots: true }), CooldownError);
			assert.equal(s.hits.length, hits, "a refused run still made requests");

			// The override reaches the page, and records the new failure.
			const forced = await run({ ignoreCooldown: true });
			assert.equal(forced.status, status);
			assert.equal(s.count("/page"), 2);
			const rec2 = parseRecord(
				readFileSync(createCooldownStore({ stateDir }).statePathFor(s.origin), "utf8"),
			);
			assert.equal(rec2.failures, 2);

			// A 2xx (reached with the override) resets the streak and the refusal.
			pageResponse = respond(200);
			assert.equal((await run({ ignoreCooldown: true })).status, 200);
			const rec3 = parseRecord(
				readFileSync(createCooldownStore({ stateDir }).statePathFor(s.origin), "utf8"),
			);
			assert.equal(rec3.failures, 0);
			assert.equal((await run()).status, 200);
		} finally {
			await s.close();
		}
	});
}

test("a 503 whose networkidle times out is recorded and not retried; the HAR is still written", browser, async () => {
	const stateDir = freshDir();
	const har = path.join(freshDir(), "trace.har");
	const s = await serve({
		"/robots.txt": ROBOTS,
		"/page": respond(503, { "retry-after": "120" }, '<!doctype html><title>busy</title><p>Service busy, try later please.</p><img src="/hang">'),
		"/hang": () => {}, // never answers: networkidle never fires
	});
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, { stateDir, minIntervalMs: 0, timeout: 1500, har }),
			(err) => {
				assert.ok(err instanceof CooldownError, err.stack);
				assert.match(err.message, /networkidle-fallback retry was not sent/);
				return true;
			},
		);
	} finally {
		await s.close();
	}
	assert.equal(s.count("/page"), 1, "the fallback retry went out anyway");
	const rec = parseRecord(readFileSync(createCooldownStore({ stateDir }).statePathFor(s.origin), "utf8"));
	assert.equal(rec.failures, 1);
	assert.ok(JSON.parse(readFileSync(har, "utf8")).log.entries.length >= 1);
});

test("a 200 page with a 503 subresource and an iframe 503 keeps the normal fallback and records nothing", browser, async () => {
	const stateDir = freshDir();
	const s = await serve({
		"/robots.txt": ROBOTS,
		"/page": '<!doctype html><title>ok</title><h1>Fine page with plenty of words in it.</h1><img src="/busy.png"><iframe src="/frame"></iframe><img src="/hang">',
		"/busy.png": respond(503, { "retry-after": "600" }),
		"/frame": respond(503, { "retry-after": "600" }),
		"/hang": () => {},
	});
	try {
		const result = await render(`${s.origin}/page`, { stateDir, minIntervalMs: 0, timeout: 1500 });
		assert.equal(result.status, 200);
		assert.deepEqual(result.waitUntilFallback, { from: "networkidle", to: "domcontentloaded" });
		assert.equal(s.count("/page"), 2);
		assert.ok(s.count("/frame") >= 1);
	} finally {
		await s.close();
	}
	assert.equal(existsSync(path.join(stateDir, "cooldown")), false);
});

test("a redirect that ends in a 429 is recorded against the origin that sent it", browser, async () => {
	const stateDir = freshDir();
	const target = await serve({ "/robots.txt": ROBOTS, "/landing": respond(429, { "retry-after": "300" }) });
	const start = await serve({
		"/robots.txt": ROBOTS,
		"/page": (_req, res) => {
			res.writeHead(302, { location: `${target.origin}/landing` });
			res.end();
		},
	});
	try {
		const result = await render(`${start.origin}/page`, { stateDir, minIntervalMs: 0 });
		assert.equal(result.status, 429);
	} finally {
		await start.close();
		await target.close();
	}
	const s = createCooldownStore({ stateDir });
	assert.throws(() => s.check(target.origin), CooldownError);
	s.check(start.origin);
});

test("an auth wall after an observed 429 still leaves the cooldown behind", browser, async () => {
	const stateDir = freshDir();
	const s = await serve({
		"/robots.txt": ROBOTS,
		"/page": respond(429, { "retry-after": "60" }, "<!doctype html><p>Please sign in</p>"),
	});
	try {
		await assert.rejects(() => render(`${s.origin}/page`, { stateDir, minIntervalMs: 0 }), {
			name: "AuthWallError",
		});
	} finally {
		await s.close();
	}
	assert.throws(() => createCooldownStore({ stateDir }).check(s.origin), CooldownError);
});

test("click steps still work, and their navigation guard still fails the run", browser, async () => {
	const stateDir = freshDir();
	const s = await serve({
		"/robots.txt": ROBOTS,
		"/page":
			'<!doctype html><title>c</title><button id="b" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p id=r>Revealed text for the test.</p>\')">go</button><a id="away" href="/other">away</a>',
		"/other": respond(503, { "retry-after": "600" }),
	});
	try {
		const ok = await render(`${s.origin}/page`, { stateDir, minIntervalMs: 0, click: [{ selector: "#b", waitFor: "#r" }], selector: "#r" });
		assert.match(ok.body, /Revealed text/);
		await assert.rejects(
			() => render(`${s.origin}/page`, { stateDir, minIntervalMs: 0, click: "#away" }),
			{ name: "ClickError" },
		);
	} finally {
		await s.close();
	}
	assert.equal(s.count("/other"), 0);
	createCooldownStore({ stateDir }).check(s.origin);
});

// --- the CLI, through a bin symlink as a PATH lookup runs it ---

function runBin(link, args, env) {
	return new Promise((resolve) => {
		execFile(link, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("the CLI exits 22 on a 503, then 4 with empty stdout until --ignore-cooldown", browser, async () => {
	const TRAWL_STATE_DIR = freshDir();
	const binDir = freshDir();
	const link = path.join(binDir, "trawl");
	symlinkSync(CLI_PATH, link);
	const s = await serve({ "/robots.txt": ROBOTS, "/page": respond(503, { "retry-after": "90" }) });
	try {
		const url = `${s.origin}/page`;
		const env = { TRAWL_STATE_DIR };
		const first = await runBin(link, [url, "--min-interval", "0"], env);
		assert.equal(first.code, 22, first.stderr);
		assert.match(first.stdout, /Status 503/);

		const hits = s.hits.length;
		const refused = await runBin(link, [url, "--min-interval", "0"], env);
		assert.equal(refused.code, 4, refused.stderr);
		assert.equal(refused.stdout, "");
		assert.match(
			refused.stderr,
			new RegExp(`^trawl: ${s.origin.replace(/[.]/g, "\\.")} is cooling down after HTTP 503 until \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z \\((1m )?\\d+s from now\\)\\. .*--ignore-cooldown`),
		);
		assert.equal(s.hits.length, hits);

		const forced = await runBin(link, [url, "--min-interval", "0", "--ignore-cooldown"], env);
		assert.equal(forced.code, 22, forced.stderr);
		assert.equal(s.count("/page"), 2);
	} finally {
		await s.close();
		rmSync(binDir, { recursive: true, force: true });
	}
});
