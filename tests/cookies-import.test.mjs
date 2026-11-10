// `trawl cookies import` (#77). The browser lifecycle is injected through
// `deps`, like runLogin's tests, so everything but the last test runs without
// Chromium. The last one imports for real and fetches through --profile.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveExecutablePath } from "../src/browser.mjs";
import { browserWouldReject } from "../src/cookies.mjs";
import {
	browserFamily,
	main,
	parseCookiesImportArgs,
	runCookies,
	runCookiesImport,
} from "../src/cli.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const browserOpts = { skip: haveBrowser ? false : "no Chromium binary installed" };

process.env.TRAWL_STATE_DIR = mkdtempSync(join(tmpdir(), "trawl-state-"));

const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const SENTINEL = "SENTINEL-c00k1e-v4lue-9f3e";
const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86400;
const NOW_MS = Date.now();
const NOW_S = Math.floor(NOW_MS / 1000);

function tempDir() {
	return mkdtempSync(join(tmpdir(), "trawl-cookies-"));
}

function writeSource(dir, name, text) {
	const file = join(dir, name);
	writeFileSync(file, text);
	return file;
}

function netscape(lines) {
	return `# Netscape HTTP Cookie File\n${lines.map((l) => l.join("\t")).join("\n")}\n`;
}

const TXT = netscape([
	[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", SENTINEL],
	[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "SID", `${SENTINEL}-auth`],
	[".example.com", "TRUE", "/", "FALSE", "1000", "old", `${SENTINEL}-old`],
	[".other.org", "TRUE", "/", "FALSE", "0", "theme", `${SENTINEL}-other`],
]);

const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function har(ua) {
	return JSON.stringify({
		log: {
			entries: [
				{
					startedDateTime: new Date().toISOString(),
					request: {
						url: "https://app.example.com/home",
						headers: [
							...(ua ? [{ name: "User-Agent", value: ua }] : []),
							{ name: "Cookie", value: `lang=${SENTINEL}` },
						],
					},
					response: { headers: [] },
				},
			],
		},
	});
}

const CURL = `curl 'https://shop.example.com/cart' -A 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' -H 'Cookie: cart=${SENTINEL}; sessionid=${SENTINEL}-s'`;

function fakeDeps({ profileDir, env = {}, addCookies, existing = false } = {}) {
	const calls = { launch: [], mkdir: [], chmod: [], added: null };
	const out = { stdout: [], stderr: [] };
	const context = {
		closed: false,
		addCookies: async (cookies) => {
			calls.added = cookies;
			if (addCookies) await addCookies(cookies);
		},
		close: async () => {
			context.closed = true;
		},
	};
	const deps = {
		env,
		stdout: (s) => out.stdout.push(s),
		stderr: (s) => out.stderr.push(s),
		resolveExecutablePath: () => "/fake/chrome",
		existsSync: (p) => existing || p !== profileDir,
		mkdirSync: (...a) => calls.mkdir.push(a),
		chmodSync: (...a) => calls.chmod.push(a),
		launchPersistentContext: async (dir, options) => {
			calls.launch.push([dir, options]);
			return context;
		},
	};
	return {
		deps,
		calls,
		context,
		text: () => ({ stdout: out.stdout.join(""), stderr: out.stderr.join("") }),
	};
}

// --- argument parsing ---

test("parses the import flags, including --flag=value", () => {
	assert.deepEqual(
		parseCookiesImportArgs(["f.txt", "--profile", "p", "--domain=example.com", "--allow", "a,b", "--include-auth"]),
		{ _: ["f.txt"], "--profile": "p", "--domain": "example.com", "--allow": "a,b", "--include-auth": true },
	);
});

test("rejects options that belong to a fetch, and valued flags with no value", () => {
	assert.throws(() => parseCookiesImportArgs(["f", "--format", "text"]), /Unknown option for trawl cookies import: --format/);
	assert.throws(() => parseCookiesImportArgs(["f", "--allow"]), /--allow requires a value/);
	assert.throws(() => parseCookiesImportArgs(["f", "--include-auth=yes"]), /Unknown option/);
});

test("the new flags stay unknown to a plain fetch (purely additive)", async () => {
	await assert.rejects(() => main(["https://example.com", "--domain", "x"]), /Unknown option: --domain/);
	await assert.rejects(() => main(["https://example.com", "--include-auth"]), /Unknown option: --include-auth/);
});

test("main() dispatches `trawl cookies import`", async () => {
	await assert.rejects(() => main(["cookies", "import"]), /trawl cookies import requires a file/);
	await assert.rejects(() => main(["cookies"]), /requires a subcommand/);
	await assert.rejects(() => main(["cookies", "export"]), /Unknown cookies subcommand: export/);
});

// --- the addCookies payload, per source format ---

test("imports a cookies.txt: the payload is the filtered list", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	const { deps, calls, context, text } = fakeDeps({ profileDir: "/p" });
	deps.now = NOW_MS;
	try {
		const code = await runCookiesImport([file, "--profile", "/p"], deps);
		assert.equal(code, 0);
		assert.deepEqual(calls.added, [
			{ name: "pref", value: SENTINEL, domain: ".example.com", path: "/", expires: FUTURE, httpOnly: false, secure: true },
			// A session cookie is given a 7-day expiry, or the profile would drop it.
			{ name: "theme", value: `${SENTINEL}-other`, domain: ".other.org", path: "/", expires: NOW_S + 7 * 86400, httpOnly: false, secure: false },
		]);
		assert.deepEqual(calls.launch, [["/p", { executablePath: "/fake/chrome", headless: true }]]);
		assert.equal(context.closed, true);
		const { stdout, stderr } = text();
		assert.match(stdout, /Imported 2 cookies into \/p:/);
		assert.match(stdout, /pref\t\.example\.com\t\d{4}-\d\d-\d\dT/);
		assert.match(stdout, /theme\t\.other\.org\tsession, kept until \d{4}-\d\d-\d\dT/);
		assert.match(stdout, /1 session cookie stored with a 7-day expiry/);
		assert.match(stdout, /Dropped 1 sign-in cookie \(SID\); pass --include-auth/);
		assert.match(stdout, /Dropped 1 expired cookie\./);
		assert.match(stderr, /still contains every cookie, including sign-in cookies\. Delete it/);
		// No User-Agent in a cookies.txt, so no warning.
		assert.doesNotMatch(stderr, /warning/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("imports a HAR and warns when it came from a different browser", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "trace.har", har(CHROME_UA));
	const { deps, calls, text } = fakeDeps({ profileDir: "/p" });
	try {
		assert.equal(await runCookiesImport([file, "--profile", "/p"], deps), 0);
		assert.deepEqual(calls.added.map((c) => [c.name, c.domain, c.value]), [["lang", "app.example.com", SENTINEL]]);
		assert.match(text().stderr, /warning: these cookies were captured by Chrome, but trawl identifies itself as "trawl\//);
		assert.match(text().stderr, /bind cookies to the client/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no User-Agent warning for a HAR trawl itself recorded, or one without a UA", async () => {
	const dir = tempDir();
	try {
		for (const ua of ["trawl/0.3.0 (+https://github.com/rjwalters/trawl)", null]) {
			const file = writeSource(dir, "trace.har", har(ua));
			const { deps, text } = fakeDeps({ profileDir: "/p" });
			assert.equal(await runCookiesImport([file, "--profile", "/p"], deps), 0);
			assert.doesNotMatch(text().stderr, /warning/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("imports a cURL command; its -A User-Agent drives the warning", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "req.sh", CURL);
	const { deps, calls, text } = fakeDeps({ profileDir: "/p" });
	try {
		assert.equal(await runCookiesImport([file, "--profile", "/p"], deps), 0);
		// sessionid is a sign-in cookie and is dropped by default.
		assert.deepEqual(calls.added.map((c) => [c.name, c.domain, c.secure]), [["cart", "shop.example.com", true]]);
		assert.match(text().stdout, /Dropped 1 sign-in cookie \(sessionid\)/);
		assert.match(text().stderr, /captured by Firefox/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("browserFamily tells the common browsers apart", () => {
	assert.equal(browserFamily(CHROME_UA), "Chrome");
	assert.equal(browserFamily(`${CHROME_UA} Edg/130.0.0.0`), "Edge");
	assert.equal(browserFamily(`${CHROME_UA} OPR/115.0.0.0`), "Opera");
	assert.equal(browserFamily("Mozilla/5.0 (X11; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox");
	assert.equal(
		browserFamily("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"),
		"Safari",
	);
	assert.equal(browserFamily("curl/8.7.1"), "curl");
	assert.equal(browserFamily("trawl/0.3.0 (+https://github.com/rjwalters/trawl)"), "trawl");
});

// --- --domain / --allow / --include-auth through the CLI argv ---

test("--domain keeps only cookies sent to that host", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	const { deps, calls } = fakeDeps({ profileDir: "/p" });
	try {
		await runCookies(["import", file, "--profile", "/p", "--domain", "www.other.org"], deps);
		assert.deepEqual(calls.added.map((c) => c.name), ["theme"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--allow keeps only the named cookies; --include-auth keeps sign-in ones", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	try {
		let f = fakeDeps({ profileDir: "/p" });
		await runCookies(["import", file, "--profile", "/p", "--allow", " pref , theme"], f.deps);
		assert.deepEqual(f.calls.added.map((c) => c.name), ["pref", "theme"]);

		f = fakeDeps({ profileDir: "/p" });
		await runCookies(["import", file, "--profile", "/p", "--include-auth"], f.deps);
		assert.deepEqual(f.calls.added.map((c) => c.name), ["pref", "SID", "theme"]);
		assert.doesNotMatch(f.text().stdout, /sign-in/);

		f = fakeDeps({ profileDir: "/p" });
		await runCookies(["import", file, "--profile", "/p", "--allow=SID", "--include-auth"], f.deps);
		assert.deepEqual(f.calls.added.map((c) => c.name), ["SID"]);

		await assert.rejects(() => runCookies(["import", file, "--profile", "/p", "--allow", ","], f.deps), /--allow expects cookie names/);
		await assert.rejects(() => runCookies(["import", file, "--profile", "/p", "--domain", " "], f.deps), /--domain expects a host/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- profile directory ---

test("--profile falls back to $TRAWL_PROFILE_DIR; missing both is an error", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	try {
		const f = fakeDeps({ profileDir: "/env-p", env: { TRAWL_PROFILE_DIR: "/env-p" } });
		assert.equal(await runCookiesImport([file], f.deps), 0);
		assert.equal(f.calls.launch[0][0], "/env-p");

		const g = fakeDeps({ profileDir: "/p" });
		await assert.rejects(() => runCookiesImport([file], g.deps), /requires --profile <dir> \(or \$TRAWL_PROFILE_DIR\)/);
		assert.equal(g.calls.launch.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("creates the profile dir 0700; leaves an existing dir's mode alone", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	const launch = async () => ({ addCookies: async () => {}, close: async () => {} });
	const quiet = { env: {}, stdout: () => {}, stderr: () => {}, resolveExecutablePath: () => "/x", launchPersistentContext: launch };
	try {
		const fresh = join(dir, "nested", "profile");
		await runCookiesImport([file, "--profile", fresh], quiet);
		assert.equal(statSync(fresh).mode & 0o777, 0o700);

		const existing = join(dir, "existing");
		mkdirSync(existing, { mode: 0o755 });
		await runCookiesImport([file, "--profile", existing], quiet);
		assert.equal(statSync(existing).mode & 0o777, 0o755 & ~process.umask());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- bad input never launches the browser or touches the profile ---

test("bad input exits non-zero and leaves the profile untouched", async () => {
	const dir = tempDir();
	const profile = join(dir, "profile");
	try {
		const cases = [
			[writeSource(dir, "junk.txt", `this is not a cookie file ${SENTINEL}`), /unrecognised cookie source/],
			[writeSource(dir, "bad.json", `{"log": ${SENTINEL}`), /looks like JSON but could not be parsed/],
			[writeSource(dir, "empty.txt", ""), /cookie source is empty/],
			[join(dir, "missing.txt"), /cannot read cookie source .*missing\.txt \(ENOENT\)/],
		];
		for (const [file, message] of cases) {
			const { deps, calls } = fakeDeps({ profileDir: profile });
			deps.existsSync = existsSync;
			deps.mkdirSync = mkdirSync;
			await assert.rejects(() => runCookiesImport([file, "--profile", profile], deps), (err) => {
				assert.match(err.message, message);
				assert.ok(!err.message.includes(SENTINEL), "error message leaked the cookie value");
				return true;
			});
			assert.equal(calls.launch.length, 0);
			assert.equal(existsSync(profile), false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("zero surviving cookies: exit 1, summary printed, no browser, no profile", async () => {
	const dir = tempDir();
	const profile = join(dir, "profile");
	const file = writeSource(dir, "cookies.txt", TXT);
	try {
		const { deps, calls, text } = fakeDeps({ profileDir: profile });
		deps.existsSync = existsSync;
		deps.mkdirSync = mkdirSync;
		const code = await runCookiesImport([file, "--profile", profile, "--allow", "SID,old"], deps);
		assert.equal(code, 1);
		assert.equal(calls.launch.length, 0);
		assert.equal(existsSync(profile), false);
		const { stderr } = text();
		assert.match(stderr, /Dropped 1 sign-in cookie \(SID\)/);
		assert.match(stderr, /Dropped 1 expired cookie/);
		assert.match(
			stderr,
			/no cookies left to import from .*: every cookie that matched --allow was expired or a sign-in cookie \(pass --include-auth to import sign-in cookies\); .* was not touched/,
		);
		assert.doesNotMatch(stderr, /still contains every cookie/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("zero survivors: the message names the filter that removed them", async () => {
	const dir = tempDir();
	const profile = join(dir, "profile");
	const file = writeSource(dir, "cookies.txt", TXT);
	const run = async (...flags) => {
		const { deps, calls, text } = fakeDeps({ profileDir: profile });
		deps.existsSync = existsSync;
		deps.mkdirSync = mkdirSync;
		assert.equal(await runCookiesImport([file, "--profile", profile, ...flags], deps), 1);
		assert.equal(calls.launch.length, 0);
		return text().stderr;
	};
	try {
		// --allow named only a sign-in cookie: the auth filter removed it, not --allow.
		let err = await run("--allow", "SID");
		assert.match(err, /: every cookie that matched --allow was a sign-in cookie \(pass --include-auth to import sign-in cookies\);/);

		err = await run("--domain", "nowhere.test");
		assert.match(err, /: no cookie matched --domain;/);
		assert.doesNotMatch(err, /include-auth/);

		err = await run("--domain", "example.com", "--allow", "theme");
		assert.match(err, /: no cookie matched --domain and --allow;/);

		// No --domain/--allow given: neither is mentioned.
		const expiredOnly = writeSource(dir, "old.txt", netscape([[".example.com", "TRUE", "/", "FALSE", "1000", "old", "x"]]));
		const { deps } = fakeDeps({ profileDir: profile });
		const lines = [];
		deps.stderr = (s) => lines.push(s);
		assert.equal(await runCookiesImport([expiredOnly, "--profile", profile], deps), 1);
		assert.match(lines.join(""), /: every cookie was expired;/);
		assert.doesNotMatch(lines.join(""), /--domain|--allow|include-auth/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- the context lifecycle ---

// A value with every character JSON or URL encoding rewrites, so an echo in
// any encoding differs from the raw value and a plain `includes` would miss it.
const AWKWARD = 'aw"KW\\rd/V4l+u3=Zq-77Xk';

// Every form a browser error could carry the value in, and every 6+ character
// substring of it: none may reach stdout, stderr or the thrown error.
function assertNoValue(haystacks, value = AWKWARD) {
	const forms = [value, encodeURIComponent(value), JSON.stringify(value), escape(value), value.slice(0, 8)];
	for (let i = 0; i + 6 <= value.length; i++) forms.push(value.slice(i, i + 6));
	for (const h of haystacks) {
		for (const f of forms) assert.ok(!h.includes(f), `leaked ${JSON.stringify(f)} in ${JSON.stringify(h)}`);
	}
}

function errorText(err) {
	return [String(err?.message), String(err?.stack), String(err?.cause ?? ""), JSON.stringify(err)];
}

test("the context is closed when addCookies throws, and no form of the value is echoed", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", netscape([[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", AWKWARD]]));
	const echoes = [
		(v) => `browserContext.addCookies: bad cookie ${v}`,
		(v) => `browserContext.addCookies: bad cookie ${encodeURIComponent(v)}`,
		(v) => `browserContext.addCookies: Invalid cookie ${JSON.stringify({ name: "pref", value: v })}`,
		(v) => `browserContext.addCookies: bad cookie ${v.slice(0, 8)}...`,
		// A known message with the value appended is no longer the known message.
		(v) => `browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields ${v}`,
	];
	try {
		for (const echo of echoes) {
			const { deps, context, text } = fakeDeps({
				profileDir: "/p",
				addCookies: async (cookies) => {
					assert.equal(cookies[0].value, AWKWARD, "fixture lost its value");
					const err = new Error(`${echo(cookies[0].value)}\nCall log: ${cookies[0].value}`);
					err.cause = new Error(cookies[0].value);
					throw err;
				},
			});
			await assert.rejects(() => runCookiesImport([file, "--profile", "/p"], deps), (err) => {
				assert.equal(err.message, "could not write cookies to /p; nothing was imported");
				assert.equal(err.cause, undefined);
				assertNoValue(errorText(err));
				return true;
			});
			assert.equal(context.closed, true);
			const { stdout, stderr } = text();
			assert.doesNotMatch(stdout, /Imported/);
			assertNoValue([stdout, stderr]);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only an exact, known value-free addCookies message adds detail", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", TXT);
	const cases = [
		[
			"browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields\nCall log: ...",
			"could not write cookies to /p; nothing was imported (the browser refused a cookie, and so the whole batch)",
		],
		[
			"Target page, context or browser has been closed",
			"could not write cookies to /p; nothing was imported (the browser closed unexpectedly)",
		],
		["Something new and unrecognised", "could not write cookies to /p; nothing was imported"],
	];
	try {
		for (const [thrown, expected] of cases) {
			const { deps, context } = fakeDeps({
				profileDir: "/p",
				addCookies: async () => {
					throw new Error(thrown);
				},
			});
			await assert.rejects(() => runCookiesImport([file, "--profile", "/p"], deps), (err) => {
				assert.equal(err.message, expected);
				return true;
			});
			assert.equal(context.closed, true);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("launch and close failures get fixed messages too", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "cookies.txt", netscape([[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", AWKWARD]]));
	try {
		const launchFail = fakeDeps({ profileDir: "/p" });
		launchFail.deps.launchPersistentContext = async () => {
			throw new Error(`launch failed: ${AWKWARD} ${encodeURIComponent(AWKWARD)}`, { cause: AWKWARD });
		};
		await assert.rejects(() => runCookiesImport([file, "--profile", "/p"], launchFail.deps), (err) => {
			assert.match(err.message, /^could not start the browser with profile \/p; nothing was imported/);
			assertNoValue(errorText(err));
			return true;
		});

		const closeFail = fakeDeps({ profileDir: "/p" });
		closeFail.context.close = async () => {
			throw new Error(`close failed: ${JSON.stringify(AWKWARD)}`, { cause: AWKWARD });
		};
		await assert.rejects(() => runCookiesImport([file, "--profile", "/p"], closeFail.deps), (err) => {
			assert.match(err.message, /^could not save cookies to \/p: .* the import may be incomplete$/);
			assertNoValue(errorText(err));
			return true;
		});
		for (const f of [launchFail, closeFail]) assertNoValue(Object.values(f.text()));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- cookies Chromium would refuse are skipped, not allowed to sink the batch ---

test("a cookie the browser would refuse is skipped by name; the rest import", async () => {
	const dir = tempDir();
	const file = writeSource(
		dir,
		"cookies.txt",
		netscape([
			[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", SENTINEL],
			["example.com", "FALSE", "/x", "TRUE", String(FUTURE), "__Host-pathy", `${SENTINEL}-h`],
			[".example.com", "TRUE", "/", "FALSE", String(FUTURE), "__Secure-plain", `${SENTINEL}-s`],
			[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "huge", `${SENTINEL}${"x".repeat(5000)}`],
		]),
	);
	try {
		const { deps, calls, text } = fakeDeps({ profileDir: "/p" });
		assert.equal(await runCookiesImport([file, "--profile", "/p"], deps), 0);
		assert.deepEqual(calls.added.map((c) => c.name), ["pref"]);
		const { stdout, stderr } = text();
		assert.match(stdout, /Imported 1 cookie into \/p:/);
		assert.match(stdout, /Skipped 3 cookies the browser would refuse \(__Host-pathy, __Secure-plain, huge\)\./);
		assert.ok(!stdout.includes(SENTINEL) && !stderr.includes(SENTINEL));

		// Only refused cookies left: exit 1, no browser, and the message says why.
		const only = writeSource(dir, "bad.txt", netscape([["example.com", "FALSE", "/x", "TRUE", String(FUTURE), "__Host-pathy", "v"]]));
		const g = fakeDeps({ profileDir: "/p" });
		assert.equal(await runCookiesImport([only, "--profile", "/p"], g.deps), 1);
		assert.equal(g.calls.launch.length, 0);
		assert.match(g.text().stderr, /: every cookie was one the browser would refuse;/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The pre-check mirrors Chromium; this pins it to the real thing, so a browser
// that changes its rules fails here rather than in a user's import.
test("browserWouldReject agrees with Chromium's addCookies", browserOpts, async () => {
	const { chromium } = await import("playwright-core");
	const dir = tempDir();
	const base = { domain: "example.com", path: "/", expires: FUTURE, httpOnly: false, secure: true };
	const cases = {
		plain: {},
		dotDomain: { domain: ".example.com" },
		awkward: { value: AWKWARD },
		spaceInside: { value: "x y" },
		nonAscii: { value: "xé" },
		emptyName: { name: "" },
		emptyValue: { value: "" },
		semicolonValue: { value: "x;y" },
		semicolonName: { name: "a;b" },
		equalsName: { name: "a=b" },
		tabValue: { value: "x\ty" },
		newlineValue: { value: "x\ny" },
		controlName: { name: "a\u0001" },
		delValue: { value: "x\u007f" },
		leadingSpaceName: { name: " a" },
		trailingSpaceValue: { value: "v " },
		bothEmpty: { name: "", value: "" },
		size4096: { value: "x".repeat(4095) },
		size4097: { value: "x".repeat(4096) },
		path1024: { path: `/${"p".repeat(1023)}` },
		path1025: { path: `/${"p".repeat(1024)}` },
		pathNoSlash: { path: "x" },
		pathSemicolon: { path: "/a;b" },
		hostOk: { name: "__Host-a" },
		hostDotDomain: { name: "__Host-a", domain: ".example.com" },
		hostPath: { name: "__Host-a", path: "/x" },
		hostInsecure: { name: "__Host-a", secure: false },
		hostLowercase: { name: "__host-a", path: "/x" },
		secureInsecure: { name: "__Secure-a", secure: false },
		secureLowercase: { name: "__secure-a", secure: false },
		prefixInValue: { name: "", value: "__Host-x", secure: false },
		emptyDomain: { domain: "" },
	};
	const context = await chromium.launchPersistentContext(join(dir, "p"), {
		executablePath: resolveExecutablePath(),
		headless: true,
	});
	try {
		for (const [label, over] of Object.entries(cases)) {
			const cookie = { ...base, name: "a", value: "v", ...over };
			let refused = false;
			try {
				await context.addCookies([cookie]);
			} catch {
				refused = true;
			}
			assert.equal(browserWouldReject(cookie), refused, `${label}: Chromium ${refused ? "refused" : "accepted"} it`);
		}
	} finally {
		await context.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- redaction across real processes (stdout + stderr) ---

function runCli(args, env = {}) {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI_PATH, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("the sentinel cookie value appears in no output, on any path", async () => {
	const dir = tempDir();
	const profile = join(dir, "profile");
	try {
		const txt = writeSource(dir, "cookies.txt", TXT);
		const runs = [
			// Failure paths, in a real process.
			await runCli(["cookies", "import", writeSource(dir, "junk.txt", `nope ${SENTINEL}`), "--profile", profile]),
			await runCli(["cookies", "import", writeSource(dir, "bad.har", `{${SENTINEL}`), "--profile", profile]),
			await runCli(["cookies", "import", writeSource(dir, "bad.curl", `curl -H 'Cookie: a=${SENTINEL}'`), "--profile", profile]),
			await runCli(["cookies", "import", txt, "--profile", profile, "--allow", "SID"]),
			await runCli(["cookies", "import", txt]),
			// Past parsing: no such browser, so it fails before the profile exists.
			await runCli(["cookies", "import", txt, "--profile", profile, "--executable-path", join(dir, "no-chrome")]),
		];
		for (const r of runs) {
			assert.equal(r.code, 1, r.stderr);
			assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL), `leaked: ${r.stdout}${r.stderr}`);
		}
		assert.equal(existsSync(profile), false);

		// Success path, with every source format and --include-auth.
		for (const [name, body] of [["c.txt", TXT], ["t.har", har(CHROME_UA)], ["r.curl", CURL]]) {
			const f = fakeDeps({ profileDir: "/p" });
			assert.equal(await runCookiesImport([writeSource(dir, name, body), "--profile", "/p", "--include-auth"], f.deps), 0);
			const { stdout, stderr } = f.text();
			assert.ok(f.calls.added.some((c) => c.value.includes(SENTINEL)), "fixture lost its sentinel");
			assert.ok(!stdout.includes(SENTINEL) && !stderr.includes(SENTINEL), `leaked: ${stdout}${stderr}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--help documents the subcommand and its flags", async () => {
	const { stdout, code } = await runCli(["--help"]);
	assert.equal(code, 0);
	assert.match(stdout, /trawl cookies import <file> --profile <dir>/);
	assert.match(stdout, /--domain <host>/);
	assert.match(stdout, /--allow <names>/);
	assert.match(stdout, /--include-auth/);
	assert.match(stdout, /AUTH_COOKIES in src\/cookies\.mjs/);
	const sub = await runCli(["cookies", "import", "--help"]);
	assert.equal(sub.code, 0);
	assert.equal(sub.stdout, stdout);
});

// --- end to end: import into a real profile, then fetch with it ---

function runBin(link, args) {
	return new Promise((resolve) => {
		execFile(link, args, { env: process.env, timeout: 60000 }, (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("an imported cookie is presented by a later fetch with --profile", browserOpts, async () => {
	const dir = tempDir();
	const binDir = tempDir();
	const link = join(binDir, "trawl");
	symlinkSync(CLI_PATH, link);
	const server = createServer((req, res) => {
		if (req.url === "/robots.txt") {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><title>echo</title><pre>cookie=[${req.headers.cookie ?? ""}]</pre>`);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	try {
		const profile = join(dir, "profile");
		const file = writeSource(
			dir,
			"cookies.txt",
			netscape([["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "trawl_e2e", "imported-ok"]]),
		);
		const imp = await runBin(link, ["cookies", "import", file, "--profile", profile]);
		assert.equal(imp.code, 0, imp.stderr);
		assert.match(imp.stdout, /Imported 1 cookie/);
		assert.equal(statSync(profile).mode & 0o777, 0o700);

		// A HAR request cookie is a session cookie; it must survive too.
		const harFile = writeSource(dir, "t.har", JSON.stringify({
			log: { entries: [{ request: { url: `${origin}/`, headers: [{ name: "Cookie", value: "from_har=yes" }] }, response: { headers: [] } }] },
		}));
		const imp2 = await runBin(link, ["cookies", "import", harFile, "--profile", profile]);
		assert.equal(imp2.code, 0, imp2.stderr);

		const fetched = await runBin(link, [`${origin}/`, "--profile", profile, "--no-auth-check"]);
		assert.equal(fetched.code, 0, fetched.stderr);
		assert.match(fetched.stdout, /trawl_e2e=imported-ok/);
		assert.match(fetched.stdout, /from_har=yes/);
	} finally {
		await new Promise((r) => server.close(r));
		rmSync(dir, { recursive: true, force: true });
		rmSync(binDir, { recursive: true, force: true });
	}
});
