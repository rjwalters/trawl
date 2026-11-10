// `trawl <url> --cookies <file>` (#78): cookies for one fetch, persisting
// nothing. The CLI tests inject `render` through main()'s `deps`, and the
// library tests inject the browser through render()'s undocumented
// `browserType`, so everything but the last test runs without Chromium. The
// last one fetches for real through a symlinked bin.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveExecutablePath } from "../src/browser.mjs";
import { main, runLogin } from "../src/cli.mjs";
import { render } from "../src/render.mjs";

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
const URL_ = "https://example.com/";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "trawl-cookies-fetch-"));
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

// main() with render() replaced: records what render() was asked for.
async function runMain(argv, { env = {}, render: fake } = {}) {
	const calls = [];
	const err = [];
	const out = [];
	const write = process.stdout.write;
	process.stdout.write = (s) => out.push(String(s));
	try {
		const code = await main(argv, {
			env,
			stderr: (s) => err.push(s),
			render:
				fake ??
				(async (url, options) => {
					calls.push([url, options]);
					return { body: "ok", status: 200, url, screenshot: null, waitUntilFallback: null };
				}),
		});
		return { code, calls, stdout: out.join(""), stderr: err.join("") };
	} finally {
		process.stdout.write = write;
	}
}

// --- flag plumbing ---

test("--domain, --allow and --include-auth without --cookies are errors", async () => {
	for (const [flag, ...rest] of [["--domain", "x"], ["--allow", "a"], ["--include-auth"]]) {
		const r = runMain([URL_, flag, ...rest]);
		await assert.rejects(r, new RegExp(`^Error: ${flag} requires --cookies$`));
	}
	await assert.rejects(runMain([URL_, "--domain=x"]), /--domain requires --cookies/);
});

test("--cookies with --profile or $TRAWL_PROFILE_DIR is rejected before the file is read", async () => {
	const missing = join(tmpdir(), "trawl-no-such-cookie-file");
	await assert.rejects(
		runMain([URL_, "--cookies", missing, "--profile", "/p"]),
		/^Error: --cookies cannot be combined with --profile; to keep cookies in a profile use "trawl cookies import"$/,
	);
	await assert.rejects(
		runMain([URL_, "--cookies", missing], { env: { TRAWL_PROFILE_DIR: "/p" } }),
		/^Error: --cookies cannot be combined with \$TRAWL_PROFILE_DIR \(unset it for this run\); to keep cookies in a profile use "trawl cookies import"$/,
	);
});

test("--allow and --domain are validated as for cookies import", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "c.txt", TXT);
	try {
		await assert.rejects(runMain([URL_, "--cookies", file, "--allow", ","]), /--allow expects cookie names, e.g. --allow a,b/);
		await assert.rejects(runMain([URL_, "--cookies", file, "--domain", " "]), /--domain expects a host/);
		await assert.rejects(runMain([URL_, "--cookies", ""]), /--cookies expects a file/);
		await assert.rejects(runMain([URL_, "--cookies"]), /--cookies requires a value/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trawl login and trawl cookies import still reject --cookies", async () => {
	await assert.rejects(runLogin(["https://example.com", "--cookies", "f"]), /^Error: Unknown option: --cookies$/);
	await assert.rejects(runLogin(["https://example.com", "--include-auth"]), /^Error: Unknown option: --include-auth$/);
	await assert.rejects(main(["cookies", "import", "f", "--cookies", "g"]), /Unknown option for trawl cookies import: --cookies/);
});

test("a fetch without --cookies passes no cookies to render()", async () => {
	const r = await runMain([URL_]);
	assert.equal(r.code, 0);
	assert.equal("cookies" in r.calls[0][1], false);
	assert.equal(r.stderr, "");
});

// --- what reaches render() ---

test("the filtered list reaches render(), with no profile, sign-in and expired dropped", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "c.txt", TXT);
	try {
		const r = await runMain([URL_, "--cookies", file]);
		assert.equal(r.code, 0);
		const [, options] = r.calls[0];
		assert.equal(options.profileDir, undefined);
		assert.deepEqual(options.cookies, [
			{ name: "pref", value: SENTINEL, domain: ".example.com", path: "/", expires: FUTURE, httpOnly: false, secure: true },
			// A session cookie stays one: no 7-day expiry on a one-off fetch.
			{ name: "theme", value: `${SENTINEL}-other`, domain: ".other.org", path: "/", expires: -1, httpOnly: false, secure: false },
		]);
		// Something was dropped, so the summary prints even without -S.
		assert.match(r.stderr, /^Using 2 cookies from .*c\.txt for this fetch only \(not saved\):\n/);
		assert.match(r.stderr, /\n {2}pref\t\.example\.com\t\d{4}-\d\d-\d\dT[\d:]+Z\n/);
		assert.match(r.stderr, /\n {2}theme\t\.other\.org\tsession\n/);
		assert.match(r.stderr, /Dropped 1 sign-in cookie \(SID\); pass --include-auth to use them\.\n/);
		assert.match(r.stderr, /Dropped 1 expired cookie\.\n/);
		assert.ok(!r.stderr.includes(SENTINEL) && !r.stdout.includes(SENTINEL));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--domain, --allow and --include-auth filter the fetch's cookies", async () => {
	const dir = tempDir();
	const file = writeSource(dir, "c.txt", TXT);
	const names = async (...flags) => (await runMain([URL_, "--cookies", file, ...flags])).calls[0][1].cookies.map((c) => c.name);
	try {
		assert.deepEqual(await names("--domain", "www.other.org"), ["theme"]);
		assert.deepEqual(await names("--allow", " pref , theme"), ["pref", "theme"]);
		assert.deepEqual(await names("--include-auth"), ["pref", "SID", "theme"]);
		assert.deepEqual(await names("--allow=SID", "--include-auth"), ["SID"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the summary is quiet unless -S, or something was dropped or skipped", async () => {
	const dir = tempDir();
	const clean = writeSource(dir, "clean.txt", netscape([[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", SENTINEL]]));
	const refused = writeSource(
		dir,
		"refused.txt",
		netscape([
			[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", SENTINEL],
			[".example.com", "TRUE", "/", "FALSE", String(FUTURE), "__Secure-plain", `${SENTINEL}-s`],
		]),
	);
	try {
		let r = await runMain([URL_, "--cookies", clean]);
		assert.equal(r.stderr, "");

		r = await runMain([URL_, "--cookies", clean, "-S"]);
		assert.match(r.stderr, /^Using 1 cookie from .*clean\.txt for this fetch only \(not saved\):\n {2}pref\t\.example\.com\t\S+\n$/);

		r = await runMain([URL_, "--cookies", refused]);
		assert.deepEqual(r.calls[0][1].cookies.map((c) => c.name), ["pref"]);
		assert.match(r.stderr, /Skipped 1 cookie the browser would refuse \(__Secure-plain\)\.\n/);
		assert.ok(!r.stderr.includes(SENTINEL));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--cookies with --har warns, with or without -S, naming the HAR but no value", async () => {
	const dir = tempDir();
	const clean = writeSource(dir, "clean.txt", netscape([[".example.com", "TRUE", "/", "TRUE", String(FUTURE), "pref", SENTINEL]]));
	const har = join(dir, "trace.har");
	const WARNING = `trawl: warning: --har records request cookies, values included; ${har} will contain the cookies from --cookies\n`;
	try {
		// Quiet otherwise, so the warning is the whole of stderr.
		let r = await runMain([URL_, "--cookies", clean, "--har", har]);
		assert.equal(r.code, 0);
		assert.equal(r.calls[0][1].har, har);
		assert.equal(r.stderr, WARNING);

		r = await runMain([URL_, "--cookies", clean, "--har", har, "--har-omit-content", "-S"]);
		assert.equal(r.code, 0);
		// The summary no longer claims "(not saved)" when a HAR will keep them.
		assert.match(r.stderr, /^Using 1 cookie from .*clean\.txt for this fetch only:\n {2}pref\t\.example\.com\t\S+\n/);
		assert.ok(r.stderr.endsWith(WARNING), r.stderr);
		assert.ok(!r.stderr.includes(SENTINEL) && !r.stdout.includes(SENTINEL));

		// Neither half alone warns.
		r = await runMain([URL_, "--cookies", clean]);
		assert.equal(r.stderr, "");
		r = await runMain([URL_, "--har", har]);
		assert.equal(r.stderr, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HAR and cURL sources work too", async () => {
	const dir = tempDir();
	const har = JSON.stringify({
		log: { entries: [{ request: { url: "https://app.example.com/", headers: [{ name: "Cookie", value: `lang=${SENTINEL}` }] }, response: { headers: [] } }] },
	});
	const curl = `curl 'https://shop.example.com/cart' -H 'Cookie: cart=${SENTINEL}; sessionid=${SENTINEL}-s'`;
	try {
		let r = await runMain([URL_, "--cookies", writeSource(dir, "t.har", har)]);
		assert.deepEqual(r.calls[0][1].cookies.map((c) => [c.name, c.domain, c.expires]), [["lang", "app.example.com", -1]]);
		r = await runMain([URL_, "--cookies", writeSource(dir, "r.curl", curl)]);
		assert.deepEqual(r.calls[0][1].cookies.map((c) => [c.name, c.domain, c.expires]), [["cart", "shop.example.com", -1]]);
		assert.match(r.stderr, /Dropped 1 sign-in cookie \(sessionid\); pass --include-auth to use them/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- nothing usable fails before any request ---

test("bad input and zero survivors fail before render(), robots.txt or a browser", async () => {
	const dir = tempDir();
	const txt = writeSource(dir, "c.txt", TXT);
	const never = async () => assert.fail("render() must not be called");
	const cases = [
		[[writeSource(dir, "junk.txt", `this is not a cookie file ${SENTINEL}`)], /unrecognised cookie source/],
		[[writeSource(dir, "bad.json", `{"log": ${SENTINEL}`)], /looks like JSON but could not be parsed/],
		[[writeSource(dir, "empty.txt", "")], /cookie source is empty/],
		[[join(dir, "missing.txt")], /^cannot read cookie source .*missing\.txt \(ENOENT\)$/],
		[[writeSource(dir, "none.txt", "# Netscape HTTP Cookie File\n")], /: the file holds no cookies$/],
		[[txt, "--domain", "nowhere.test"], /^no cookies left to use from .*c\.txt: no cookie matched --domain$/],
		[
			[txt, "--allow", "SID"],
			/^no cookies left to use from .*c\.txt: every cookie that matched --allow was a sign-in cookie \(pass --include-auth to use sign-in cookies\)$/,
		],
		[
			[writeSource(dir, "refused.txt", netscape([["example.com", "FALSE", "/x", "TRUE", String(FUTURE), "__Host-pathy", "v"]]))],
			/: every cookie was one the browser would refuse$/,
		],
	];
	try {
		for (const [args, message] of cases) {
			await assert.rejects(runMain([URL_, "--cookies", ...args], { render: never }), (err) => {
				assert.match(err.message, message);
				assert.ok(!err.message.includes(SENTINEL));
				return true;
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- render() itself: a fake browser through the browserType seam ---

function fakeBrowser({ addCookies } = {}) {
	const events = [];
	const page = {
		on: () => {},
		off: () => {},
		mainFrame: () => null,
		url: () => "file:///fixture",
		title: async () => "Fixture",
		waitForTimeout: async () => {},
		goto: async () => {
			events.push("goto");
			return { status: () => 200 };
		},
	};
	const context = {
		addCookies: async (cookies) => {
			events.push(["addCookies", cookies]);
			if (addCookies) await addCookies(cookies);
		},
		newPage: async () => {
			events.push("newPage");
			return page;
		},
		close: async () => {
			events.push("context.close");
		},
	};
	const browserType = {
		launch: async () => {
			events.push("launch");
			return {
				newContext: async () => {
					events.push("newContext");
					return context;
				},
				close: async () => {
					events.push("browser.close");
				},
			};
		},
		launchPersistentContext: async () => {
			events.push("launchPersistentContext");
			return context;
		},
	};
	return { events, browserType };
}

const LIB = {
	format: "title",
	waitUntil: "load",
	authCheck: false,
	pacing: false,
	executablePath: process.execPath,
};

test("render({ cookies }) adds them before the page exists or navigates", async () => {
	const { events, browserType } = fakeBrowser();
	const cookies = [{ name: "a", value: SENTINEL, domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false }];
	const result = await render("file:///fixture", { ...LIB, browserType, cookies });
	assert.equal(result.body, "Fixture");
	assert.deepEqual(events, ["launch", "newContext", ["addCookies", cookies], "newPage", "goto", "context.close", "browser.close"]);
	// Passed through untouched: still a session cookie.
	assert.equal(events[2][1][0].expires, -1);
});

test("render() without cookies (or with none) never calls addCookies", async () => {
	for (const extra of [{}, { cookies: [] }]) {
		const { events, browserType } = fakeBrowser();
		await render("file:///fixture", { ...LIB, browserType, ...extra });
		assert.deepEqual(events, ["launch", "newContext", "newPage", "goto", "context.close", "browser.close"]);
	}
});

// A value with every character JSON or URL encoding rewrites, so an echo in
// any encoding differs from the raw value and a plain `includes` would miss it.
const AWKWARD = 'aw"KW\\rd/V4l+u3=Zq-77Xk';

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

test("an addCookies rejection in render() gets a fixed message; everything is closed", async () => {
	const throwingMessage = (v) => {
		const err = new Error("placeholder");
		Object.defineProperty(err, "message", {
			get() {
				throw new Error(`getter ${v}`);
			},
		});
		return err;
	};
	const rejections = [
		[(v) => new Error(`browserContext.addCookies: bad cookie ${v}\nCall log: ${encodeURIComponent(v)}`, { cause: v }), ""],
		[(v) => new Error(`browserContext.addCookies: Invalid cookie ${JSON.stringify({ value: v })}`), ""],
		[
			(v) => new Error(`browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields ${v}`),
			"",
		],
		[
			() => new Error("browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields\nCall log: x"),
			" (the browser refused a cookie, and so the whole batch)",
		],
		[throwingMessage, ""],
		// Not even an Error: a thrown object whose toString throws.
		[(v) => ({ toString() { throw new Error(v); }, get message() { return { toString() { throw new Error(v); } }; } }), ""],
	];
	const cookies = [{ name: "a", value: AWKWARD, domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false }];
	for (const [make, detail] of rejections) {
		const { events, browserType } = fakeBrowser({
			addCookies: async (list) => {
				throw make(list[0].value);
			},
		});
		await assert.rejects(render("file:///fixture", { ...LIB, browserType, cookies }), (err) => {
			assert.equal(err.message, `could not add cookies to the browser; the page was not fetched${detail}`);
			assert.equal(err.cause, undefined);
			assertNoValue(errorText(err));
			return true;
		});
		assert.ok(!events.includes("newPage") && !events.includes("goto"), "navigated after a failed addCookies");
		assert.ok(events.includes("context.close") && events.includes("browser.close"), "left the browser open");
	}
});

test("with profileDir too (library only), cookies go into the persistent context", async () => {
	const dir = tempDir();
	try {
		const { events, browserType } = fakeBrowser();
		const cookies = [{ name: "a", value: "v", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false }];
		await render("file:///fixture", { ...LIB, browserType, cookies, profileDir: join(dir, "p") });
		assert.deepEqual(events.slice(0, 3), ["launchPersistentContext", ["addCookies", cookies], "newPage"]);
	} finally {
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

test("the sentinel cookie value appears in no fetch output, on any path", async () => {
	const dir = tempDir();
	try {
		const txt = writeSource(dir, "cookies.txt", TXT);
		// No server listens here; every run must stop before reaching it.
		const url = "http://127.0.0.1:9/";
		const runs = [
			await runCli([url, "--cookies", writeSource(dir, "junk.txt", `nope ${SENTINEL}`)]),
			await runCli([url, "--cookies", writeSource(dir, "bad.har", `{${SENTINEL}`)]),
			await runCli([url, "--cookies", writeSource(dir, "bad.curl", `curl -H 'Cookie: a=${SENTINEL}'`)]),
			await runCli([url, "--cookies", txt, "--allow", "SID", "-S"]),
			await runCli([url, "--cookies", txt, "--profile", join(dir, "p")]),
			// Past filtering: no such browser, so the fetch fails at launch.
			await runCli([url, "--cookies", txt, "-S", "--include-auth", "--ignore-robots", "--no-pacing", "--executable-path", join(dir, "no-chrome")]),
		];
		for (const r of runs) {
			assert.equal(r.code, 1, r.stderr);
			assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL), `leaked: ${r.stdout}${r.stderr}`);
		}
		// The -S summary was printed on the run that got past filtering.
		assert.match(runs.at(-1).stderr, /Using 3 cookies from .* \(not saved\):/);
		assert.deepEqual(readdirSync(dir).sort(), ["bad.curl", "bad.har", "cookies.txt", "junk.txt"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- end to end: a real browser, a real server, through a symlinked bin ---

function runBin(link, args, env) {
	return new Promise((resolve) => {
		execFile(link, args, { env: { ...process.env, ...env }, timeout: 60000 }, (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("--cookies presents the cookie for one fetch only, from every format", browserOpts, async () => {
	const dir = tempDir();
	const binDir = tempDir();
	const home = tempDir();
	const link = join(binDir, "trawl");
	symlinkSync(CLI_PATH, link);
	const robotsCookies = [];
	const server = createServer((req, res) => {
		if (req.url === "/robots.txt") {
			robotsCookies.push(req.headers.cookie ?? "");
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><title>echo</title><pre>cookie=[${req.headers.cookie ?? ""}]</pre>`);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const env = { HOME: home, TRAWL_PROFILE_DIR: "" };
	// The browser itself may write into $HOME on any launch (Chromium on Linux
	// creates .cache and .local), so the bar is a plain fetch's footprint in a
	// HOME of its own, not an empty directory.
	const baselineHome = tempDir();
	const values = { txt: `${SENTINEL}-txt`, har: `${SENTINEL}-har`, curl: `${SENTINEL}-curl` };
	try {
		const baseline = await runBin(link, [`${origin}/`, "--no-auth-check", "--no-pacing"], { ...env, HOME: baselineHome });
		assert.equal(baseline.code, 0, baseline.stderr);
		const sources = [
			["cookies.txt", netscape([["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "from_txt", values.txt]]), `from_txt=${values.txt}`],
			[
				"t.har",
				JSON.stringify({
					log: { entries: [{ request: { url: `${origin}/`, headers: [{ name: "Cookie", value: `from_har=${values.har}` }] }, response: { headers: [] } }] },
				}),
				`from_har=${values.har}`,
			],
			["r.curl", `curl '${origin}/' -H 'Cookie: from_curl=${values.curl}'`, `from_curl=${values.curl}`],
		];
		for (const [name, body, expected] of sources) {
			const r = await runBin(link, [`${origin}/`, "--cookies", writeSource(dir, name, body), "--no-auth-check", "--no-pacing"], env);
			assert.equal(r.code, 0, r.stderr);
			assert.match(r.stdout, new RegExp(`cookie=\\[${expected}\\]`));
			assert.ok(!r.stderr.includes(SENTINEL), r.stderr);
		}
		const plain = await runBin(link, [`${origin}/`, "--no-auth-check", "--no-pacing"], env);
		assert.equal(plain.code, 0, plain.stderr);
		assert.match(plain.stdout, /cookie=\[\]/);
		// robots.txt stays cookie-blind in this part (#79).
		assert.ok(robotsCookies.length >= 5 && robotsCookies.every((c) => c === ""), robotsCookies.join("|"));
		// Nothing saved: HOME holds what a plain fetch leaves and no more (no
		// profile), no file under it holds a cookie value, and nothing new
		// appeared next to the sources.
		assert.deepEqual(readdirSync(home).sort(), readdirSync(baselineHome).sort());
		for (const file of filesUnder(home)) {
			const bytes = readFileSync(file);
			for (const value of Object.values(values)) {
				assert.ok(!bytes.includes(value), `${file} holds a cookie value`);
			}
		}
		assert.deepEqual(readdirSync(dir).sort(), ["cookies.txt", "r.curl", "t.har"]);
	} finally {
		await new Promise((r) => server.close(r));
		for (const d of [dir, binDir, home, baselineHome]) rmSync(d, { recursive: true, force: true });
	}
});

// Every regular file below `root`, without following symlinks.
function filesUnder(root) {
	const out = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}
