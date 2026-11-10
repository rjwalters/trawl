// `trawl <url> --cookies <file>` (#78): cookies for one fetch, persisting
// nothing. The CLI tests inject `render` through main()'s `deps`, and the
// library tests inject the browser through render()'s undocumented
// `browserType`, so everything but the last test runs without Chromium. The
// last one fetches for real through a symlinked bin.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveExecutablePath } from "../src/browser.mjs";
import { main, runLogin } from "../src/cli.mjs";
import { createCooldownStore } from "../src/cooldown.mjs";
import { CooldownError, render } from "../src/render.mjs";
import { selfSignedCert } from "./selfsigned.mjs";

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
	const WARNING = `trawl: warning: --har records request cookies, values included; ${har} will contain the cookies from --cookies (add --har-redact to redact them)\n`;
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

		// With --har-redact the warning would be false, so it is dropped.
		r = await runMain([URL_, "--cookies", clean, "--har", har, "--har-redact"]);
		assert.equal(r.code, 0);
		assert.equal(r.calls[0][1].harRedact, true);
		assert.equal(r.stderr, "");

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

function fakeBrowser({ addCookies, jar = [] } = {}) {
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
		// The profile's jar, as `context.cookies(url)` returns it.
		cookies: async (url) => {
			events.push(["cookies", url]);
			return jar;
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

// --- the --profile path's robots.txt request: Node fetch + the jar's cookies (#79, #89) ---

const PROFILE_URL = "http://127.0.0.1:1/page";

function robotsResponse(status, body = "User-agent: *\nDisallow:\n") {
	return { ok: status >= 200 && status <= 299, status, text: async () => body };
}

// render() on the profile path with a spy for Node fetch (`onFetch(url, init)`
// returns the response) and a fake jar behind `context.cookies`.
async function renderProfile({ onFetch, jar, extra = {} } = {}) {
	const dir = tempDir();
	const { events, browserType } = fakeBrowser({ jar });
	const fetchCalls = [];
	const fetch = async (url, init) => {
		fetchCalls.push([url, init]);
		events.push(["fetch", url]);
		return onFetch(url, init);
	};
	try {
		const result = render(PROFILE_URL, {
			...LIB,
			browserType,
			fetch,
			profileDir: join(dir, "p"),
			userAgent: "trawl/9.9.9 (+test)",
			...extra,
		});
		return { result: await result.then((r) => ({ r }), (e) => ({ e })), events, fetchCalls };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const jarCookie = (name, value, extra = {}) => ({
	name,
	value,
	domain: "127.0.0.1",
	path: "/",
	expires: -1,
	httpOnly: false,
	secure: false,
	...extra,
});

test("profileDir: robots.txt is fetched with the jar's cookies, after launch and before the page", async () => {
	const { result, events, fetchCalls } = await renderProfile({
		onFetch: () => robotsResponse(200),
		jar: [jarCookie("a", "1"), jarCookie("b", "snow\u2603man")],
	});
	assert.equal(result.e, undefined, result.e?.stack);
	assert.deepEqual(events, [
		"launchPersistentContext",
		["cookies", "http://127.0.0.1:1/robots.txt"],
		["fetch", "http://127.0.0.1:1/robots.txt"],
		"newPage",
		"goto",
		"context.close",
	]);
	// UTF-8 bytes, one char per byte (see robotsCookieHeader).
	assert.deepEqual(fetchCalls[0][1].headers, {
		"User-Agent": "trawl/9.9.9 (+test)",
		Cookie: "a=1; b=snow\u00e2\u0098\u0083man",
	});
});

test("profileDir: an empty jar sends no Cookie header", async () => {
	const { result, fetchCalls } = await renderProfile({ onFetch: () => robotsResponse(200), jar: [] });
	assert.equal(result.e, undefined);
	assert.deepEqual(fetchCalls[0][1].headers, { "User-Agent": "trawl/9.9.9 (+test)" });
});

test("profileDir with cookies (library): addCookies runs before the jar is read for robots", async () => {
	const cookies = [{ name: "a", value: "v", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false }];
	const { result, events } = await renderProfile({
		onFetch: () => robotsResponse(200),
		extra: { cookies },
	});
	assert.equal(result.e, undefined);
	assert.deepEqual(events.slice(0, 4), [
		"launchPersistentContext",
		["addCookies", cookies],
		["cookies", "http://127.0.0.1:1/robots.txt"],
		["fetch", "http://127.0.0.1:1/robots.txt"],
	]);
});

test("profileDir: a disallow closes the context and never opens a page", async () => {
	const { result, events } = await renderProfile({
		onFetch: () => robotsResponse(200, "User-agent: *\nDisallow: /\n"),
	});
	assert.equal(result.e?.message, "robots.txt disallows this path (Disallow: /). Use --ignore-robots to override.");
	assert.deepEqual(events, [
		"launchPersistentContext",
		["cookies", "http://127.0.0.1:1/robots.txt"],
		["fetch", "http://127.0.0.1:1/robots.txt"],
		"context.close",
	]);
});

// Each injected failure carries the jar cookie's value in its message, its
// stack and its cause (message, stack and code), so without the guard in
// checkRobotsAllowed (a code from SAFE_ERROR_CODES or fixed text once a
// Cookie header was sent) the value would reach the refusal (#93).
test("profileDir: an unreachable robots.txt is refused, naming no cookie", async () => {
	const quoting = (header, code) => {
		const cause = new Error(`connect failed, request had Cookie: ${header}`);
		cause.stack = `Error: ${header}\n    at ${header}`;
		if (code) cause.code = code;
		const err = new TypeError(`fetch failed: Cookie: ${header}`, { cause });
		err.stack = `TypeError: fetch failed: ${header}\n    at ${header}`;
		return err;
	};
	const cases = [
		[() => robotsResponse(503), /returned HTTP 503 \(server error\)/],
		[
			(_url, init) => {
				throw quoting(init.headers.Cookie);
			},
			/could not be fetched \(network error: request failed\)/,
		],
		[
			(_url, init) => {
				throw quoting(init.headers.Cookie, "ENOTFOUND");
			},
			/could not be fetched \(network error: ENOTFOUND\)/,
		],
		[
			(_url, init) => {
				throw quoting(init.headers.Cookie, `ENOTFOUND ${init.headers.Cookie}`);
			},
			/could not be fetched \(network error: request failed\)/,
		],
		[
			(_url, init) => ({ ok: true, status: 200, text: async () => Promise.reject(quoting(init.headers.Cookie)) }),
			/reading the body of .* failed \(request failed\)/,
		],
	];
	for (const [onFetch, cause] of cases) {
		let sent;
		const { result, events } = await renderProfile({
			onFetch: (url, init) => {
				sent = init.headers.Cookie;
				return onFetch(url, init);
			},
			jar: [jarCookie("k", AWKWARD)],
		});
		assert.equal(sent, `k=${AWKWARD}`, "the jar cookie was sent");
		assert.ok(result.e, "refused");
		// First, so that a missing guard fails as the leak it is.
		assertNoValue(errorText(result.e));
		assert.match(result.e.message, /^robots\.txt is unreachable: (reading the body of )?http:\/\/127\.0\.0\.1:1\/robots\.txt /);
		assert.match(result.e.message, cause);
		assert.doesNotMatch(result.e.message, /browser-profile cookies|No cookie from the profile/);
		assert.match(result.e.message, /Use --ignore-robots to override\.$/);
		assert.equal(result.e.cause, undefined);
		assert.ok(events.includes("context.close") && !events.includes("newPage") && !events.includes("goto"));
	}
});

test("profileDir: no matching jar cookie gets the profile's own note, not the plain one", async () => {
	for (const jar of [[], [jarCookie("k", "v", { domain: "other.org" })]]) {
		const { result, fetchCalls } = await renderProfile({ onFetch: () => robotsResponse(503), jar });
		assert.equal(fetchCalls[0][1].headers.Cookie, undefined);
		assert.equal(
			result.e?.message,
			"robots.txt is unreachable: http://127.0.0.1:1/robots.txt returned HTTP 503 (server error). RFC 9309 treats an unreachable robots.txt as disallowing the whole site. No cookie from the profile matched robots.txt, so the request carried none, and a cookie-gated robots.txt can fail here even when the page itself would load. Use --ignore-robots to override.",
		);
	}
});

// #93: the jar already applied Chromium's Secure rule, which sends Secure
// cookies to loopback over http; the robots request now matches the page.
test("profileDir: a Secure jar cookie on loopback http goes to robots.txt; --cookies stays strict", async () => {
	const jar = [jarCookie("sec", "S", { secure: true }), jarCookie("a", "1")];
	const { result, fetchCalls } = await renderProfile({ onFetch: () => robotsResponse(200), jar });
	assert.equal(result.e, undefined, result.e?.stack);
	assert.equal(fetchCalls[0][1].headers.Cookie, "sec=S; a=1");
	// The same cookies through --cookies (library `cookies`, no profile).
	const seen = [];
	const { browserType } = fakeBrowser();
	await render(PROFILE_URL, {
		...LIB,
		browserType,
		cookies: jar,
		fetch: async (_url, init) => {
			seen.push(init.headers.Cookie);
			return robotsResponse(200);
		},
	});
	assert.deepEqual(seen, ["a=1"]);
});

test("profileDir: a partitioned jar cookie from another site stays off robots.txt", async () => {
	const partitioned = (name, partitionKey, crossSite) =>
		jarCookie(name, AWKWARD, { secure: true, sameSite: "None", partitionKey, _crHasCrossSiteAncestor: crossSite });
	const jar = [
		partitioned("embed", "http://localhost", true),
		partitioned("anc", "http://127.0.0.1", true),
		partitioned("own", "http://127.0.0.1", false),
		jarCookie("plain", "1"),
	];
	const { result, fetchCalls } = await renderProfile({ onFetch: () => robotsResponse(200), jar });
	assert.equal(result.e, undefined, result.e?.stack);
	assert.equal(fetchCalls[0][1].headers.Cookie, `own=${AWKWARD}; plain=1`);
});

test("profileDir: a cross-origin robots.txt redirect after sending cookies gets the fixed hint", async () => {
	const redirected = () => ({ ...robotsResponse(503), redirected: true, url: "https://127.0.0.1:1/robots.txt" });
	const { result } = await renderProfile({ onFetch: redirected, jar: [jarCookie("k", AWKWARD)] });
	assert.equal(
		result.e?.message,
		"robots.txt is unreachable: http://127.0.0.1:1/robots.txt returned HTTP 503 (server error). RFC 9309 treats an unreachable robots.txt as disallowing the whole site. The robots.txt request was redirected to another origin, and cookies are not sent across a cross-origin redirect, so a cookie-gated robots.txt there was requested without them. Use --ignore-robots to override.",
	);
	assertNoValue(errorText(result.e));
	// No cookie sent: nothing was dropped, so no hint.
	const none = await renderProfile({ onFetch: redirected, jar: [] });
	assert.doesNotMatch(none.result.e?.message, /redirected/);
});

test("profileDir: a cooldown seen at the robots gate closes the context", async () => {
	const dir = tempDir();
	try {
		const stateDir = join(dir, "state");
		const { events, browserType } = fakeBrowser();
		const launch = browserType.launchPersistentContext;
		// Another process records a 503 cooldown while the browser starts:
		// admit() passed before the launch, and the gate's re-check refuses.
		browserType.launchPersistentContext = async (...args) => {
			const other = createCooldownStore({ stateDir });
			other.recordFailure("http://127.0.0.1:1", { status: 503, retryAfter: "120" });
			await other.flush();
			return launch(...args);
		};
		await assert.rejects(
			render(PROFILE_URL, {
				...LIB,
				browserType,
				fetch: async () => robotsResponse(200),
				pacing: true,
				minIntervalMs: 0,
				stateDir,
				profileDir: join(dir, "p"),
			}),
			CooldownError,
		);
		assert.ok(events.includes("context.close") && !events.includes("newPage"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("profileDir with ignoreRobots makes no robots request", async () => {
	const { result, events, fetchCalls } = await renderProfile({
		onFetch: () => {
			throw new Error("no robots request expected");
		},
		extra: { ignoreRobots: true },
	});
	assert.equal(result.e, undefined);
	assert.equal(fetchCalls.length, 0);
	assert.deepEqual(events, ["launchPersistentContext", "newPage", "goto", "context.close"]);
});

// #89: a non-ASCII cookie value reaches robots.txt as the same UTF-8 bytes the
// page request carries, on the profile path and the --cookies path, and the
// check no longer throws ERR_INVALID_CHAR.
test("robots.txt gets non-ASCII cookies as UTF-8, like the page request", browserOpts, async () => {
	const dir = tempDir();
	const raw = { robots: [], page: [] };
	const server = createServer((req, res) => {
		const i = req.rawHeaders.findIndex((h) => h.toLowerCase() === "cookie");
		const cookie = i < 0 ? "" : Buffer.from(req.rawHeaders[i + 1], "latin1").toString("hex");
		if (req.url === "/robots.txt") {
			raw.robots.push(cookie);
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("User-agent: *\nDisallow:\n");
			return;
		}
		raw.page.push(cookie);
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><title>t</title>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const cookies = [
		{ name: "p", value: "snow\u2603man", domain: "127.0.0.1", path: "/" },
		{ name: "q", value: "caf\u00e9", domain: "127.0.0.1", path: "/" },
	];
	const { executablePath: _unused, ...real } = LIB;
	try {
		for (const extra of [{ profileDir: join(dir, "p") }, {}]) {
			raw.robots.length = 0;
			raw.page.length = 0;
			await render(url, { ...real, cookies, ...extra });
			assert.equal(raw.robots.length, 1);
			const hex = (s) => Buffer.from(s, "utf8").toString("hex");
			assert.equal(raw.robots[0], hex("p=snow\u2603man; q=caf\u00e9"));
			// The page request sends the same bytes (order aside).
			assert.ok(raw.page[0].includes(hex("p=snow\u2603man")), raw.page[0]);
			assert.ok(raw.page[0].includes(hex("q=caf\u00e9")), raw.page[0]);
		}
	} finally {
		await new Promise((r) => server.close(r));
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
		// The robots.txt request carries the cookies that match it (#79): one
		// per source, and none on the two cookie-less runs.
		assert.deepEqual(robotsCookies, ["", ...sources.map(([, , expected]) => expected), ""]);
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

// #79 end to end: a robots.txt that answers 503 unless the site's own cookie
// comes with it, fetched without --ignore-robots via --cookies and via an
// imported --profile, through a symlinked bin and a real browser.
test("a cookie-gated robots.txt lets the fetch through with --cookies or an imported --profile", browserOpts, async () => {
	const dir = tempDir();
	const binDir = tempDir();
	const home = tempDir();
	const link = join(binDir, "trawl");
	symlinkSync(CLI_PATH, link);
	const robots = [];
	const server = createServer((req, res) => {
		if (req.url === "/robots.txt") {
			robots.push({ cookie: req.headers.cookie ?? "", ua: req.headers["user-agent"] ?? "" });
			const open = (req.headers.cookie ?? "").split("; ").includes("gate=open");
			res.writeHead(open ? 200 : 503, { "content-type": "text/plain" });
			res.end(open ? "User-agent: *\nDisallow:\n" : "busy");
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><title>echo</title><pre>cookie=[${req.headers.cookie ?? ""}]</pre>`);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const env = { HOME: home, TRAWL_PROFILE_DIR: "" };
	const common = ["--no-auth-check", "--no-pacing"];
	const file = writeSource(
		dir,
		"cookies.txt",
		netscape([
			["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "gate", "open"],
			// Secure, so never sent over http; and a cookie for another host.
			["127.0.0.1", "FALSE", "/", "TRUE", String(FUTURE), "sec", SENTINEL],
			[".other.org", "TRUE", "/", "FALSE", String(FUTURE), "far", `${SENTINEL}-far`],
		]),
	);
	try {
		// (a) No cookie: refused, as before.
		const plain = await runBin(link, [`${origin}/`, ...common], env);
		assert.equal(plain.code, 1, plain.stderr);
		assert.match(plain.stderr, /robots\.txt is unreachable: .* returned HTTP 503 \(server error\)\..*no browser-profile cookies/);
		assert.deepEqual(robots.at(-1).cookie, "");

		// (b) --cookies: only the matching cookie goes to robots.txt.
		const viaCookies = await runBin(link, [`${origin}/`, "--cookies", file, ...common], env);
		assert.equal(viaCookies.code, 0, viaCookies.stderr);
		// (Chromium treats 127.0.0.1 as secure, so the page also gets `sec`;
		// trawl's own robots request applies the plain http rule and does not.)
		assert.match(viaCookies.stdout, /cookie=\[gate=open[;\]]/);
		assert.equal(robots.at(-1).cookie, "gate=open");
		assert.match(robots.at(-1).ua, /^trawl\//);
		assert.ok(!viaCookies.stderr.includes(SENTINEL), viaCookies.stderr);

		// (c) An imported profile: robots.txt via Node fetch, with its jar.
		const profile = join(dir, "profile");
		const imported = await runBin(link, ["cookies", "import", file, "--profile", profile], env);
		assert.equal(imported.code, 0, imported.stderr);
		const har = join(dir, "trace.har");
		const before = robots.length;
		const viaProfile = await runBin(link, [`${origin}/`, "--profile", profile, "--har", har, ...common], env);
		assert.equal(viaProfile.code, 0, viaProfile.stderr);
		assert.match(viaProfile.stdout, /cookie=\[gate=open[;\]]/);
		assert.equal(robots.length, before + 1);
		// The jar's own filter applies (#93): Chromium sends Secure cookies to
		// loopback http, so `sec` goes along, exactly as on the page request;
		// the other host's never does.
		const sent = robots.at(-1).cookie.split("; ");
		assert.ok(sent.includes("gate=open"), robots.at(-1).cookie);
		assert.ok(sent.includes(`sec=${SENTINEL}`), robots.at(-1).cookie);
		assert.ok(!sent.some((c) => c.startsWith("far=")), robots.at(-1).cookie);
		const pageCookies = viaProfile.stdout.match(/cookie=\[([^\]]*)\]/)[1].split("; ");
		assert.deepEqual([...sent].sort(), [...pageCookies].sort());
		assert.match(robots.at(-1).ua, /^trawl\//);
		// The HAR records the page, not the robots.txt request, which goes
		// through Node fetch.
		const urls = JSON.parse(readFileSync(har, "utf8")).log.entries.map((e) => e.request.url);
		assert.ok(urls.includes(`${origin}/`), urls.join(" "));
		assert.ok(!urls.includes(`${origin}/robots.txt`), urls.join(" "));
	} finally {
		await new Promise((r) => server.close(r));
		for (const d of [dir, binDir, home]) rmSync(d, { recursive: true, force: true });
	}
});

// --- #87: the robots.txt Cookie header is always one fetch accepts ---

// A local server recording each request's raw Cookie header bytes (Node's
// parser hands header values over as latin-1, one character per byte).
async function bytesServer({ robots = "allow" } = {}) {
	const seen = [];
	const server = createServer((req, res) => {
		const i = req.rawHeaders.findIndex((h) => h.toLowerCase() === "cookie");
		const raw = i >= 0 ? req.rawHeaders[i + 1] : null;
		seen.push({ url: req.url, cookie: raw === null ? null : Buffer.from(raw, "latin1") });
		if (req.url === "/robots.txt") {
			if (robots === "destroy") return req.socket.destroy();
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("User-agent: *\nDisallow:\n");
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><title>loaded</title><p>page loaded</p>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		seen,
		close: () => new Promise((r) => server.close(r)),
	};
}

// The cookies of a raw header, as byte strings, in no particular order.
const cookieSet = (buf) => (buf ? buf.toString("latin1").split("; ").sort() : []);

const libCookie = (name, value) => ({ name, value, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false });

test("render(): a CR/LF, NUL or control-character cookie is left out of robots.txt; the fetch goes on", async () => {
	const srv = await bytesServer();
	try {
		const { events, browserType } = fakeBrowser();
		const cookies = [
			libCookie("lib", "LIBLEAK\r\nX-Injected: 1"),
			libCookie("nul", `${AWKWARD}\u0000`),
			libCookie("ctl", `${AWKWARD}\u0001`),
			libCookie("ok", "1"),
		];
		const result = await render(`${srv.origin}/page`, { ...LIB, browserType, cookies });
		assert.equal(result.body, "Fixture");
		const robots = srv.seen.filter((s) => s.url === "/robots.txt");
		assert.equal(robots.length, 1);
		// Only the sendable cookie, and nothing injected: one Cookie header.
		assert.equal(robots[0].cookie.toString("latin1"), "ok=1");
		assert.ok(events.includes("goto"));
		// None sendable: robots.txt goes with no Cookie header at all.
		const only = await render(`${srv.origin}/page`, { ...LIB, browserType: fakeBrowser().browserType, cookies: cookies.slice(0, 1) });
		assert.equal(only.body, "Fixture");
		assert.equal(srv.seen.at(-1).url, "/robots.txt");
		assert.equal(srv.seen.at(-1).cookie, null);
	} finally {
		await srv.close();
	}
});

test("render(): `;` in a value or `=` in a name never reaches robots.txt, whole or mis-split", async () => {
	const srv = await bytesServer();
	try {
		const { browserType } = fakeBrowser();
		const cookies = [libCookie("lib", "LIBLEAK; injected=1"), libCookie("a=b", "LIBLEAK"), libCookie("ok", "fine")];
		const result = await render(`${srv.origin}/page`, { ...LIB, browserType, cookies });
		assert.equal(result.body, "Fixture");
		const robots = srv.seen.filter((s) => s.url === "/robots.txt");
		assert.equal(robots.length, 1);
		assert.equal(robots[0].cookie.toString("latin1"), "ok=fine");
		for (const s of srv.seen) assert.doesNotMatch(String(s.cookie?.toString("latin1")), /LIBLEAK|injected/);
	} finally {
		await srv.close();
	}
});

test("render(): an injected fetch whose error quotes the Cookie header leaks none of it", async () => {
	const cookies = [libCookie("k", AWKWARD), libCookie("k2", `${AWKWARD}-2`)];
	const throwers = [
		(h) => new TypeError(`Headers.append: "${h}" is an invalid header value.`),
		(h) => Object.assign(new TypeError("fetch failed"), { stack: `TypeError: ${h}` }),
		(h) => new TypeError("fetch failed", { cause: Object.assign(new Error(h), { code: h, header: h }) }),
		(h) => Object.assign(new TypeError("fetch failed"), { cookie: h, request: { headers: { Cookie: h } } }),
		(h) => new TypeError("fetch failed", { cause: Object.assign(new Error(h), { code: "ECONNREFUSED" }) }),
	];
	for (const make of throwers) {
		const { events, browserType } = fakeBrowser();
		let sent;
		const fetch = async (_url, init) => {
			sent = init.headers.Cookie;
			throw make(sent);
		};
		const err = await render("http://127.0.0.1:1/page", { ...LIB, browserType, cookies, fetch }).catch((e) => e);
		assert.ok(sent?.includes(AWKWARD), "the header was sent");
		assert.match(err.message, /^robots\.txt is unreachable: http:\/\/127\.0\.0\.1:1\/robots\.txt could not be fetched \(network error: (request failed|ECONNREFUSED)\)\./);
		assert.equal(err.cause, undefined);
		assertNoValue(errorText(err));
		// Refused before any browser work.
		assert.deepEqual(events, []);
	}
});

test("CLI: a robots.txt failure with cookies sent prints no cookie content", async () => {
	const srv = await bytesServer({ robots: "destroy" });
	const dir = tempDir();
	try {
		const file = writeSource(
			dir,
			"cookies.txt",
			netscape([
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "pref", "snow☃man"],
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "awk", AWKWARD],
			]),
		);
		const r = await runCli([`${srv.origin}/`, "--cookies", file, "-S", "--no-pacing"], { TRAWL_PROFILE_DIR: "" });
		assert.equal(r.code, 1, r.stderr);
		assert.match(r.stderr, /robots\.txt is unreachable: .* could not be fetched \(network error: ([A-Z_]+|request failed)\)\./);
		assertNoValue([r.stdout, r.stderr]);
		assertNoValue([r.stdout, r.stderr], "snow☃man");
		// The cookie went, UTF-8 encoded, as the browser would send it.
		assert.deepEqual(cookieSet(srv.seen[0].cookie), [`awk=${AWKWARD}`, "pref=snowâ\u0098\u0083man"].sort());
	} finally {
		await srv.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

// The issue's reproduction, through a symlinked bin and a real browser: a
// cookie above U+00FF used to fail robots.txt with Node's error text. Now
// the page loads, and robots.txt and the page see the very same bytes for
// every cookie, non-ASCII included (Chromium sends UTF-8).
test("--cookies with non-ASCII values: the page loads, robots.txt and page get the same bytes", browserOpts, async () => {
	const srv = await bytesServer();
	const dir = tempDir();
	const binDir = tempDir();
	const home = tempDir();
	const link = join(binDir, "trawl");
	symlinkSync(CLI_PATH, link);
	try {
		const file = writeSource(
			dir,
			"cookies.txt",
			netscape([
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "pref", "snow☃man"],
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "cafe", "café"],
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "awk", AWKWARD],
				["127.0.0.1", "FALSE", "/", "FALSE", String(FUTURE), "plain", "1"],
			]),
		);
		const r = await runBin(link, [`${srv.origin}/`, "--cookies", file, "-S", "--no-auth-check", "--no-pacing", "-f", "text"], {
			HOME: home,
			TRAWL_PROFILE_DIR: "",
		});
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /page loaded/);
		assert.match(r.stderr, /Using 4 cookies from /);
		assertNoValue([r.stdout, r.stderr]);
		assert.ok(!r.stderr.includes("snow") && !r.stderr.includes("café"), r.stderr);
		const robots = srv.seen.find((s) => s.url === "/robots.txt");
		const page = srv.seen.find((s) => s.url === "/");
		const expected = ["awk=" + AWKWARD, "cafe=cafÃ©", "plain=1", "pref=snowâ\u0098\u0083man"].sort();
		assert.deepEqual(cookieSet(robots.cookie), expected);
		assert.deepEqual(cookieSet(page.cookie), expected);
	} finally {
		await srv.close();
		for (const d of [dir, binDir, home]) rmSync(d, { recursive: true, force: true });
	}
});

// The issue's library reproduction against real Chromium: robots.txt now
// goes without the CR/LF cookie, and Chromium itself refuses it, with
// trawl's fixed message; no part of the value appears anywhere.
test("render() with a CR/LF cookie value and a real browser: fixed message, no leak", browserOpts, async () => {
	const srv = await bytesServer();
	try {
		const err = await render(`${srv.origin}/`, {
			format: "title",
			pacing: false,
			authCheck: false,
			cookies: [libCookie("lib", "LIBLEAK\r\nX-Injected: 1")],
		}).catch((e) => e);
		assert.match(err.message, /^could not add cookies to the browser; the page was not fetched/);
		for (const t of errorText(err)) assert.ok(!t.includes("LIBLEAK") && !t.includes("Injected"), t);
		assert.deepEqual(srv.seen.map((s) => [s.url, s.cookie]), [["/robots.txt", null]]);
	} finally {
		await srv.close();
	}
});

// --- #93: partitioned (CHIPS) cookies, against real Chromium ---

// The issue's reproduction. A page on `127.0.0.1` iframes `localhost`, which
// sets a partitioned cookie: it lands in `localhost`'s jar under the
// `127.0.0.1` partition. A top-level visit to `localhost` sets an ordinary
// cookie and one partitioned under its own site. Then the profile's own
// top-level request to `localhost` is recorded, and the robots.txt request
// that render() makes from the same profile must carry exactly those cookies.
// `scheme` is "https" (self-signed; the Secure rule passes on its own, so this
// is what fails without the partition rule) or "http" (loopback, where the
// jar's own Secure exception applies too).
async function partitionRig(scheme) {
	const seen = [];
	let port;
	const handler = (req, res) => {
		const host = req.headers.host?.split(":")[0];
		seen.push({ host, url: req.url, cookie: req.headers.cookie ?? "" });
		const headers = { "content-type": "text/html" };
		if (req.url === "/embed") {
			res.writeHead(200, headers);
			return res.end(`<!doctype html><iframe src="${scheme}://localhost:${port}/setter"></iframe>`);
		}
		if (req.url === "/setter") {
			headers["set-cookie"] = ["part=PARTITIONED-x9; Secure; SameSite=None; Partitioned; Path=/; Max-Age=3600"];
		}
		if (req.url === "/own") {
			headers["set-cookie"] = [
				"unpart=U; Path=/; Max-Age=3600",
				"ownpart=O; Secure; SameSite=None; Partitioned; Path=/; Max-Age=3600",
			];
		}
		if (req.url === "/robots.txt") {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("User-agent: *\nDisallow:\n");
		}
		res.writeHead(200, headers);
		res.end("<!doctype html><title>t</title><p>loaded</p>");
	};
	const server = scheme === "https" ? createHttpsServer(selfSignedCert(), handler) : createServer(handler);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	port = server.address().port;
	return {
		seen,
		origin: `${scheme}://localhost:${port}`,
		embed: `${scheme}://127.0.0.1:${port}/embed`,
		close: () => new Promise((r) => server.close(r)),
	};
}

// Fills `profile` as described above and returns the cookies (sorted) the
// browser itself sends on a top-level request to the site.
async function seedPartitionedProfile(rig, profile) {
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: resolveExecutablePath(),
		headless: true,
		ignoreHTTPSErrors: true,
	});
	try {
		const page = await context.newPage();
		await page.goto(`${rig.origin}/own`, { waitUntil: "load" });
		await page.goto(rig.embed, { waitUntil: "load" });
		const jar = await context.cookies(`${rig.origin}/robots.txt`);
		const part = jar.find((c) => c.name === "part");
		// Without this the test would pass vacuously.
		assert.ok(part, `no partitioned cookie in the jar: ${JSON.stringify(jar.map((c) => c.name))}`);
		assert.equal(typeof part.partitionKey, "string");
		assert.match(part.partitionKey, /^https?:\/\/127\.0\.0\.1$/);
		rig.seen.length = 0;
		await page.goto(`${rig.origin}/top`, { waitUntil: "load" });
		const top = rig.seen.find((s) => s.url === "/top");
		return top.cookie.split("; ").filter(Boolean).sort();
	} finally {
		await context.close();
	}
}

test("profileDir: a third-party partitioned cookie is not sent to robots.txt (https, self-signed)", browserOpts, async () => {
	const rig = await partitionRig("https");
	const dir = tempDir();
	try {
		const profile = join(dir, "p");
		const browserSends = await seedPartitionedProfile(rig, profile);
		assert.deepEqual(browserSends, ["ownpart=O", "unpart=U"]);
		// Node fetch would refuse the self-signed certificate, so the robots
		// request is captured by an injected fetch; it disallows, so render()
		// stops before the page (which would need ignoreHTTPSErrors).
		const sent = [];
		const err = await render(`${rig.origin}/page`, {
			format: "title",
			pacing: false,
			authCheck: false,
			profileDir: profile,
			fetch: async (url, init) => {
				sent.push([url, init.headers.Cookie]);
				return robotsResponse(200, "User-agent: *\nDisallow: /\n");
			},
		}).catch((e) => e);
		assert.equal(err?.message, "robots.txt disallows this path (Disallow: /). Use --ignore-robots to override.");
		assert.equal(sent.length, 1);
		assert.equal(sent[0][0], `${rig.origin}/robots.txt`);
		assert.deepEqual(sent[0][1].split("; ").sort(), browserSends);
		assert.ok(!sent[0][1].includes("PARTITIONED-x9"), sent[0][1]);
	} finally {
		await rig.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("profileDir: on loopback http, robots.txt gets what the page gets, partitioned cookies included or not alike", browserOpts, async () => {
	const rig = await partitionRig("http");
	const dir = tempDir();
	try {
		const profile = join(dir, "p");
		const browserSends = await seedPartitionedProfile(rig, profile);
		// Secure cookies go to http://localhost (Chromium's loopback rule).
		assert.deepEqual(browserSends, ["ownpart=O", "unpart=U"]);
		rig.seen.length = 0;
		const result = await render(`${rig.origin}/page`, { format: "title", pacing: false, authCheck: false, profileDir: profile });
		assert.equal(result.body, "t");
		const robots = rig.seen.find((s) => s.url === "/robots.txt");
		const page = rig.seen.find((s) => s.url === "/page");
		assert.deepEqual(robots.cookie.split("; ").sort(), browserSends);
		assert.deepEqual(page.cookie.split("; ").sort(), browserSends);
	} finally {
		await rig.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
