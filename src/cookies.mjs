// Parse a cookie source file (HAR, Netscape cookies.txt, copy-as-cURL) into a
// normalised cookie list, filter it, and describe it without exposing values.
//
// Pure module: no I/O, no spawning, no eval. Nothing here ever puts a cookie
// value into an error message or a summary.

/**
 * Single source of truth for cookies treated as authentication/session
 * credentials. They are dropped by default (see `filterCookies`), like
 * `FORMATS` in render.mjs: derive from this, never re-list it elsewhere.
 *
 * `names` are exact, case-sensitive matches. `patterns` are tested against the
 * cookie name. Conservative on purpose: Google's `NID`, `AEC` and
 * `__Secure-ENID` are preferences/anti-abuse cookies and must survive.
 * Non-Google entries are a documented best-effort set, not a guarantee.
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

export function isAuthCookie(name) {
	return (
		AUTH_COOKIES.names.includes(name) ||
		AUTH_COOKIES.patterns.some((p) => p.test(name))
	);
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
		expires: Number.isFinite(expires) ? expires : -1,
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

function parseExpiry(text) {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? -1 : ms / 1000;
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
	if (typeof attrs["max-age"] === "string") {
		const age = Number(attrs["max-age"]);
		if (Number.isFinite(age)) {
			// A non-positive age means "delete now": keep a past, positive stamp so
			// it is counted as expired rather than as a session cookie.
			expires = age <= 0 ? 1 : (startedMs + age * 1000) / 1000;
		}
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
			if (!setCookieKeys.has(key)) {
				merged.set(key, c);
				requestKeys.add(key);
			}
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
			// A Set-Cookie also supersedes the attribute-less request cookie it
			// replaces (same name, host within the Set-Cookie's domain).
			const cd = normaliseDomain(c.domain);
			for (const rk of requestKeys) {
				const r = merged.get(rk);
				if (!r || r.name !== c.name || rk === key) continue;
				const rd = normaliseDomain(r.domain);
				if (rd === cd || rd.endsWith(`.${cd}`)) {
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

// curl options whose next word is a value we must not mistake for the URL.
const CURL_VALUE_OPTS = new Set([
	"-X", "--request", "-d", "--data", "--data-raw", "--data-binary",
	"--data-urlencode", "-A", "--user-agent", "-e", "--referer", "-o",
	"--output", "-u", "--user", "-x", "--proxy", "-F", "--form", "-m",
	"--max-time", "--connect-timeout", "-w", "--write-out", "-K", "--config",
]);

function parseCurl(text) {
	const words = shellWords(text);
	let url = null;
	const cookieStrings = [];
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		let value = null;
		let opt = w;
		if (/^-[Hb]./.test(w)) {
			opt = w.slice(0, 2);
			value = w.slice(2);
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
			url = words[++i] ?? url;
		} else if (CURL_VALUE_OPTS.has(opt)) {
			i++;
		} else if (!w.startsWith("-") && url === null) {
			url = w;
		}
	}
	let parsed;
	try {
		if (!url) throw new Error("no url");
		parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
	} catch {
		throw new CookieParseError("invalid_curl");
	}
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

function domainMatches(cookieDomain, hostFilter) {
	const cd = normaliseDomain(cookieDomain);
	const host = normaliseDomain(hostFilter);
	return host === cd || host.endsWith(`.${cd}`) || cd.endsWith(`.${host}`);
}

/**
 * Filter a cookie list. Order: domain, allow, expired, auth.
 * Options: `domain` (host), `allow` (exact names), `includeAuth`, `now` (ms,
 * injectable for tests). Returns `{ cookies, authDropped, expiredDropped }`;
 * pass it to `summarize` for anything meant for display.
 */
export function filterCookies(cookies, opts = {}) {
	const { domain, allow, includeAuth = false, now = Date.now() } = opts;
	let list = cookies;
	if (domain) list = list.filter((c) => domainMatches(c.domain, domain));
	if (allow) {
		const names = new Set(allow);
		list = list.filter((c) => names.has(c.name));
	}
	const nowSec = now / 1000;
	let expiredDropped = 0;
	list = list.filter((c) => {
		const expired = c.expires > 0 && c.expires < nowSec;
		if (expired) expiredDropped++;
		return !expired;
	});
	const authDropped = [];
	if (!includeAuth) {
		list = list.filter((c) => {
			if (!isAuthCookie(c.name)) return true;
			authDropped.push(c);
			return false;
		});
	}
	return { cookies: list, authDropped, expiredDropped };
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
