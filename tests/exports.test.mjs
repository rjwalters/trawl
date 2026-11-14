// The published surface, exercised through the package name rather than a
// relative path, so what is tested is the `exports` map in package.json.
// A relative import would pass even if the package exported nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AuthWallError,
	browserWouldReject,
	ClickError,
	CooldownError,
	CookieParseError,
	filterCookies,
	parseCookies,
	render,
} from "@rjwalters/trawl";

const SENTINEL = "SENTINEL-s3cr3t-VALUE";
const NOW = Date.parse("2026-06-01T00:00:00Z");
const FUTURE_SEC = Date.parse("2030-01-01T00:00:00Z") / 1000;

// One cookie of each kind the pipeline is supposed to deal with: a plain
// keeper, a sign-in cookie (dropped unless `includeAuth`), a `__Secure-`
// cookie without Secure (parses, survives filtering, refused by Chromium),
// one past its expiry, and one on another domain.
const COOKIES_TXT = [
	"# Netscape HTTP Cookie File",
	`.example.com\tTRUE\t/\tTRUE\t${FUTURE_SEC}\tprefs\t${SENTINEL}`,
	`.example.com\tTRUE\t/\tTRUE\t${FUTURE_SEC}\tsessionid\t${SENTINEL}`,
	`.example.com\tTRUE\t/\tFALSE\t${FUTURE_SEC}\t__Secure-nope\t${SENTINEL}`,
	`.example.com\tTRUE\t/\tTRUE\t100\tstale\t${SENTINEL}`,
	`other.test\tFALSE\t/\tFALSE\t${FUTURE_SEC}\telsewhere\t${SENTINEL}`,
].join("\n");

const names = (cs) => cs.map((c) => c.name).sort();

test("the cookie helpers the README names are importable from the package", () => {
	assert.equal(typeof parseCookies, "function");
	assert.equal(typeof filterCookies, "function");
	assert.equal(typeof browserWouldReject, "function");
	assert.equal(typeof CookieParseError, "function");
	const err = new CookieParseError("unrecognised");
	assert.ok(err instanceof Error);
	assert.equal(err.name, "CookieParseError");
});

test("CookieParseError from the package matches what parseCookies throws", () => {
	// `instanceof` across the package boundary is the point: a library caller
	// cannot tell a parse failure from a bug otherwise.
	assert.throws(
		() => parseCookies("not a cookie source"),
		(err) => {
			assert.ok(err instanceof CookieParseError, "not an instance of the exported class");
			assert.equal(err.name, "CookieParseError");
			assert.ok(!err.message.includes("not a cookie source"), "message echoed the input");
			return true;
		},
	);
});

test("the documented pipeline turns a cookies.txt into a render-ready list", () => {
	const parsed = parseCookies(COOKIES_TXT);
	assert.deepEqual(names(parsed), ["__Secure-nope", "elsewhere", "prefs", "sessionid", "stale"]);

	const result = filterCookies(parsed, {
		domain: "example.com",
		includeAuth: true,
		now: NOW,
	});
	// filterCookies returns a report, not an array — passing it straight to
	// render() would hand Playwright a non-array.
	assert.ok(!Array.isArray(result));
	assert.ok(Array.isArray(result.cookies));
	assert.deepEqual(names(result.cookies), ["__Secure-nope", "prefs", "sessionid"]);

	const accepted = result.cookies.filter((c) => !browserWouldReject(c));
	assert.deepEqual(names(accepted), ["prefs", "sessionid"]);
	for (const c of accepted) {
		assert.deepEqual(Object.keys(c).sort(), [
			"domain",
			"expires",
			"httpOnly",
			"name",
			"path",
			"secure",
			"value",
		]);
		assert.equal(c.domain, ".example.com");
		assert.equal(c.path, "/");
		assert.equal(typeof c.expires, "number");
		assert.equal(typeof c.httpOnly, "boolean");
		assert.equal(typeof c.secure, "boolean");
	}
});

test("includeAuth is what keeps the sign-in cookie a library caller came for", () => {
	const parsed = parseCookies(COOKIES_TXT);
	const kept = filterCookies(parsed, { domain: "example.com", now: NOW });
	assert.deepEqual(names(kept.cookies), ["__Secure-nope", "prefs"]);
	assert.deepEqual(
		kept.authDropped.map((d) => d.name),
		["sessionid"],
	);
	// Value-free report: the dropped entry carries name and domain only.
	assert.deepEqual(Object.keys(kept.authDropped[0]).sort(), ["domain", "name"]);
});

test("the existing exports keep working", () => {
	assert.equal(typeof render, "function");
	for (const Err of [AuthWallError, ClickError, CooldownError]) {
		assert.equal(typeof Err, "function");
		assert.ok(Err.prototype instanceof Error);
	}
	assert.equal(new AuthWallError([]).name, "AuthWallError");
	assert.equal(new ClickError("boom", {}).name, "ClickError");
});

test("no new subpath became reachable", async () => {
	// The fix is a re-export, not a second entry point: the module file itself
	// must stay unreachable, or the narrow surface above is a fiction.
	await assert.rejects(
		() => import("@rjwalters/trawl/src/cookies.mjs"),
		(err) => {
			assert.equal(err.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
			return true;
		},
	);
});

test("the internal cookie helpers stay off the public surface", async () => {
	const trawl = await import("@rjwalters/trawl");
	// Out of scope for this entry point: display summaries, the robots header
	// helper, the empty-list explainer, and the auth-name tables.
	for (const name of [
		"AUTH_COOKIES",
		"MAX_EXPIRES",
		"addCookiesFailure",
		"cookieHeaderFor",
		"describeExpiry",
		"isAuthCookie",
		"partitionAllows",
		"printable",
		"robotsCookieHeader",
		"sourceUserAgent",
		"summarize",
		"whyNoneLeft",
	]) {
		assert.equal(trawl[name], undefined, `${name} should not be exported`);
	}
});
