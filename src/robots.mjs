// A small, dependency-free robots.txt parser and matcher.
//
// Scope is deliberately the RFC 9309 baseline: `User-agent` grouping,
// `Allow`/`Disallow` exact-prefix matching (longest match wins, `Allow`
// breaks a tie), and `Crawl-delay`. Google's wildcard (`*`) and end-anchor
// (`$`) path extensions are explicitly out of scope — a path is matched by
// literal prefix comparison only.
//
// This is a politeness mechanism, not a security boundary: anything that
// goes wrong while fetching or parsing robots.txt is treated as "no
// restrictions apply" (RFC 9309 §2.3.1.3).

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

// Fetch `<origin>/robots.txt` and evaluate it for `url`.
//
// Fails open: a network error, a timeout, or any non-2xx status (404
// included) means "no restrictions apply".
export async function checkRobotsAllowed(url, options = {}) {
	const {
		userAgent,
		timeout = ROBOTS_TIMEOUT_MS,
		fetch: fetchImpl = globalThis.fetch,
	} = options;

	let target;
	try {
		target = new URL(url);
	} catch {
		return ALLOWED;
	}
	if (typeof fetchImpl !== "function") return ALLOWED;

	const robotsUrl = new URL("/robots.txt", target).href;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	let text;
	try {
		const response = await fetchImpl(robotsUrl, {
			headers: userAgent ? { "User-Agent": userAgent } : {},
			redirect: "follow",
			signal: controller.signal,
		});
		if (!response?.ok) return ALLOWED;
		text = await response.text();
	} catch {
		return ALLOWED;
	} finally {
		clearTimeout(timer);
	}

	return evaluateRobots(text, {
		userAgent,
		path: `${target.pathname}${target.search}`,
	});
}
