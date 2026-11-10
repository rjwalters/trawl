import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addCookiesFailure,
	AUTH_COOKIES,
	browserWouldReject,
	CookieParseError,
	cookieHeaderFor,
	filterCookies,
	isAuthCookie,
	MAX_EXPIRES,
	parseCookies,
	robotsCookieHeader,
	sourceUserAgent,
	summarize,
	whyNoneLeft,
} from "../src/cookies.mjs";

const SENTINEL = "SENTINEL-s3cr3t-VALUE";
const NOW = Date.parse("2026-06-01T00:00:00Z");
const FUTURE = "2030-01-01T00:00:00Z";
const FUTURE_SEC = Date.parse(FUTURE) / 1000;

const harEntry = (url, reqCookie, setCookies = []) => ({
	startedDateTime: "2026-06-01T00:00:00Z",
	request: {
		url,
		headers: reqCookie ? [{ name: "Cookie", value: reqCookie }] : [],
	},
	response: {
		headers: setCookies.map((v) => ({ name: "Set-Cookie", value: v })),
	},
});
const har = (...entries) => JSON.stringify({ log: { version: "1.2", entries } });

// Firefox-style HAR: request.cookies populated, header present.
const FIREFOX_HAR = har(
	harEntry("https://www.example.com/a", `theme=dark; tok=${SENTINEL}`, [
		`tok=${SENTINEL}; Domain=example.com; Path=/app; Expires=Wed, 01 Jan 2030 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`,
	]),
);
// Chrome-style HAR: request cookies only in `cookies` array, no Cookie header.
const CHROME_HAR = JSON.stringify({
	log: {
		entries: [
			{
				startedDateTime: "2026-06-01T00:00:00Z",
				request: {
					url: "http://plain.test/x",
					headers: [],
					cookies: [{ name: "a", value: SENTINEL }],
				},
				response: { headers: [], cookies: [] },
			},
		],
	},
});
const NETSCAPE = [
	"# Netscape HTTP Cookie File",
	"# comment line",
	"",
	`.example.com\tTRUE\t/\tTRUE\t${FUTURE_SEC}\tkeep\t${SENTINEL}`,
	`#HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\tpref\t${SENTINEL}`,
	`host.test\tFALSE\t/p\tFALSE\t100\told\t${SENTINEL}`,
].join("\n");
const CURL = `curl 'https://shop.example.com/cart' \\
  -H 'Accept: */*' \\
  -H 'Cookie: a=1; tok=${SENTINEL}' \\
  -b "b=2" --compressed`;

const names = (cs) => cs.map((c) => c.name);

test("Firefox HAR: Set-Cookie attributes win over request Cookie", () => {
	const cs = parseCookies(FIREFOX_HAR);
	assert.equal(cs.length, 2);
	const tok = cs.find((c) => c.name === "tok");
	assert.deepEqual(tok, {
		name: "tok",
		value: SENTINEL,
		domain: ".example.com",
		path: "/app",
		expires: FUTURE_SEC,
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
	});
	const theme = cs.find((c) => c.name === "theme");
	assert.equal(theme.domain, "www.example.com");
	assert.equal(theme.path, "/");
	assert.equal(theme.expires, -1);
	assert.equal(theme.secure, true);
	assert.equal(theme.sameSite, undefined);
});

test("Chrome HAR: request.cookies fallback, http means not secure", () => {
	const [c] = parseCookies(CHROME_HAR);
	assert.equal(c.domain, "plain.test");
	assert.equal(c.secure, false);
	assert.equal(c.expires, -1);
});

test("Max-Age is relative to startedDateTime and beats Expires", () => {
	const [c] = parseCookies(
		har(
			harEntry("https://a.test/", null, [
				"x=1; Max-Age=3600; Expires=Wed, 01 Jan 2000 00:00:00 GMT",
			]),
		),
	);
	assert.equal(c.expires, Date.parse("2026-06-01T01:00:00Z") / 1000);
});

test("Netscape: HttpOnly prefix, comments, dot handling, session", () => {
	const cs = parseCookies(NETSCAPE);
	assert.deepEqual(names(cs), ["keep", "pref", "old"]);
	assert.equal(cs[0].domain, ".example.com");
	assert.equal(cs[0].secure, true);
	assert.equal(cs[1].httpOnly, true);
	assert.equal(cs[1].domain, ".example.com");
	assert.equal(cs[1].expires, -1);
	assert.equal(cs[2].domain, "host.test");
	assert.equal(cs[2].path, "/p");
});

test("Netscape with CRLF line endings", () => {
	const cs = parseCookies(NETSCAPE.replace(/\n/g, "\r\n"));
	assert.deepEqual(names(cs), ["keep", "pref", "old"]);
	assert.equal(cs[0].value, SENTINEL);
});

test("cURL: -H Cookie, -b, quoting and line continuations", () => {
	const cs = parseCookies(CURL);
	assert.deepEqual(names(cs), ["a", "tok", "b"]);
	assert.equal(cs[0].domain, "shop.example.com");
	assert.equal(cs[0].secure, true);
	assert.equal(cs[1].value, SENTINEL);
});

test("cURL: $'...' strings and attached -b", () => {
	const cs = parseCookies(`curl http://h.test/ -H $'Cookie: q=a\\x41\\tb' -bz=9`);
	assert.deepEqual(
		cs.map((c) => [c.name, c.value]),
		[
			["q", "aA\tb"],
			["z", "9"],
		],
	);
});

test("cURL without URL or with no cookies", () => {
	assert.throws(() => parseCookies("curl -H 'Cookie: a=1'"), CookieParseError);
	assert.deepEqual(parseCookies("curl https://x.test/"), []);
});

test("edge: empty HAR and HAR without cookies yield []", () => {
	assert.deepEqual(parseCookies(har()), []);
	assert.deepEqual(parseCookies(har(harEntry("https://a.test/", null))), []);
});

test("edge: empty, malformed JSON, non-HAR JSON, unrecognised all throw", () => {
	for (const bad of ["", "   \n", '{"log": ', '{"a":1}', "hello world"]) {
		assert.throws(() => parseCookies(bad), CookieParseError);
	}
});

test("edge: duplicate names across domains are all kept", () => {
	const cs = parseCookies(
		har(
			harEntry("https://a.test/", "n=1"),
			harEntry("https://b.test/", "n=2"),
		),
	);
	assert.deepEqual(
		cs.map((c) => [c.name, c.domain]),
		[
			["n", "a.test"],
			["n", "b.test"],
		],
	);
});

test("edge: SameSite=None without Secure is downgraded to Lax", () => {
	const [loose] = parseCookies(
		har(harEntry("http://a.test/", null, ["x=1; SameSite=None"])),
	);
	assert.equal(loose.secure, false);
	assert.equal(loose.sameSite, "Lax");
	const [ok] = parseCookies(
		har(harEntry("https://a.test/", null, ["x=1; SameSite=none; Secure"])),
	);
	assert.equal(ok.sameSite, "None");
});

test("edge: non-ASCII values round trip verbatim", () => {
	const [c] = parseCookies(har(harEntry("https://a.test/", "n=héllo✓%C3%A9")));
	assert.equal(c.value, "héllo✓%C3%A9");
});

test("filters: auth cookies dropped by default, includeAuth keeps them", () => {
	const cs = parseCookies(
		har(harEntry("https://google.com/", "SID=1; NID=2; AEC=3; __Secure-ENID=4; keep=5")),
	);
	const r = filterCookies(cs, { now: NOW });
	assert.deepEqual(names(r.cookies), ["NID", "AEC", "__Secure-ENID", "keep"]);
	assert.deepEqual(names(r.authDropped), ["SID"]);
	assert.equal(filterCookies(cs, { now: NOW, includeAuth: true }).cookies.length, 5);
});

test("auth deny list covers the Google family", () => {
	for (const n of [
		"SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID",
		"__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PSIDCC",
		"__Secure-1PSIDTS", "__Secure-3PSIDTS", "SIDCC", "PHPSESSID",
	]) {
		assert.ok(isAuthCookie(n), n);
	}
	for (const n of ["NID", "AEC", "__Secure-ENID", "theme"]) {
		assert.ok(!isAuthCookie(n), n);
	}
});

test("test is sensitive to the auth constant: emptied list drops nothing", () => {
	assert.ok(AUTH_COOKIES.names.length > 0 && AUTH_COOKIES.patterns.length > 0);
	const cs = parseCookies(har(harEntry("https://g.test/", "SID=1; __Secure-1PSID=2")));
	assert.equal(filterCookies(cs, { now: NOW }).cookies.length, 0);
	const savedNames = AUTH_COOKIES.names.splice(0);
	const savedPatterns = AUTH_COOKIES.patterns.splice(0);
	try {
		assert.equal(filterCookies(cs, { now: NOW }).cookies.length, 2);
	} finally {
		AUTH_COOKIES.names.push(...savedNames);
		AUTH_COOKIES.patterns.push(...savedPatterns);
	}
	assert.equal(filterCookies(cs, { now: NOW }).cookies.length, 0);
});

test("filters: domain matching incl. notexample.com negative", () => {
	const mk = (domain) => ({
		name: "n",
		value: "v",
		domain,
		path: "/",
		expires: -1,
		httpOnly: false,
		secure: false,
	});
	const cs = [
		mk(".example.com"),
		mk("www.example.com"),
		mk("notexample.com"),
		mk("other.test"),
		mk("a.www.example.com"),
	];
	const got = (domain) =>
		filterCookies(cs, { domain, now: NOW }).cookies.map((c) => c.domain);
	assert.deepEqual(got("example.com"), [".example.com", "www.example.com", "a.www.example.com"]);
	assert.deepEqual(got(".www.example.com"), [".example.com", "www.example.com", "a.www.example.com"]);
	assert.deepEqual(got("notexample.com"), ["notexample.com"]);
});

test("filters: allow is exact-name, applied after domain", () => {
	const cs = parseCookies(
		har(
			harEntry("https://a.test/", "keep=1; other=2; keepx=3"),
			harEntry("https://b.test/", "keep=4"),
		),
	);
	const r = filterCookies(cs, { domain: "a.test", allow: ["keep"], now: NOW });
	assert.deepEqual(
		r.cookies.map((c) => [c.name, c.domain]),
		[["keep", "a.test"]],
	);
});

test("filters: matched counts what --domain/--allow left, before expiry and auth", () => {
	const cs = parseCookies(
		har(harEntry("https://a.test/", "keep=1; SID=2; other=3"), harEntry("https://b.test/", "keep=4")),
	);
	assert.equal(filterCookies(cs, { now: NOW }).matched, 4);
	const r = filterCookies(cs, { domain: "a.test", allow: ["keep", "SID"], now: NOW });
	assert.equal(r.matched, 2);
	assert.equal(r.cookies.length, 1);
	assert.equal(filterCookies(cs, { domain: "c.test", now: NOW }).matched, 0);
});

test("browserWouldReject mirrors Chromium's cookie checks", () => {
	const ok = { name: "a", value: 'v"\\/+=', domain: "example.com", path: "/", secure: true };
	assert.equal(browserWouldReject(ok), false);
	assert.equal(browserWouldReject({ ...ok, name: "" }), false);
	assert.equal(browserWouldReject({ ...ok, name: "__Host-a" }), false);
	for (const bad of [
		{ value: "x;y" },
		{ name: "a=b" },
		{ value: "x\ny" },
		{ name: "a\u0001" },
		{ value: " v" },
		{ name: "", value: "" },
		{ value: "x".repeat(4096) },
		{ value: "é".repeat(2048) },
		{ path: "x" },
		{ path: "/a;b" },
		{ path: `/${"p".repeat(1024)}` },
		{ domain: " " },
		{ name: "__Secure-a", secure: false },
		{ name: "__HOST-a", path: "/x" },
		{ name: "__Host-a", domain: ".example.com" },
		{ name: "", value: "__Host-x", secure: false },
		{ name: "", value: "__Host-x" },
		{ name: "", value: "__SECURE-x" },
		{ name: "", value: "__Http-x", secure: false },
		{ name: "", value: "__http-x", httpOnly: true },
		{ name: "__Http-a" },
		{ name: "__HTTP-a", httpOnly: true, secure: false },
		{ name: "__Host-Http-a" },
		{ name: "__host-http-a", httpOnly: true, path: "/x" },
		{ domain: "::1" },
		{ domain: ".::1" },
		{ domain: "2001:db8::1" },
	]) {
		assert.equal(browserWouldReject({ ...ok, ...bad }), true, JSON.stringify(bad));
	}
	for (const fine of [
		{ name: "__Http-a", httpOnly: true },
		{ name: "__Host-Http-a", httpOnly: true },
		{ name: "__Secure-Http-a" },
		{ domain: "[::1]" },
		{ domain: "127.0.0.1" },
	]) {
		assert.equal(browserWouldReject({ ...ok, ...fine }), false, JSON.stringify(fine));
	}
});

test("addCookiesFailure returns only fixed detail, and survives a hostile error", () => {
	assert.equal(
		addCookiesFailure(new Error("browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields\nCall log: x")),
		"the browser refused a cookie, and so the whole batch",
	);
	assert.equal(addCookiesFailure(new Error("Target page, context or browser has been closed")), "the browser closed unexpectedly");
	assert.equal(addCookiesFailure(new Error(`browserContext.addCookies: bad ${SENTINEL}`)), undefined);
	const getter = new Error("x");
	Object.defineProperty(getter, "message", {
		get() {
			throw new Error(SENTINEL);
		},
	});
	assert.equal(addCookiesFailure(getter), undefined);
	assert.equal(addCookiesFailure({ message: { toString() { throw new Error(SENTINEL); } } }), undefined);
	assert.equal(addCookiesFailure(undefined), undefined);
	assert.equal(addCookiesFailure("a string"), undefined);
});

test("whyNoneLeft's --include-auth hint names the command's verb", () => {
	const result = { cookies: [], authDropped: [{ name: "SID", domain: "x" }], expiredDropped: 0, matched: 1 };
	assert.equal(whyNoneLeft(1, result, 0, {}), "every cookie was a sign-in cookie (pass --include-auth to import sign-in cookies)");
	assert.equal(whyNoneLeft(1, result, 0, { verb: "use" }), "every cookie was a sign-in cookie (pass --include-auth to use sign-in cookies)");
});

test("filters: expired cookies dropped and counted; session kept", () => {
	const r = filterCookies(parseCookies(NETSCAPE), { now: NOW });
	assert.equal(r.expiredDropped, 1);
	assert.deepEqual(names(r.cookies), ["keep", "pref"]);
});

test("summarize exposes only name, domain, expires", () => {
	const s = summarize(filterCookies(parseCookies(NETSCAPE), { now: NOW }));
	assert.deepEqual(Object.keys(s).sort(), ["authDropped", "expiredDropped", "kept"]);
	for (const k of s.kept) assert.deepEqual(Object.keys(k), ["name", "domain", "expires"]);
	assert.equal(s.expiredDropped, 1);
	assert.equal(s.authDropped.count, 0);
});

test("redaction: sentinel never appears in summaries or errors", () => {
	const sources = [FIREFOX_HAR, CHROME_HAR, NETSCAPE, CURL, `${NETSCAPE}\nSID`.replace("SID", "")];
	for (const src of sources) {
		const cs = parseCookies(src);
		assert.ok(cs.some((c) => c.value === SENTINEL), "fixture carries sentinel");
		for (const opts of [{}, { includeAuth: true }]) {
			const out = JSON.stringify(summarize(filterCookies(cs, { now: NOW, ...opts })));
			assert.ok(!out.includes(SENTINEL));
		}
		assert.ok(!JSON.stringify(summarize(cs)).includes(SENTINEL));
	}
	const authHar = har(harEntry("https://a.test/", `SID=${SENTINEL}`));
	const authSummary = JSON.stringify(summarize(filterCookies(parseCookies(authHar), { now: NOW })));
	assert.ok(!authSummary.includes(SENTINEL));

	const bad = [
		`{"log": {"entries": [ ${SENTINEL}`,
		`{"x": "${SENTINEL}"}`,
		`${SENTINEL} nothing recognisable`,
		`curl -H 'Cookie: a=${SENTINEL}'`,
		`{"log":{"entries":"${SENTINEL}"}}`,
		"",
	];
	for (const src of bad) {
		let err;
		try {
			parseCookies(src);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof CookieParseError, src);
		const dump = [err.message, err.stack, JSON.stringify(err), err.cause, ...Object.values(err)].join("|");
		assert.ok(!dump.includes(SENTINEL), src);
		assert.equal(err.cause, undefined);
	}
});

// --- Regression tests for the Judge review of PR #81 ---------------------

test("auth: __Host-/__Secure- prefixes and case do not defeat the deny list", () => {
	for (const n of [
		"__Host-session", "__Host-sessionid", "__Secure-sessionid",
		"__Host-JSESSIONID", "__Secure-next-auth.session-token",
		"next-auth.session-token", "jsessionid", "phpsessid",
		"__SECURE-1PAPISID", "__secure-1PSID", "__host-GAPS", "sid", "Sapisid",
	]) {
		assert.ok(isAuthCookie(n), n);
	}
	for (const n of ["NID", "AEC", "__Secure-ENID", "__SECURE-ENID", "SIDEBAR", "nid", "sidebar", "theme"]) {
		assert.ok(!isAuthCookie(n), n);
	}
	const cs = parseCookies(
		har(harEntry("https://a.test/", "__Host-session=1; jsessionid=2; __SECURE-1PAPISID=3; SIDEBAR=4; __Secure-ENID=5")),
	);
	const r = filterCookies(cs, { now: NOW });
	assert.deepEqual(names(r.cookies), ["SIDEBAR", "__Secure-ENID"]);
	assert.deepEqual(names(r.authDropped), ["__Host-session", "jsessionid", "__SECURE-1PAPISID"]);
});

test("expiry: epoch, pre-1970 and HAR epoch dates are expired, never session or negative", () => {
	const cs = parseCookies(
		har(
			harEntry("https://a.test/", null, [
				"pref=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
				"old=1; Expires=Mon, 01 Jan 1960 00:00:00 GMT",
				"plain=1",
			]),
		),
	);
	const byName = Object.fromEntries(cs.map((c) => [c.name, c.expires]));
	assert.ok(byName.pref > 0, "epoch delete is a positive past stamp");
	assert.ok(byName.old > 0, "pre-1970 is never negative");
	assert.equal(byName.plain, -1);
	const r = filterCookies(cs, { now: NOW });
	assert.equal(r.expiredDropped, 2);
	assert.deepEqual(names(r.cookies), ["plain"]);

	const harJson = JSON.stringify({
		log: {
			entries: [
				{
					startedDateTime: "2026-06-01T00:00:00Z",
					request: { url: "https://a.test/", headers: [] },
					response: {
						headers: [],
						cookies: [
							{ name: "z", value: "v", expires: "1970-01-01T00:00:00.000Z" },
							{ name: "n", value: "v", expires: "1950-01-01T00:00:00.000Z" },
						],
					},
				},
			],
		},
	});
	const h = filterCookies(parseCookies(harJson), { now: NOW });
	assert.equal(h.expiredDropped, 2);
	assert.equal(h.cookies.length, 0);
});

test("expiry: values above Playwright's maximum are clamped; Netscape 0 is session", () => {
	assert.equal(MAX_EXPIRES, 253402300799);
	const ns = parseCookies(
		[
			"# Netscape HTTP Cookie File",
			"a.test\tFALSE\t/\tFALSE\t999999999999\tbig\tv",
			"a.test\tFALSE\t/\tFALSE\t0\tsess\tv",
		].join("\n"),
	);
	assert.equal(ns[0].expires, MAX_EXPIRES);
	assert.equal(ns[1].expires, -1);
	const [age] = parseCookies(
		har(harEntry("https://a.test/", null, [`m=1; Max-Age=${"9".repeat(400)}`])),
	);
	assert.equal(age.expires, MAX_EXPIRES);
	// Nothing emitted can be rejected by addCookies' expires assertion.
	for (const c of [...ns, age]) {
		assert.ok(!(c.expires < 0 && c.expires !== -1) && c.expires <= MAX_EXPIRES, c.name);
	}
});

test("expiry: an expiry exactly at now counts as expired", () => {
	const c = { name: "n", value: "v", domain: "a.test", path: "/", expires: NOW / 1000, httpOnly: false, secure: false };
	assert.equal(filterCookies([c], { now: NOW }).expiredDropped, 1);
});

test("expiry: empty or non-numeric Max-Age is ignored, not expired", () => {
	const cs = parseCookies(
		har(
			harEntry("https://a.test/", null, [
				"e=1; Max-Age=",
				"f=1; Max-Age=abc; Expires=Wed, 01 Jan 2030 00:00:00 GMT",
				"g=1; Max-Age=0",
			]),
		),
	);
	const byName = Object.fromEntries(cs.map((c) => [c.name, c.expires]));
	assert.equal(byName.e, -1);
	assert.equal(byName.f, FUTURE_SEC);
	const r = filterCookies(cs, { now: NOW });
	assert.deepEqual(names(r.cookies), ["e", "f"]);
	assert.equal(r.expiredDropped, 1);
});

test("cURL: value-taking options are never taken as the URL", () => {
	const domains = (cmd) => parseCookies(cmd).map((c) => c.domain);
	assert.deepEqual(domains("curl -c jar.txt https://a.test/ -b 'x=1'"), ["a.test"]);
	assert.deepEqual(domains("curl --cookie-jar jar.txt https://a.test/ -b x=1"), ["a.test"]);
	for (const opt of ["-D", "-T", "-E", "--key", "--cacert", "--resolve", "-r", "-C", "-U", "-y", "-Y", "-z", "--retry", "--limit-rate"]) {
		assert.deepEqual(domains(`curl ${opt} some.value https://a.test/ -b x=1`), ["a.test"], opt);
	}
	// Bundled short flags ending in a value-taking one, and an attached value.
	assert.deepEqual(domains("curl -sSc jar.txt https://a.test/ -b x=1"), ["a.test"]);
	assert.deepEqual(domains("curl -cjar.txt https://a.test/ -b x=1"), ["a.test"]);
	assert.deepEqual(domains("curl -sb x=1 https://a.test/"), ["a.test"]);
	// A non-http(s) positional is not a URL; --url may omit the scheme.
	assert.deepEqual(domains("curl unknown.opt.value https://a.test/ -b x=1"), ["a.test"]);
	assert.deepEqual(domains("curl --url a.test -b x=1"), ["a.test"]);
	assert.throws(() => parseCookies("curl -c jar.txt -b x=1"), CookieParseError);
	assert.throws(() => parseCookies("curl ftp://a.test/ -b x=1"), CookieParseError);
});

test("authDropped carries names and domains only, never values", () => {
	const cs = parseCookies(har(harEntry("https://a.test/", `SID=${SENTINEL}`)));
	const r = filterCookies(cs, { now: NOW });
	assert.deepEqual(r.authDropped, [{ name: "SID", domain: "a.test" }]);
	assert.ok(!JSON.stringify(r.authDropped).includes(SENTINEL));
});

test("filters: example.com does not match a bare public-suffix cookie", () => {
	const mk = (domain) => ({ name: "n", value: "v", domain, path: "/", expires: -1, httpOnly: false, secure: false });
	const cs = [mk("com"), mk(".com"), mk("example.com"), mk("localhost")];
	const got = (domain) => filterCookies(cs, { domain, now: NOW }).cookies.map((c) => c.domain);
	assert.deepEqual(got("example.com"), ["example.com"]);
	assert.deepEqual(got("localhost"), ["localhost"]);
});

test("HAR: Set-Cookie vs request cookie merge is independent of entry order", () => {
	const setEntry = harEntry("https://www.example.com/", null, ["t=new; Domain=example.com; Secure"]);
	const reqEntry = harEntry("https://www.example.com/", "t=old");
	for (const entries of [
		[setEntry, reqEntry],
		[reqEntry, setEntry],
	]) {
		const cs = parseCookies(har(...entries));
		assert.deepEqual(
			cs.map((c) => [c.name, c.domain, c.value]),
			[["t", ".example.com", "new"]],
		);
	}
});

// --- sourceUserAgent (#77) ---

test("sourceUserAgent reads the first request User-Agent from a HAR", () => {
	const har = JSON.stringify({
		log: {
			entries: [
				{ request: { url: "https://a.example/", headers: [] } },
				{ request: { url: "https://a.example/x", headers: [{ name: "user-agent", value: " UA/1 " }] } },
				{ request: { url: "https://a.example/y", headers: [{ name: "User-Agent", value: "UA/2" }] } },
			],
		},
	});
	assert.equal(sourceUserAgent(har), "UA/1");
});

test("sourceUserAgent reads -A, --user-agent and -H from a cURL command", () => {
	assert.equal(sourceUserAgent("curl https://a.example -A 'Fx/1'"), "Fx/1");
	assert.equal(sourceUserAgent("curl --user-agent \"Fx/2\" https://a.example"), "Fx/2");
	assert.equal(sourceUserAgent("curl -sSAFx/3 https://a.example"), "Fx/3");
	assert.equal(sourceUserAgent("curl https://a.example -H 'user-agent: Fx/4' -H 'Accept: */*'"), "Fx/4");
	// A cookie value that looks like a flag is not mistaken for one.
	assert.equal(sourceUserAgent("curl https://a.example -b '-A=x' -H 'Cookie: a=-A'"), null);
	assert.equal(sourceUserAgent("curl https://a.example"), null);
});

test("sourceUserAgent is null for cookies.txt and for anything unparseable", () => {
	assert.equal(sourceUserAgent(`# Netscape HTTP Cookie File\n.a.example\tTRUE\t/\tFALSE\t0\tn\t${SENTINEL}\n`), null);
	assert.equal(sourceUserAgent(`{"log": ${SENTINEL}`), null);
	assert.equal(sourceUserAgent('{"log": {}}'), null);
	assert.equal(sourceUserAgent(""), null);
	assert.equal(sourceUserAgent(undefined), null);
});

// --- cookieHeaderFor (#79): the Cookie header for the robots.txt request ---

const ck = (name, value, domain, extra = {}) => ({
	name,
	value,
	domain,
	path: "/",
	expires: -1,
	httpOnly: false,
	secure: false,
	...extra,
});
const ROBOTS = "https://example.com/robots.txt";

test("cookieHeaderFor: host-only vs leading-dot domains", () => {
	const hostOnly = [ck("h", "1", "example.com")];
	const dotted = [ck("d", "2", ".example.com")];
	assert.equal(cookieHeaderFor(hostOnly, ROBOTS), "h=1");
	assert.equal(cookieHeaderFor(hostOnly, "https://www.example.com/robots.txt"), undefined);
	assert.equal(cookieHeaderFor(dotted, ROBOTS), "d=2");
	assert.equal(cookieHeaderFor(dotted, "https://www.example.com/robots.txt"), "d=2");
	assert.equal(cookieHeaderFor(dotted, "https://a.b.example.com/robots.txt"), "d=2");
	for (const list of [hostOnly, dotted]) {
		assert.equal(cookieHeaderFor(list, "https://notexample.com/robots.txt"), undefined);
		assert.equal(cookieHeaderFor(list, "https://example.com.evil.org/robots.txt"), undefined);
	}
	// A subdomain cookie never goes to its parent.
	assert.equal(cookieHeaderFor([ck("s", "3", ".www.example.com")], ROBOTS), undefined);
	// Case-insensitive on both sides.
	assert.equal(cookieHeaderFor([ck("c", "4", ".Example.COM")], "https://WWW.example.com/robots.txt"), "c=4");
});

test("cookieHeaderFor: single-label domains and IP hosts match exactly only", () => {
	assert.equal(cookieHeaderFor([ck("a", "1", ".com")], ROBOTS), undefined);
	assert.equal(cookieHeaderFor([ck("a", "1", ".test")], "http://test/robots.txt"), "a=1");
	assert.equal(cookieHeaderFor([ck("a", "1", "127.0.0.1")], "http://127.0.0.1:8080/robots.txt"), "a=1");
	assert.equal(cookieHeaderFor([ck("a", "1", ".0.0.1")], "http://127.0.0.1/robots.txt"), undefined);
	assert.equal(cookieHeaderFor([ck("a", "1", "127.0.0.1")], "http://127.0.0.10/robots.txt"), undefined);
});

test("cookieHeaderFor: RFC 6265 path-match", () => {
	const at = (path) => cookieHeaderFor([ck("p", "1", "example.com", { path })], ROBOTS);
	assert.equal(at("/"), "p=1");
	assert.equal(at("/robots.txt"), "p=1");
	assert.equal(at("/robots"), undefined);
	assert.equal(at("/foo"), undefined);
	assert.equal(at("/robots.txt/"), undefined);
	// Not hard-wired to /robots.txt.
	const deep = [ck("p", "1", "example.com", { path: "/a/b" })];
	assert.equal(cookieHeaderFor(deep, "https://example.com/a/b/c"), "p=1");
	assert.equal(cookieHeaderFor(deep, "https://example.com/a/bc"), undefined);
	assert.equal(cookieHeaderFor([ck("p", "1", "example.com", { path: "/a/" })], "https://example.com/a/x"), "p=1");
});

test("cookieHeaderFor: a secure cookie only over https", () => {
	const list = [ck("s", "1", "example.com", { secure: true }), ck("p", "2", "example.com")];
	assert.equal(cookieHeaderFor(list, ROBOTS), "s=1; p=2");
	assert.equal(cookieHeaderFor(list, "http://example.com/robots.txt"), "p=2");
	// No special case for localhost.
	assert.equal(cookieHeaderFor([ck("s", "1", "localhost", { secure: true })], "http://localhost/robots.txt"), undefined);
});

test("cookieHeaderFor: expiry (past, future, session)", () => {
	const now = NOW;
	const nowSec = now / 1000;
	const list = [
		ck("past", "1", "example.com", { expires: nowSec - 1 }),
		ck("now", "2", "example.com", { expires: nowSec }),
		ck("future", "3", "example.com", { expires: nowSec + 60 }),
		ck("session", "4", "example.com", { expires: -1 }),
	];
	assert.equal(cookieHeaderFor(list, ROBOTS, { now }), "future=3; session=4");
	assert.equal(cookieHeaderFor(list.slice(0, 2), ROBOTS, { now }), undefined);
});

test("cookieHeaderFor: longer paths first, ties in input order, raw values, nameless cookies", () => {
	const list = [
		ck("b", "x=y", "example.com"),
		ck("long", "1", "example.com", { path: "/robots.txt" }),
		ck("", "bare", ".example.com"),
		ck("a", '"q"%20', "example.com"),
		ck("httponly", "h", "example.com", { httpOnly: true, sameSite: "Strict" }),
	];
	assert.equal(cookieHeaderFor(list, ROBOTS), 'long=1; b=x=y; bare; a="q"%20; httponly=h');
});

test("cookieHeaderFor: no match, empty or junk input is undefined", () => {
	assert.equal(cookieHeaderFor([], ROBOTS), undefined);
	assert.equal(cookieHeaderFor(undefined, ROBOTS), undefined);
	assert.equal(cookieHeaderFor([ck("a", "1", "other.org")], ROBOTS), undefined);
	assert.equal(cookieHeaderFor([ck("a", "1", "example.com")], "not a url"), undefined);
});

// --- #87: only ever a header value Node's fetch accepts ---

// Node's own check, not a copy of its rule: `Headers.append` throws on any
// value fetch would refuse (on Node 22, 24 and 26 alike: NUL, CR, LF and
// anything above U+00FF).
function fetchAccepts(value) {
	try {
		new Headers().append("cookie", value);
		return true;
	} catch {
		return false;
	}
}

// Every code unit up to U+02FF, the ends of the BMP, both surrogate halves
// alone, and astral characters.
const PROBES = [
	...Array.from({ length: 0x300 }, (_, c) => String.fromCharCode(c)),
	" ", "☃", "﻿", "￿", "\ud800", "\udfff", "\u{1f600}", "\u{10ffff}",
];

test("cookieHeaderFor: every character, in a name or a value, yields a value fetch accepts", () => {
	for (const ch of PROBES) {
		for (const cookie of [ck("n", `a${ch}b`, "example.com"), ck(`n${ch}m`, "v", "example.com"), ck("", `${ch}x`, "example.com")]) {
			const header = cookieHeaderFor([cookie, ck("ok", "1", "example.com")], ROBOTS);
			assert.ok(fetchAccepts(header), `U+${ch.codePointAt(0).toString(16)} gave an unacceptable header`);
			// The other cookie always goes, whatever happened to this one.
			assert.match(header, /(^|; )ok=1$/);
		}
	}
});

test("cookieHeaderFor: a control character leaves that cookie out, by name or value", () => {
	const controls = [...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)), "\u007f"];
	for (const ch of controls) {
		const list = [ck("v", `SECRET${ch}x`, "example.com"), ck(`n${ch}`, "SECRET2", "example.com"), ck("ok", "1", "example.com")];
		const { header, omitted } = robotsCookieHeader(list, ROBOTS);
		assert.equal(header, "ok=1", `U+${ch.charCodeAt(0).toString(16)}`);
		assert.deepEqual(omitted, ["v", `n${ch}`]);
	}
	// None left: no header at all, and the names say why.
	const crlf = robotsCookieHeader([ck("lib", "LIBLEAK\r\nX-Injected: 1", "example.com")], ROBOTS);
	assert.deepEqual(crlf, { header: undefined, omitted: ["lib"] });
	assert.equal(cookieHeaderFor([ck("lib", "a\u0000b", "example.com")], ROBOTS), undefined);
	// Only cookies that would have been sent are reported.
	assert.deepEqual(robotsCookieHeader([ck("far", "a\nb", "other.org")], ROBOTS).omitted, []);
});

test("robotsCookieHeader: `;` in a name or value, or `=` in a name, leaves that cookie out", () => {
	const list = [
		ck("lib", "LIBLEAK; injected=1", "example.com"),
		ck("a=b", "LIBLEAK", "example.com"),
		ck("semi;name", "x", "example.com"),
		ck("eq", "v=w", "example.com"),
		ck("ok", "fine", "example.com"),
	];
	const { header, omitted } = robotsCookieHeader(list, ROBOTS);
	assert.deepEqual(omitted, ["lib", "a=b", "semi;name"]);
	// `=` in a value is valid and still sent.
	assert.equal(header, "eq=v=w; ok=fine");
});

test("cookieHeaderFor: non-ASCII goes as its UTF-8 bytes, as Chromium sends it on the page request", () => {
	// Chromium 156 sends these exact bytes for these values (see the README):
	// `café` is 63 61 66 c3 a9 on the page request, not latin-1's single e9.
	const cases = [
		["café", "636166c3a9"],
		["ÿ\u0080x", "c3bfc28078"],
		["snow☃man", "736e6f77e298836d616e"],
		["e\u{1f600}", "65f09f9880"],
		["a\ud800b", "61efbfbd62"],
	];
	for (const [value, hex] of cases) {
		const header = cookieHeaderFor([ck("k", value, "example.com")], ROBOTS);
		assert.equal(Buffer.from(header, "latin1").toString("hex"), Buffer.from("k=", "latin1").toString("hex") + hex);
		assert.ok(fetchAccepts(header));
	}
	// Names too; ASCII-only headers are unchanged byte for byte.
	assert.equal(cookieHeaderFor([ck("né", "1", "example.com")], ROBOTS), "nÃ©=1");
	assert.equal(cookieHeaderFor([ck("a", '"q"%20', "example.com")], ROBOTS), 'a="q"%20');
});
