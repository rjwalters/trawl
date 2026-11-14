// A small, dependency-free robots.txt parser and matcher.
//
// Scope is the RFC 9309 baseline: `User-agent` grouping, `Allow`/`Disallow`
// path matching (longest match wins, `Allow` breaks a tie), and `Crawl-delay`.
// Rule paths honour the §2.2.3 special characters: `*` matches any run of
// characters and a trailing `$` anchors the match to the end of the path.
// Percent-encoding normalisation (§2.2.2) is out of scope — both sides are
// compared exactly as given.
//
// This is a politeness mechanism, not a security boundary. Retrieval
// failures follow RFC 9309 §2.3.1.3–4: a 4xx ("unavailable") means no
// restrictions apply, while a 5xx, network error, or timeout ("unreachable")
// means a complete disallow. A robots.txt that *was* retrieved but does not
// parse is treated as allowing everything.

// Cap for the robots.txt fetch itself, so a hanging robots.txt cannot
// dominate an invocation that has a much larger page timeout.
export const ROBOTS_TIMEOUT_MS = 10000;

// Cap for `Crawl-delay`. Real-world robots.txt files sometimes specify
// absurd values (86400 is not rare); we clamp rather than reject so the
// tool stays polite without hanging.
export const MAX_CRAWL_DELAY_MS = 60000;

const ALLOWED = Object.freeze({ allowed: true, rule: null, crawlDelay: null });

// The product token is the leading `name` of a `name/version (comment)` UA
// string — the part robots.txt `User-agent` lines are matched against.
export function productToken(userAgent) {
	if (!userAgent) return "";
	const [token] = String(userAgent).trim().split(/[\s/]/, 1);
	return (token ?? "").toLowerCase();
}

// Parse into ordered groups. Consecutive `User-agent` lines share one group;
// the first rule line closes the group's header, so a later `User-agent`
// line starts a new group.
export function parseRobotsTxt(text) {
	const groups = [];
	let current = null;
	let inHeader = false;

	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.split("#")[0].trim();
		if (!line) continue;

		const sep = line.indexOf(":");
		if (sep === -1) continue; // not a directive; ignore rather than throw
		const name = line.slice(0, sep).trim().toLowerCase();
		const value = line.slice(sep + 1).trim();

		if (name === "user-agent" || name === "useragent") {
			if (!inHeader) {
				current = { agents: [], rules: [], crawlDelay: null };
				groups.push(current);
				inHeader = true;
			}
			current.agents.push(value.toLowerCase());
			continue;
		}

		// A rule before any `User-agent` line belongs to no group.
		if (!current) continue;
		inHeader = false;

		if (name === "allow" || name === "disallow") {
			const allow = name === "allow";
			current.rules.push({
				allow,
				path: value,
				line: `${allow ? "Allow" : "Disallow"}: ${value}`,
			});
		} else if (name === "crawl-delay" || name === "crawldelay") {
			const seconds = Number(value);
			if (Number.isFinite(seconds) && seconds >= 0) {
				current.crawlDelay = seconds;
			}
		}
		// Everything else (Sitemap, Host, …) is ignored, not an error.
	}

	return groups;
}

// Pick the group that applies to `userAgent`: an exact (case-insensitive)
// product-token match wins, otherwise the `*` group, otherwise nothing.
// Groups repeating the same token are merged, per RFC 9309 §2.2.1.
export function selectGroup(groups, userAgent) {
	const token = productToken(userAgent);

	const merge = (matching) => {
		if (matching.length === 0) return null;
		return {
			agents: matching.flatMap((g) => g.agents),
			rules: matching.flatMap((g) => g.rules),
			crawlDelay:
				matching.map((g) => g.crawlDelay).find((d) => d !== null) ?? null,
		};
	};

	const specific = token ? groups.filter((g) => g.agents.includes(token)) : [];
	return merge(specific) ?? merge(groups.filter((g) => g.agents.includes("*")));
}

// Match a rule path against `path`, honouring the RFC 9309 §2.2.3 `*`
// wildcard and trailing `$` end anchor. The pattern is split on `*` and each
// literal segment is matched at its earliest possible position, left to
// right, so the cost is bounded by O(path length x pattern length) with no
// backtracking at all.
//
// Earliest-position matching is complete here because `*` is the only
// wildcard: matching a segment later than it could match only shortens the
// suffix left for the remaining segments, so it can never rescue a match that
// the earliest position rules out. That is what keeps a pattern like
// `/*a*a*a*a*a*b` bounded, rather than needing a timeout or a length cap the
// way a `*` -> `.*` regex translation would.
//
// A `$` is special only as the final character; anywhere else it is literal.
function matchesPattern(pattern, path) {
	let anchored = false;
	let p = pattern;
	if (p.endsWith("$")) {
		anchored = true;
		p = p.slice(0, -1);
	}

	const segments = p.split("*");

	// No wildcard: identical to the old literal prefix test when unanchored.
	if (segments.length === 1) {
		return anchored ? path === segments[0] : path.startsWith(segments[0]);
	}

	// The text before the first `*` is anchored to the start of the path.
	if (!path.startsWith(segments[0])) return false;
	let pos = segments[0].length;

	for (let i = 1; i < segments.length - 1; i++) {
		const at = path.indexOf(segments[i], pos);
		if (at === -1) return false;
		pos = at + segments[i].length;
	}

	// The text after the last `*`. An empty tail means the pattern ended in
	// `*`, which any remaining suffix satisfies.
	const tail = segments[segments.length - 1];
	if (tail === "") return true;
	if (anchored) return path.length - tail.length >= pos && path.endsWith(tail);
	return path.indexOf(tail, pos) !== -1;
}

// Longest matching rule wins; on an equal-length tie `Allow` beats
// `Disallow`. The length compared is the rule's pattern as written, `*` and
// `$` included. An empty `Disallow:` value is the documented "allow
// everything" idiom and matches nothing.
export function matchRule(group, path) {
	if (!group) return { allowed: true, rule: null };

	let best = null;
	for (const rule of group.rules) {
		if (rule.path === "") continue;
		if (!matchesPattern(rule.path, path)) continue;
		if (
			best === null ||
			rule.path.length > best.path.length ||
			(rule.path.length === best.path.length && rule.allow && !best.allow)
		) {
			best = rule;
		}
	}

	if (!best) return { allowed: true, rule: null };
	return { allowed: best.allow, rule: best.line };
}

// Full evaluation of a robots.txt body against one path. Never throws:
// unparseable input yields "allowed".
export function evaluateRobots(text, { userAgent, path } = {}) {
	try {
		const group = selectGroup(parseRobotsTxt(text), userAgent);
		const { allowed, rule } = matchRule(group, path || "/");
		return { allowed, rule, crawlDelay: group?.crawlDelay ?? null };
	} catch {
		return ALLOWED;
	}
}

// Clamp a `Crawl-delay` in seconds to a bounded pre-navigation sleep in ms.
export function crawlDelayMs(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS);
}

// A denied verdict for a robots.txt that could not be retrieved. There is no
// matched rule — `failure` carries the cause instead, so a caller can say
// "unreachable", not "disallowed by Disallow: /".
//   kind: "server-error" (with `status`), "network-error", "read-error"
//         (body failed after headers arrived), or "timeout".
function unreachable(robotsUrl, failure) {
	return {
		allowed: false,
		rule: null,
		crawlDelay: null,
		failure: { url: robotsUrl, ...failure },
	};
}

// A short, header- and cookie-free description of a thrown fetch error.
// Node's fetch wraps the useful part (ECONNREFUSED, ENOTFOUND, …) in `cause`.
function describeError(err) {
	const cause = err?.cause;
	return (
		cause?.code ??
		cause?.message ??
		err?.code ??
		err?.message ??
		String(err ?? "unknown error")
	);
}

// Error codes that may be named in a diagnostic when the request carried
// cookies. Only a code is ever taken from such an error, and only one equal to
// an entry here: an error's message, and anything else on it, can quote the
// request's headers (Node's fetch puts an invalid `Cookie` value in its
// message whole). Matched by equality, so a code that merely contains one of
// these, or anything else, falls back to fixed text.
export const SAFE_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EHOSTDOWN",
	"ENETDOWN",
	"EPIPE",
	"EPROTO",
	"ERR_INVALID_CHAR",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_HEADERS_OVERFLOW",
	"UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

// The fixed detail used when no allowlisted code is available.
const REQUEST_FAILED = "request failed";

// `err.cause.code`, else `err.code`, when it is an allowlisted code; else
// `undefined`. Reads defensively: a getter that throws counts as no code.
export function safeErrorCode(err) {
	for (const read of [() => err?.cause?.code, () => err?.code]) {
		try {
			const code = read();
			if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) return code;
		} catch {
			// Not a code we can use.
		}
	}
	return undefined;
}

// Fetch `<origin>/robots.txt` and evaluate it for `url`.
//
// Per RFC 9309 §2.3.1.3–4:
//   - 2xx: the body is parsed and evaluated.
//   - 4xx (404, 410, 429, …) and any other non-5xx status: no restrictions.
//   - 5xx, a network error, a timeout (headers or body), or a failed body
//     read: complete disallow, reported via `failure` with no matched rule.
// Redirects are followed (Node fetch's default); the final response decides.
//
// The request carries the User-Agent and, when `cookie` is given, that string
// as its `Cookie` header: a ready header (src/cookies.mjs `cookieHeaderFor`),
// never a cookie list, so this module stays cookie-agnostic. It is a secret
// and goes nowhere but the header, as given: `cookieHeaderFor` has already
// put non-ASCII in as UTF-8 bytes, one per char, like Chromium's page request,
// so it must not be encoded again here. Node's fetch drops the
// header on a cross-origin redirect, and a robots `Set-Cookie` is not stored:
// both are fine for a robots.txt probe (fewer cookies leave the origin).
// The `--profile` path builds the same header from the context's jar. When a
// `Cookie` header was sent, a failure's `detail` is an allowlisted error code
// (SAFE_ERROR_CODES) or the fixed "request failed", never text taken from the
// error; without one it is described as it always was. When a `Cookie` header
// was sent and the response came from another origin after a redirect, a
// denied verdict also carries `crossOriginRedirect: true` (no URL), so the
// refusal can say the cookies did not go along; without a header, or without
// such a redirect, the verdict is exactly as before.
//
// `gate`, if given, wraps the moment the request is sent: it is called with a
// `start` function and must call it (once) and return its result. This is how
// cross-run pacing (src/pacing.mjs) waits *before* the fetch. The timeout
// clock only starts when `start` is called, so time spent waiting for a turn
// is never mistaken for an unreachable robots.txt; an error the gate throws
// before starting (e.g. pacing lock contention) propagates as-is rather than
// being reported as a network failure.
export async function checkRobotsAllowed(url, options = {}) {
	const {
		userAgent,
		timeout = ROBOTS_TIMEOUT_MS,
		fetch: fetchImpl = globalThis.fetch,
		gate = (start) => start(),
		cookie,
	} = options;

	let target;
	try {
		target = new URL(url);
	} catch {
		return ALLOWED;
	}
	if (typeof fetchImpl !== "function") return ALLOWED;

	// Built from the origin, so userinfo in the page URL (which Node's fetch
	// refuses outright) is neither sent nor echoed into a diagnostic.
	const robotsUrl = `${target.origin}/robots.txt`;
	const sendsCookie = typeof cookie === "string" && cookie !== "";
	const detailOf = (err) =>
		sendsCookie ? (safeErrorCode(err) ?? REQUEST_FAILED) : describeError(err);
	const controller = new AbortController();
	let timer;
	let started = false;
	// Set once a response shows a cross-origin redirect after a Cookie header
	// was sent (see `redirectedElsewhere`); marks a denial, never an allow.
	let crossOrigin = false;
	const denied = (verdict) => (crossOrigin ? { ...verdict, crossOriginRedirect: true } : verdict);
	const timedOut = () => unreachable(robotsUrl, { kind: "timeout", timeout });
	const start = () => {
		started = true;
		timer = setTimeout(() => controller.abort(), timeout);
		const headers = userAgent ? { "User-Agent": userAgent } : {};
		if (sendsCookie) headers.Cookie = cookie;
		return fetchImpl(robotsUrl, {
			headers,
			redirect: "follow",
			signal: controller.signal,
		});
	};

	let text;
	try {
		let response;
		try {
			response = await gate(start);
		} catch (err) {
			if (!started) throw err;
			if (controller.signal.aborted) return timedOut();
			return unreachable(robotsUrl, {
				kind: "network-error",
				detail: detailOf(err),
			});
		}
		if (!response) {
			return unreachable(robotsUrl, {
				kind: "network-error",
				detail: "no response",
			});
		}

		if (sendsCookie && redirectedElsewhere(response, robotsUrl)) crossOrigin = true;
		const status = Number(response.status);
		if (!response.ok) {
			if (status >= 500 && status <= 599) {
				return denied(unreachable(robotsUrl, { kind: "server-error", status }));
			}
			return ALLOWED;
		}

		try {
			text = await response.text();
		} catch (err) {
			if (controller.signal.aborted) return denied(timedOut());
			return denied(
				unreachable(robotsUrl, {
					kind: "read-error",
					status,
					detail: detailOf(err),
				}),
			);
		}
	} finally {
		clearTimeout(timer);
	}

	const verdict = evaluateRobots(text, {
		userAgent,
		path: `${target.pathname}${target.search}`,
	});
	return verdict.allowed ? verdict : denied(verdict);
}

// True when `response` arrived from another origin than `robotsUrl` after a
// redirect (other host, other port, or http -> https). Reads defensively: a
// response without `redirected` / `url`, or one that throws, is no redirect.
function redirectedElsewhere(response, robotsUrl) {
	try {
		if (response.redirected !== true) return false;
		const final = response.url;
		if (typeof final !== "string" || final === "") return false;
		return new URL(final).origin !== new URL(robotsUrl).origin;
	} catch {
		return false;
	}
}

// Turn a denied robots verdict into an error message. A matched rule and a
// robots.txt that could not be retrieved are different situations and say
// so: the latter names the cause and says why it is a full disallow. When the
// request carried no cookies it also says so — the usual reason a site that
// loads fine in a browser still fails here. Pass `{ sentCookies: true }` when
// it did (a matching --cookies header, or a profile's jar), where that note
// would be false, and `{ profile: true }` on the `--profile` path, where the
// note says no cookie from the profile went along instead. A verdict marked
// `crossOriginRedirect` (see `checkRobotsAllowed`) gets a fixed hint that the
// cookies did not follow the redirect, but only when robots.txt could not be
// retrieved: a matched rule is a plain disallow and never carries it. Nothing here ever names a cookie.
export function robotsDenialMessage(verdict, { sentCookies = false, profile = false } = {}) {
	const override = "Use --ignore-robots to override.";
	const redirectHint = verdict?.failure && verdict?.crossOriginRedirect
		? "The robots.txt request was redirected to another origin, and cookies " +
			"are not sent across a cross-origin redirect, so a cookie-gated " +
			"robots.txt there was requested without them. "
		: "";
	const failure = verdict?.failure;
	if (!failure) {
		return `robots.txt disallows this path (${verdict?.rule}). ${redirectHint}${override}`;
	}
	const where = failure.url ?? "robots.txt";
	let cause;
	switch (failure.kind) {
		case "server-error":
			cause = `${where} returned HTTP ${failure.status} (server error)`;
			break;
		case "timeout":
			cause = `${where} timed out after ${failure.timeout}ms`;
			break;
		case "read-error":
			cause = `reading the body of ${where} failed (${failure.detail})`;
			break;
		default:
			cause = `${where} could not be fetched (network error: ${failure.detail})`;
	}
	const cookieNote = sentCookies
		? ""
		: profile
			? "No cookie from the profile matched robots.txt, so the request " +
				"carried none, and a cookie-gated robots.txt can fail here even " +
				"when the page itself would load. "
			: "The robots.txt request " +
				"sends no browser-profile cookies, so a cookie-gated robots.txt can " +
				"fail here even when the page itself would load. ";
	return (
		`robots.txt is unreachable: ${cause}. RFC 9309 treats an unreachable ` +
		`robots.txt as disallowing the whole site. ${cookieNote}${redirectHint}${override}`
	);
}
