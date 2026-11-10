// Parse a cookie source file (HAR, Netscape cookies.txt, copy-as-cURL) into a
// normalised cookie list, filter it, and describe it without exposing values.
//
// Pure module: no I/O, no spawning, no eval. Nothing here ever puts a cookie
// value into an error message or a summary.

import { isIPv6 } from "node:net";

/**
 * Single source of truth for cookies treated as authentication/session
 * credentials. They are dropped by default (see `filterCookies`), like
 * `FORMATS` in render.mjs: derive from this, never re-list it elsewhere.
 *
 * Matching (see `isAuthCookie`) is case-insensitive and prefix-insensitive:
 * one leading `__Secure-` / `__Host-` is stripped (browsers match those
 * prefixes case-insensitively), and both the original and the stripped name
 * are tested against every `names` entry (exact, case-insensitive, compared
 * prefix-stripped too) and every `patterns` entry (always applied
 * case-insensitively, whatever flags the literal carries). So `JSESSIONID`
 * also covers `jsessionid` and `__Host-JSESSIONID`. Conservative on purpose:
 * Google's `NID`, `AEC` and `__Secure-ENID` are preferences/anti-abuse
 * cookies and must survive. Non-Google entries are a documented best-effort
 * set, not a guarantee.
 */
export const AUTH_COOKIES = {
	names: [
		// Google account session cookies
		"SID",
		"HSID",
		"SSID",
		"APISID",
		"SAPISID",
		"SIDCC",
		"LSID",
		"OSID",
		"__Secure-OSID",
		"__Host-GAPS",
		"ACCOUNT_CHOOSER",
		// Generic frameworks
		"PHPSESSID",
		"JSESSIONID",
		"ASP.NET_SessionId",
		"connect.sid",
		"sessionid",
		"sessionid_ss",
		"sid_tt",
		// GitHub
		"user_session",
		"__Host-user_session_same_site",
		"_gh_sess",
		"logged_in",
		// Meta
		"c_user",
		"xs",
		// LinkedIn / X
		"li_at",
		"auth_token",
		// Amazon
		"at-main",
		"sess-at-main",
		"x-main",
		"session-token",
		// NextAuth / Auth.js
		"next-auth.session-token",
		"authjs.session-token",
		// Microsoft
		"MSPAuth",
		"MSPProf",
		"WLSSC",
		// Apple
		"myacinfo",
	],
	patterns: [
		/^__Secure-[13]P/, // __Secure-1PSID, __Secure-3PAPISID, __Secure-1PSIDTS, ...
		/^__Secure-.*PSID/,
		/PSID(CC|TS|RTS)?$/,
		/^(sess|session)([-_]?(id|token))?$/i,
		/_session$/i,
		/^(auth|access|refresh|id)[-_]?token$/i,
		/^\.?AspNet/i,
		/^ESTSAUTH/i,
	],
};

const COOKIE_PREFIX = /^__(secure|host)-/i;

// Lower-cased name with one leading `__Secure-` / `__Host-` removed.
function bareName(name) {
	return String(name).toLowerCase().replace(COOKIE_PREFIX, "");
}

export function isAuthCookie(name) {
	const raw = String(name);
	const candidates = [raw, raw.replace(COOKIE_PREFIX, "")];
	const lowered = new Set(candidates.map((n) => n.toLowerCase()));
	// Read the constant on every call (no cached copy), so it stays the single
	// source of truth even if it is mutated at runtime.
	for (const entry of AUTH_COOKIES.names) {
		const e = String(entry).toLowerCase();
		if (lowered.has(e) || lowered.has(bareName(entry))) return true;
	}
	return AUTH_COOKIES.patterns.some((p) => {
		const re = p.flags.includes("i") ? p : new RegExp(p.source, `${p.flags}i`);
		return candidates.some((n) => {
			re.lastIndex = 0;
			return re.test(n);
		});
	});
}

// Fixed message per failure kind. Never interpolate input into these.
const ERROR_MESSAGES = {
	empty: "cookie source is empty",
	unrecognised:
		"unrecognised cookie source: expected a HAR file, a Netscape cookies.txt, or a copy-as-cURL command",
	invalid_json: "cookie source looks like JSON but could not be parsed",
	not_har: "cookie source is JSON but not a HAR file (no log.entries array)",
	invalid_curl: "cURL command has no usable URL",
};

export class CookieParseError extends Error {
	constructor(kind) {
		super(ERROR_MESSAGES[kind] ?? ERROR_MESSAGES.unrecognised);
		this.name = "CookieParseError";
		this.kind = kind;
	}
}

// Playwright's `addCookies` rejects `expires` above this (9999-12-31T23:59:59Z)
// and any negative value other than -1 (session).
export const MAX_EXPIRES = 253402300799;
// A past, positive stamp: "already expired", distinct from -1 (session), and
// accepted by `addCookies` should it ever get that far.
const EXPIRED = 1;

// Coerce an expiry into something `addCookies` accepts: -1 for a session
// cookie, otherwise a positive stamp no larger than MAX_EXPIRES.
function normaliseExpires(expires) {
	if (expires === -1) return -1;
	if (Number.isNaN(expires) || typeof expires !== "number") return -1;
	if (expires <= 0) return EXPIRED;
	return Math.min(expires, MAX_EXPIRES);
}

const SAMESITE = { strict: "Strict", lax: "Lax", none: "None" };

function normaliseDomain(domain) {
	return String(domain).trim().toLowerCase().replace(/^\./, "");
}

// Build the exact shape Playwright's `context.addCookies` accepts: always
// `domain` + `path` (never `url`, they are mutually exclusive), `expires` in
// Unix seconds or -1 for a session cookie, capitalised `sameSite` or omitted.
// A `__Secure-`/`__Host-` cookie that ends up with secure:false is passed
// through unchanged rather than guessed at.
function makeCookie({
	name,
	value,
	domain,
	path,
	expires,
	httpOnly,
	secure,
	sameSite,
}) {
	const cookie = {
		name,
		value,
		domain: String(domain).trim().toLowerCase(),
		path: path || "/",
		expires: normaliseExpires(expires),
		httpOnly: Boolean(httpOnly),
		secure: Boolean(secure),
	};
	const site = SAMESITE[String(sameSite ?? "").toLowerCase()];
	if (site) cookie.sameSite = site;
	// Chromium rejects SameSite=None without Secure. Forcing `secure` would make
	// the cookie unsendable on http origins, so downgrade to Lax instead.
	if (cookie.sameSite === "None" && !cookie.secure) cookie.sameSite = "Lax";
	return cookie;
}

function cookieKey(c) {
	return `${c.name}\u0000${normaliseDomain(c.domain)}`;
}

// A real date at or before the epoch (`Expires=Thu, 01 Jan 1970 ...` is the
// standard way to delete a cookie) is an expired cookie, never a session one;
// only an unparseable date means session.
function parseExpiry(text) {
	const ms = Date.parse(text);
	if (Number.isNaN(ms)) return -1;
	return ms <= 0 ? EXPIRED : ms / 1000;
}

function parseCookieHeader(header, host, secure) {
	const out = [];
	for (const part of String(header).split(";")) {
		const i = part.indexOf("=");
		if (i < 1) continue;
		const name = part.slice(0, i).trim();
		if (!name) continue;
		out.push(
			makeCookie({
				name,
				value: part.slice(i + 1).trim(),
				domain: host,
				path: "/",
				expires: -1,
				secure,
			}),
		);
	}
	return out;
}

function parseSetCookie(line, host, startedMs) {
	const parts = String(line).split(";");
	const first = parts[0];
	const i = first.indexOf("=");
	if (i < 1) return null;
	const name = first.slice(0, i).trim();
	if (!name) return null;
	const attrs = {};
	for (const raw of parts.slice(1)) {
		const j = raw.indexOf("=");
		const key = (j < 0 ? raw : raw.slice(0, j)).trim().toLowerCase();
		attrs[key] = j < 0 ? true : raw.slice(j + 1).trim();
	}
	let domain = host;
	if (typeof attrs.domain === "string" && attrs.domain) {
		const d = attrs.domain.toLowerCase();
		domain = d.startsWith(".") ? d : `.${d}`;
	}
	let expires = -1;
	if (typeof attrs.expires === "string") expires = parseExpiry(attrs.expires);
	// Max-Age (relative to when the response was received) wins over Expires.
	// A non-numeric (including empty) Max-Age is ignored, per RFC 6265 5.2.2.
	if (typeof attrs["max-age"] === "string" && /^-?\d+$/.test(attrs["max-age"])) {
		const age = Number(attrs["max-age"]);
		// A non-positive age means "delete now": keep a past, positive stamp so
		// it is counted as expired rather than as a session cookie. A huge age
		// (even Infinity) is clamped by makeCookie.
		expires = age <= 0 ? EXPIRED : startedMs / 1000 + age;
	}
	return makeCookie({
		name,
		value: first.slice(i + 1).trim(),
		domain,
		path: typeof attrs.path === "string" ? attrs.path : "/",
		expires,
		httpOnly: attrs.httponly === true,
		secure: attrs.secure === true,
		sameSite: typeof attrs.samesite === "string" ? attrs.samesite : undefined,
	});
}

function headerValues(headers, wanted) {
	const out = [];
	for (const h of Array.isArray(headers) ? headers : []) {
		if (String(h?.name).toLowerCase() === wanted && typeof h.value === "string") {
			out.push(h.value);
		}
	}
	return out;
}

function parseHar(har) {
	const merged = new Map();
	const setCookieKeys = new Set();
	const requestKeys = new Set();
	// A Set-Cookie supersedes an attribute-less request cookie with the same
	// name whose host is within the Set-Cookie's domain. Checked in both
	// directions so the result does not depend on HAR entry order.
	const supersedes = (set, req) => {
		if (set.name !== req.name) return false;
		const sd = normaliseDomain(set.domain);
		const rd = normaliseDomain(req.domain);
		return rd === sd || rd.endsWith(`.${sd}`);
	};
	for (const entry of har.log.entries) {
		let url;
		try {
			url = new URL(entry?.request?.url);
		} catch {
			continue;
		}
		const host = url.hostname.toLowerCase();
		const secure = url.protocol === "https:";
		const started = Date.parse(entry.startedDateTime);
		const startedMs = Number.isNaN(started) ? Date.now() : started;

		// Request cookies carry no attributes; they only fill gaps left by
		// Set-Cookie, which has the real ones.
		const headerLines = headerValues(entry.request.headers, "cookie");
		let requestCookies = headerLines.flatMap((h) =>
			parseCookieHeader(h, host, secure),
		);
		if (headerLines.length === 0 && Array.isArray(entry.request.cookies)) {
			requestCookies = entry.request.cookies
				.filter((c) => c && typeof c.name === "string")
				.map((c) =>
					makeCookie({
						name: c.name,
						value: String(c.value ?? ""),
						domain: host,
						path: "/",
						expires: -1,
						secure,
					}),
				);
		}
		for (const c of requestCookies) {
			const key = cookieKey(c);
			if (setCookieKeys.has(key)) continue;
			let covered = false;
			for (const sk of setCookieKeys) {
				if (supersedes(merged.get(sk), c)) {
					covered = true;
					break;
				}
			}
			if (covered) continue;
			merged.set(key, c);
			requestKeys.add(key);
		}

		const setLines = headerValues(entry.response?.headers, "set-cookie").flatMap(
			(v) => v.split(/\r?\n/).filter(Boolean),
		);
		let setCookies = setLines
			.map((l) => parseSetCookie(l, host, startedMs))
			.filter(Boolean);
		if (setLines.length === 0 && Array.isArray(entry.response?.cookies)) {
			setCookies = entry.response.cookies
				.filter((c) => c && typeof c.name === "string")
				.map((c) =>
					makeCookie({
						name: c.name,
						value: String(c.value ?? ""),
						domain: c.domain || host,
						path: c.path || "/",
						expires:
							typeof c.expires === "string" ? parseExpiry(c.expires) : -1,
						httpOnly: c.httpOnly,
						secure: c.secure,
						sameSite: c.sameSite,
					}),
				);
		}
		for (const c of setCookies) {
			const key = cookieKey(c);
			setCookieKeys.add(key);
			merged.set(key, c);
			requestKeys.delete(key);
			for (const rk of requestKeys) {
				if (supersedes(c, merged.get(rk))) {
					merged.delete(rk);
					requestKeys.delete(rk);
				}
			}
		}
	}
	return [...merged.values()];
}

function parseNetscape(text) {
	const out = [];
	for (let line of text.split(/\r?\n/)) {
		line = line.replace(/\r$/, "");
		if (!line.trim()) continue;
		let httpOnly = false;
		if (line.startsWith("#HttpOnly_")) {
			httpOnly = true;
			line = line.slice("#HttpOnly_".length);
		} else if (line.trimStart().startsWith("#")) {
			continue;
		}
		const f = line.split("\t");
		if (f.length < 7 || !f[0].trim() || !f[5]) continue;
		const bare = normaliseDomain(f[0]);
		const subdomains = f[1].trim().toUpperCase() === "TRUE";
		const exp = Number(f[4]);
		out.push(
			makeCookie({
				name: f[5],
				value: f.slice(6).join("\t"),
				domain: subdomains ? `.${bare}` : bare,
				path: f[2],
				expires: Number.isFinite(exp) && exp > 0 ? exp : -1,
				httpOnly,
				secure: f[3].trim().toUpperCase() === "TRUE",
			}),
		);
	}
	return out;
}

// Minimal POSIX-ish shell word splitter: single quotes, double quotes,
// backslash escapes, $'...' and backslash-newline continuations.
function shellWords(text) {
	const words = [];
	let cur = "";
	let started = false;
	let i = 0;
	const push = () => {
		if (started) words.push(cur);
		cur = "";
		started = false;
	};
	const ansi = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
	while (i < text.length) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			push();
			i++;
		} else if (ch === "\\") {
			if (text[i + 1] === "\r" && text[i + 2] === "\n") i += 3;
			else if (text[i + 1] === "\n") i += 2;
			else {
				if (i + 1 < text.length) {
					cur += text[i + 1];
					started = true;
				}
				i += 2;
			}
		} else if (ch === "'") {
			started = true;
			const end = text.indexOf("'", i + 1);
			const stop = end < 0 ? text.length : end;
			cur += text.slice(i + 1, stop);
			i = stop + 1;
		} else if (ch === "$" && text[i + 1] === "'") {
			started = true;
			i += 2;
			while (i < text.length && text[i] !== "'") {
				if (text[i] === "\\" && i + 1 < text.length) {
					const n = text[i + 1];
					const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i + 1, i + 4));
					const uni = /^u([0-9a-fA-F]{1,4})/.exec(text.slice(i + 1, i + 6));
					if (hex) {
						cur += String.fromCharCode(Number.parseInt(hex[1], 16));
						i += 1 + hex[0].length;
					} else if (uni) {
						cur += String.fromCharCode(Number.parseInt(uni[1], 16));
						i += 1 + uni[0].length;
					} else {
						cur += ansi[n] ?? n;
						i += 2;
					}
				} else {
					cur += text[i++];
				}
			}
			i++;
		} else if (ch === '"') {
			started = true;
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) {
					const n = text[i + 1];
					if (n === "\n") i += 2;
					else if (n === "\r" && text[i + 2] === "\n") i += 3;
					else if ('\\"$`'.includes(n)) {
						cur += n;
						i += 2;
					} else {
						cur += text[i++];
					}
				} else {
					cur += text[i++];
				}
			}
			i++;
		} else {
			cur += ch;
			started = true;
			i++;
		}
	}
	push();
	return words;
}

// curl options whose next word is a value we must not mistake for the URL
// (`-H`, `-b` and `--url` are handled separately). Positional URLs must also
// parse as http(s), so an option missing from here cannot silently become the
// cookie domain; it can only cost us the URL.
const CURL_VALUE_OPTS = new Set([
	// short options
	"-A", "-C", "-D", "-E", "-F", "-K", "-P", "-Q", "-T", "-U", "-X", "-Y",
	"-c", "-d", "-e", "-m", "-o", "-r", "-t", "-u", "-w", "-x", "-y", "-z",
	// long options
	"--abstract-unix-socket", "--alt-svc", "--aws-sigv4", "--cacert",
	"--capath", "--cert", "--cert-type", "--ciphers", "--config",
	"--connect-timeout", "--connect-to", "--continue-at", "--cookie-jar",
	"--crlfile", "--curves", "--data", "--data-ascii", "--data-binary",
	"--data-raw", "--data-urlencode", "--dns-interface", "--dns-ipv4-addr",
	"--dns-ipv6-addr", "--dns-servers", "--doh-url", "--dump-header",
	"--egd-file", "--engine", "--etag-compare", "--etag-save",
	"--expect100-timeout", "--form", "--form-string", "--ftp-account",
	"--ftp-alternative-to-user", "--ftp-method", "--ftp-port", "--ftp-ssl-ccc-mode",
	"--happy-eyeballs-timeout-ms", "--haproxy-clientip", "--hostpubmd5",
	"--hostpubsha256", "--hsts", "--interface", "--ip-tos", "--json",
	"--keepalive-time", "--key", "--key-type", "--krb", "--libcurl",
	"--limit-rate", "--local-port", "--login-options", "--mail-auth",
	"--mail-from", "--mail-rcpt", "--max-filesize", "--max-redirs",
	"--max-time", "--netrc-file", "--noproxy", "--oauth2-bearer", "--output",
	"--output-dir", "--pass", "--pinnedpubkey", "--preproxy", "--proto",
	"--proto-default", "--proto-redir", "--proxy", "--proxy-cacert",
	"--proxy-capath", "--proxy-cert", "--proxy-cert-type", "--proxy-ciphers",
	"--proxy-crlfile", "--proxy-header", "--proxy-key", "--proxy-key-type",
	"--proxy-pass", "--proxy-pinnedpubkey", "--proxy-service-name",
	"--proxy-tls13-ciphers", "--proxy-tlsauthtype", "--proxy-tlspassword",
	"--proxy-tlsuser", "--proxy-user", "--proxy1.0", "--pubkey", "--quote",
	"--random-file", "--range", "--rate", "--referer", "--request",
	"--request-target", "--resolve", "--retry", "--retry-delay",
	"--retry-max-time", "--sasl-authzid", "--service-name", "--socks4",
	"--socks4a", "--socks5", "--socks5-gssapi-service", "--socks5-hostname",
	"--speed-limit", "--speed-time", "--stderr", "--telnet-option",
	"--tftp-blksize", "--time-cond", "--tls-max", "--tls13-ciphers",
	"--tlsauthtype", "--tlspassword", "--tlsuser", "--trace", "--trace-ascii",
	"--trace-config", "--unix-socket", "--upload-file", "--url-query",
	"--user", "--user-agent", "--variable", "--write-out",
]);

// Positional URL candidates must be http(s); `--url` may omit the scheme, as
// curl itself allows.
function curlUrl(word, fromUrlOpt) {
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(word);
	if (!hasScheme && !fromUrlOpt) return null;
	try {
		const u = new URL(hasScheme ? word : `http://${word}`);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

function parseCurl(text) {
	const words = shellWords(text);
	let url = null;
	const cookieStrings = [];
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		let value = null;
		let opt = w;
		if (/^-[^-]/.test(w)) {
			// Short options, possibly bundled (`-sSL`, `-sSc jar`, `-bz=9`): the
			// first value-taking letter consumes the rest of the word as its value,
			// or the next word when nothing follows it, exactly as curl does.
			opt = null;
			for (let k = 1; k < w.length; k++) {
				const o = `-${w[k]}`;
				if (o === "-H" || o === "-b" || CURL_VALUE_OPTS.has(o)) {
					opt = o;
					value = w.slice(k + 1) || null;
					break;
				}
			}
			if (opt === null) continue; // only boolean flags
		}
		if (opt === "-H" || opt === "--header") {
			const header = value ?? words[++i] ?? "";
			const m = /^cookie\s*:(.*)$/is.exec(header);
			if (m) cookieStrings.push(m[1]);
		} else if (opt === "-b" || opt === "--cookie") {
			const c = value ?? words[++i] ?? "";
			// A value without "=" is a cookie-jar filename; we never read files.
			if (c.includes("=")) cookieStrings.push(c);
		} else if (opt === "--url") {
			const u = curlUrl(words[++i] ?? "", true);
			if (u && !url) url = u;
		} else if (CURL_VALUE_OPTS.has(opt)) {
			if (value === null) i++;
		} else if (!w.startsWith("-") && !url) {
			url = curlUrl(w, false);
		}
	}
	if (!url) throw new CookieParseError("invalid_curl");
	const parsed = url;
	const host = parsed.hostname.toLowerCase();
	const secure = parsed.protocol === "https:";
	return cookieStrings.flatMap((s) => parseCookieHeader(s, host, secure));
}

/**
 * Parse cookie source text, auto-detecting HAR / Netscape / cURL from content.
 * Returns the normalised cookie list. Throws `CookieParseError` (fixed
 * message, no input echoed) when the input is unrecognised.
 */
export function parseCookies(text) {
	if (typeof text !== "string") throw new CookieParseError("empty");
	const src = text.replace(/^﻿/, "");
	const trimmed = src.trim();
	if (!trimmed) throw new CookieParseError("empty");

	if (trimmed.startsWith("{")) {
		let json;
		try {
			json = JSON.parse(trimmed);
		} catch {
			// Deliberately not chained: JSON.parse messages can quote the input.
			throw new CookieParseError("invalid_json");
		}
		if (!Array.isArray(json?.log?.entries)) throw new CookieParseError("not_har");
		return parseHar(json);
	}
	if (
		trimmed.startsWith("# Netscape HTTP Cookie File") ||
		src.includes("#HttpOnly_") ||
		src.split(/\r?\n/).some((l) => l.split("\t").length >= 7)
	) {
		return parseNetscape(src);
	}
	if (/^curl(\s|$)/.test(trimmed)) return parseCurl(trimmed);
	throw new CookieParseError("unrecognised");
}

function curlUserAgent(text) {
	const words = shellWords(text);
	let agent = null;
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		let opt = w;
		let value = null;
		if (/^-[^-]/.test(w)) {
			// Same bundled-short-option rule as parseCurl.
			opt = null;
			for (let k = 1; k < w.length; k++) {
				const o = `-${w[k]}`;
				if (o === "-H" || o === "-b" || CURL_VALUE_OPTS.has(o)) {
					opt = o;
					value = w.slice(k + 1) || null;
					break;
				}
			}
			if (opt === null) continue;
		}
		if (opt === "-A" || opt === "--user-agent") {
			agent = value ?? words[++i] ?? null;
		} else if (opt === "-H" || opt === "--header") {
			const m = /^user-agent\s*:(.*)$/is.exec(value ?? words[++i] ?? "");
			if (m) agent = m[1].trim();
		} else if (opt === "-b" || opt === "--cookie" || opt === "--url") {
			if (value === null) i++;
		} else if (CURL_VALUE_OPTS.has(opt)) {
			if (value === null) i++;
		}
	}
	return agent || null;
}

/**
 * The `User-Agent` the source was captured with, or null when it carries none
 * (always null for a Netscape cookies.txt, which has no such field). For a HAR,
 * the first request that sent one; for a cURL command, its `-A` /
 * `--user-agent` / `-H 'User-Agent: …'` (last one wins, as in curl). Never
 * throws: unrecognised input simply has no User-Agent.
 */
export function sourceUserAgent(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.replace(/^﻿/, "").trim();
	try {
		if (trimmed.startsWith("{")) {
			const entries = JSON.parse(trimmed)?.log?.entries;
			if (!Array.isArray(entries)) return null;
			for (const entry of entries) {
				const [ua] = headerValues(entry?.request?.headers, "user-agent");
				if (ua?.trim()) return ua.trim();
			}
			return null;
		}
		if (/^curl(\s|$)/.test(trimmed)) return curlUserAgent(trimmed);
	} catch {
		// Malformed input: parseCookies reports it; there is no agent to read.
	}
	return null;
}

// A cookie for a single-label domain (`com`, `test`) is only kept when the
// filter names exactly that host: browsers never store a cookie on a bare
// public suffix, so `example.com` must not match a `com` cookie. (Multi-label
// suffixes such as `co.uk` would need the Public Suffix List; not bundled.)
function domainMatches(cookieDomain, hostFilter) {
	const cd = normaliseDomain(cookieDomain);
	const host = normaliseDomain(hostFilter);
	if (host === cd) return true;
	if (cd.includes(".") && host.endsWith(`.${cd}`)) return true;
	return cd.endsWith(`.${host}`);
}

/**
 * Filter a cookie list. Order: domain, allow, expired, auth.
 * Options: `domain` (host), `allow` (exact names), `includeAuth`, `now` (ms,
 * injectable for tests). Returns `{ cookies, authDropped, expiredDropped,
 * matched }`, where `matched` counts the cookies left after `domain`/`allow`
 * (before the expired and auth steps). `authDropped` holds `{ name, domain }`
 * only, never values. Pass the result to `summarize` for anything meant for
 * display.
 */
export function filterCookies(cookies, opts = {}) {
	const { domain, allow, includeAuth = false, now = Date.now() } = opts;
	let list = cookies;
	if (domain) list = list.filter((c) => domainMatches(c.domain, domain));
	if (allow) {
		const names = new Set(allow);
		list = list.filter((c) => names.has(c.name));
	}
	const matched = list.length;
	const nowSec = now / 1000;
	let expiredDropped = 0;
	list = list.filter((c) => {
		// Anything that is not a session cookie (-1) and is at or before now is
		// expired, including 0 and stray negatives from hand-built input.
		const e = c.expires;
		const expired = typeof e === "number" && e !== -1 && !(e > nowSec);
		if (expired) expiredDropped++;
		return !expired;
	});
	const authDropped = [];
	if (!includeAuth) {
		list = list.filter((c) => {
			if (!isAuthCookie(c.name)) return true;
			authDropped.push({ name: c.name, domain: c.domain });
			return false;
		});
	}
	return { cookies: list, authDropped, expiredDropped, matched };
}

// An IPv4 or IPv6 literal (a URL `hostname` keeps the IPv6 brackets).
function isIpHost(host) {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

// RFC 6265 5.1.3, stricter than `domainMatches` (a lenient `--domain`
// filter): a leading dot makes a domain cookie, sent to that host and its
// subdomains; without one the cookie is host-only, sent to that exact host.
// A single-label domain (`.com`) and an IP host match only exactly.
function cookieDomainMatches(cookieDomain, host) {
	const raw = String(cookieDomain ?? "").trim().toLowerCase();
	const domain = raw.replace(/^\./, "");
	if (!domain) return false;
	if (host === domain) return true;
	if (!raw.startsWith(".") || isIpHost(host) || !domain.includes(".")) return false;
	return host.endsWith(`.${domain}`);
}

// RFC 6265 5.1.4: the cookie path equals the request path, or is a prefix of
// it that ends in `/` or is followed by a `/` in the request path.
function cookiePathMatches(cookiePath, requestPath) {
	const path = cookiePath || "/";
	if (path === requestPath) return true;
	if (!requestPath.startsWith(path)) return false;
	return path.endsWith("/") || requestPath[path.length] === "/";
}

/**
 * The `Cookie` header a browser would send with a request to `url`, from an
 * already-parsed, already-filtered list (the `makeCookie` shape), or
 * `undefined` when no cookie matches. RFC 6265 5.4: domain (host-only vs
 * leading dot), path, `secure` only over https, not expired (-1 = session).
 * `httpOnly` and `sameSite` are ignored: this is a request of trawl's own to
 * the site's own origin. Longer paths first, ties in input order; a nameless
 * cookie contributes its value alone. The result is a secret: it belongs in a
 * request header and nowhere else (no log, no error, no `failure`).
 */
export function cookieHeaderFor(cookies, url, { now = Date.now() } = {}) {
	let target;
	try {
		target = new URL(url);
	} catch {
		return undefined;
	}
	const host = target.hostname.toLowerCase();
	const https = target.protocol === "https:";
	const nowSec = now / 1000;
	const matching = [];
	for (const c of Array.isArray(cookies) ? cookies : []) {
		if (!c || !cookieDomainMatches(c.domain, host)) continue;
		if (!cookiePathMatches(c.path, target.pathname)) continue;
		if (c.secure && !https) continue;
		const e = c.expires;
		if (typeof e === "number" && e !== -1 && !(e > nowSec)) continue;
		matching.push(c);
	}
	if (matching.length === 0) return undefined;
	// Array.prototype.sort is stable, so equal path lengths keep input order.
	matching.sort((a, b) => (b.path || "/").length - (a.path || "/").length);
	return matching.map((c) => (c.name ? `${c.name}=${c.value}` : String(c.value))).join("; ");
}

// Byte length, as Chromium measures cookie limits.
function bytes(s) {
	return Buffer.byteLength(String(s), "utf8");
}

const COOKIE_CONTROL = /[\u0000-\u001f\u007f;]/;

/**
 * True when Chromium's `Storage.setCookies` would refuse this cookie. One
 * refused cookie fails the whole `addCookies` batch, so callers set these
 * aside first and report them by name. Each rule was checked against real
 * Chromium (playwright-core 1.64): it is a best-effort mirror of its
 * `CanonicalCookie` checks, not a parser of its own, and Chromium stays the
 * final word. Looks at the value but returns only a boolean.
 */
export function browserWouldReject(cookie) {
	const name = String(cookie?.name ?? "");
	const value = String(cookie?.value ?? "");
	const path = String(cookie?.path ?? "");
	const domain = String(cookie?.domain ?? "").trim();
	if (!domain) return true;
	if (COOKIE_CONTROL.test(name) || COOKIE_CONTROL.test(value)) return true;
	if (name.includes("=")) return true;
	if (/^\s|\s$/.test(name) || /^\s|\s$/.test(value)) return true;
	if (name === "" && value === "") return true;
	if (bytes(name) + bytes(value) > 4096) return true;
	if (!path.startsWith("/") || path.includes(";") || bytes(path) > 1024) return true;
	// A bare IPv6 literal (`::1`, `2001:db8::1`, with or without a leading
	// dot) is refused; the bracketed form (`[::1]`) is accepted.
	if (isIPv6(domain.replace(/^\.+/, ""))) return true;
	// Prefixes match case-insensitively. A nameless cookie whose value looks
	// like `__Host-` / `__Secure-` / `__Http-` is refused outright, whatever
	// its flags (checked against Chromium 156 and 158; older builds such as
	// 143 accepted a nameless `__Http-` value, so this errs towards refusing).
	if (name === "") return /^__(host|secure|http)-/i.test(value);
	const prefixed = name.toLowerCase();
	if (prefixed.startsWith("__secure-") && !cookie.secure) return true;
	if (
		prefixed.startsWith("__host-") &&
		(!cookie.secure || path !== "/" || domain.startsWith("."))
	) {
		return true;
	}
	// `__Http-` needs Secure and HttpOnly; `__Host-Http-` needs HttpOnly on top
	// of the `__Host-` rules above (which already demand Secure).
	if (prefixed.startsWith("__http-") && (!cookie.secure || !cookie.httpOnly)) return true;
	if (prefixed.startsWith("__host-http-") && !cookie.httpOnly) return true;
	return false;
}

// Why a list of cookies came out empty, naming the filter that actually
// removed them (and the flag that would keep sign-in ones). `verb` finishes
// the --include-auth hint: "import" for `trawl cookies import`, "use" for a
// fetch with --cookies.
export function whyNoneLeft(parsedCount, result, refusedCount, { domain, allow, verb = "import" }) {
	if (parsedCount === 0) return "the file holds no cookies";
	const flags = [domain && "--domain", allow && "--allow"].filter(Boolean).join(" and ");
	if (result.matched === 0) return `no cookie matched ${flags}`;
	const causes = [];
	if (result.expiredDropped > 0) causes.push("expired");
	if (result.authDropped.length > 0) causes.push("a sign-in cookie");
	if (refusedCount > 0) causes.push("one the browser would refuse");
	const scope = flags ? `cookie that matched ${flags}` : "cookie";
	const list =
		causes.length > 1 ? `${causes.slice(0, -1).join(", ")} or ${causes.at(-1)}` : causes[0];
	return (
		`every ${scope} was ${list}` +
		(result.authDropped.length > 0 ? ` (pass --include-auth to ${verb} sign-in cookies)` : "")
	);
}

// Names and domains come from the input file: strip control characters so a
// crafted file cannot drive the terminal.
export function printable(s) {
	return String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export function describeExpiry(expires) {
	return new Date(expires * 1000).toISOString().replace(/\.000Z$/, "Z");
}

export function plural(n, word) {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Browser errors never reach the user once cookies are involved: Playwright's
// messages can quote the cookie they reject, raw or encoded, and no substring
// test can prove an arbitrary message value-free. Each line below is an exact
// `addCookies` first line known to quote nothing, matched by equality and
// replaced by our own text; anything else gets the caller's fixed message
// alone.
const KNOWN_WRITE_ERRORS = new Map([
	[
		"browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields",
		"the browser refused a cookie, and so the whole batch",
	],
	[
		"browserContext.addCookies: Target page, context or browser has been closed",
		"the browser closed unexpectedly",
	],
	["Target page, context or browser has been closed", "the browser closed unexpectedly"],
]);

/**
 * The value-free detail for an `addCookies` rejection, or `undefined`. Never
 * returns any of the error's own text: only one of our fixed strings, picked
 * by exact match on its first line. Reading the error is guarded too, since a
 * throwing `message` getter (or `toString`) must not escape carrying a value.
 */
export function addCookiesFailure(err) {
	let line;
	try {
		line = String(err?.message ?? "").split("\n")[0];
	} catch {
		return undefined;
	}
	return KNOWN_WRITE_ERRORS.get(line);
}

// Explicit field pick (never spread) so a field added to cookies later cannot
// leak `value` into display output.
function pick(c) {
	return { name: c.name, domain: c.domain, expires: c.expires };
}

/**
 * Describe a `filterCookies` result (or a plain cookie array) for display:
 * names, domains and expiry only. Never contains a cookie value.
 */
export function summarize(result) {
	const kept = Array.isArray(result) ? result : (result?.cookies ?? []);
	const auth = Array.isArray(result) ? [] : (result?.authDropped ?? []);
	return {
		kept: kept.map(pick),
		authDropped: { count: auth.length, names: auth.map((c) => c.name) },
		expiredDropped: Array.isArray(result) ? 0 : (result?.expiredDropped ?? 0),
	};
}
