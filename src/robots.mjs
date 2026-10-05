// A small, dependency-free robots.txt parser and matcher.
//
// Scope is deliberately the RFC 9309 baseline: `User-agent` grouping,
// `Allow`/`Disallow` exact-prefix matching (longest match wins, `Allow`
// breaks a tie), and `Crawl-delay`. Google's wildcard (`*`) and end-anchor
// (`$`) path extensions are explicitly out of scope — a path is matched by
// literal prefix comparison only.
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

// Longest matching prefix wins; on an equal-length tie `Allow` beats
// `Disallow`. An empty `Disallow:` value is the documented "allow
// everything" idiom and matches nothing.
export function matchRule(group, path) {
	if (!group) return { allowed: true, rule: null };

	let best = null;
	for (const rule of group.rules) {
		if (rule.path === "") continue;
		if (!path.startsWith(rule.path)) continue;
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

// Fetch `<origin>/robots.txt` and evaluate it for `url`.
//
// Per RFC 9309 §2.3.1.3–4:
//   - 2xx: the body is parsed and evaluated.
//   - 4xx (404, 410, 429, …) and any other non-5xx status: no restrictions.
//   - 5xx, a network error, a timeout (headers or body), or a failed body
//     read: complete disallow, reported via `failure` with no matched rule.
// Redirects are followed (Node fetch's default); the final response decides.
//
// The request carries the User-Agent but no browser-profile cookies, so a
// robots.txt behind a cookie-gated interstitial is "unreachable" here even
// when a navigation with that profile would get through.
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
	const controller = new AbortController();
	let timer;
	let started = false;
	const timedOut = () => unreachable(robotsUrl, { kind: "timeout", timeout });
	const start = () => {
		started = true;
		timer = setTimeout(() => controller.abort(), timeout);
		return fetchImpl(robotsUrl, {
			headers: userAgent ? { "User-Agent": userAgent } : {},
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
				detail: describeError(err),
			});
		}
		if (!response) {
			return unreachable(robotsUrl, {
				kind: "network-error",
				detail: "no response",
			});
		}

		const status = Number(response.status);
		if (!response.ok) {
			if (status >= 500 && status <= 599) {
				return unreachable(robotsUrl, { kind: "server-error", status });
			}
			return ALLOWED;
		}

		try {
			text = await response.text();
		} catch (err) {
			if (controller.signal.aborted) return timedOut();
			return unreachable(robotsUrl, {
				kind: "read-error",
				status,
				detail: describeError(err),
			});
		}
	} finally {
		clearTimeout(timer);
	}

	return evaluateRobots(text, {
		userAgent,
		path: `${target.pathname}${target.search}`,
	});
}

// Turn a denied robots verdict into an error message. A matched rule and a
// robots.txt that could not be retrieved are different situations and say
// so: the latter names the cause, says why it is a full disallow, and notes
// that the robots request carries no browser-profile cookies — the usual
// reason a site that loads fine in a browser still fails here.
export function robotsDenialMessage(verdict) {
	const override = "Use --ignore-robots to override.";
	const failure = verdict?.failure;
	if (!failure) {
		return `robots.txt disallows this path (${verdict?.rule}). ${override}`;
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
	return (
		`robots.txt is unreachable: ${cause}. RFC 9309 treats an unreachable ` +
		"robots.txt as disallowing the whole site. The robots.txt request " +
		"sends no browser-profile cookies, so a cookie-gated robots.txt can " +
		`fail here even when the page itself would load. ${override}`
	);
}
