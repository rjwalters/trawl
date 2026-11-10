// Parser/matcher tests for src/robots.mjs. Pure string in, verdict out —
// no network and no browser, so these always run.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { cookieHeaderFor } from "../src/cookies.mjs";
import {
	MAX_CRAWL_DELAY_MS,
	checkRobotsAllowed,
	crawlDelayMs,
	evaluateRobots,
	parseRobotsTxt,
	productToken,
	robotsDenialMessage,
	SAFE_ERROR_CODES,
	safeErrorCode,
	selectGroup,
} from "../src/robots.mjs";

const UA = "trawl/0.1.0 (+https://github.com/rjwalters/trawl)";

function verdict(text, path, userAgent = UA) {
	return evaluateRobots(text, { userAgent, path });
}

test("extracts the product token from a full User-Agent string", () => {
	assert.equal(productToken(UA), "trawl");
	assert.equal(productToken("Trawl"), "trawl");
	assert.equal(productToken(""), "");
	assert.equal(productToken(undefined), "");
});

test("ignores comments, blank lines, and unknown directives", () => {
	const groups = parseRobotsTxt(`
# a comment

Sitemap: https://example.com/sitemap.xml
User-agent: *      # trailing comment
Host: example.com
Disallow: /private/
not a directive
`);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].agents, ["*"]);
	assert.deepEqual(
		groups[0].rules.map((r) => r.line),
		["Disallow: /private/"],
	);
});

test("treats directive names case-insensitively", () => {
	const groups = parseRobotsTxt("USER-AGENT: *\nDISALLOW: /x\nCRAWL-DELAY: 2");
	assert.equal(groups[0].rules[0].path, "/x");
	assert.equal(groups[0].crawlDelay, 2);
});

test("blocks a disallowed prefix and names the matched rule", () => {
	const { allowed, rule } = verdict(
		"User-agent: *\nDisallow: /private/",
		"/private/report.html",
	);
	assert.equal(allowed, false);
	assert.equal(rule, "Disallow: /private/");
});

test("allows a path no rule matches", () => {
	const { allowed, rule } = verdict(
		"User-agent: *\nDisallow: /private/",
		"/public/index.html",
	);
	assert.equal(allowed, true);
	assert.equal(rule, null);
});

test("matches against the query string as well as the path", () => {
	assert.equal(
		verdict("User-agent: *\nDisallow: /s?q=", "/s?q=secret").allowed,
		false,
	);
});

test("longest matching prefix wins", () => {
	const text = "User-agent: *\nDisallow: /a/\nAllow: /a/b/";
	assert.equal(verdict(text, "/a/x").allowed, false);
	const nested = verdict(text, "/a/b/c");
	assert.equal(nested.allowed, true);
	assert.equal(nested.rule, "Allow: /a/b/");
});

test("a longer Disallow beats a shorter Allow", () => {
	const text = "User-agent: *\nAllow: /a/\nDisallow: /a/b/";
	assert.equal(verdict(text, "/a/b/c").allowed, false);
});

test("Allow breaks a tie with Disallow of equal length", () => {
	const text = "User-agent: *\nDisallow: /docs\nAllow: /docs";
	const result = verdict(text, "/docs/intro");
	assert.equal(result.allowed, true);
	assert.equal(result.rule, "Allow: /docs");

	// Declaration order must not change the outcome.
	assert.equal(
		verdict("User-agent: *\nAllow: /docs\nDisallow: /docs", "/docs/intro")
			.allowed,
		true,
	);
});

test("an empty Disallow value allows everything", () => {
	assert.equal(verdict("User-agent: *\nDisallow:", "/anything").allowed, true);
});

test("Disallow: / blocks the whole site", () => {
	assert.equal(verdict("User-agent: *\nDisallow: /", "/").allowed, false);
});

test("a group naming our product token wins over the wildcard group", () => {
	const text = `User-agent: *
Disallow: /

User-agent: trawl
Disallow: /private/`;
	assert.equal(verdict(text, "/public").allowed, true);
	assert.equal(verdict(text, "/private/x").allowed, false);
});

test("User-agent group matching is case-insensitive", () => {
	const text = "User-agent: *\nDisallow: /\n\nUser-agent: TRAWL\nDisallow:";
	assert.equal(verdict(text, "/anything").allowed, true);
});

test("falls back to the wildcard group when no group names us", () => {
	const text = "User-agent: googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /x";
	assert.equal(verdict(text, "/x/y").allowed, false);
});

test("allows everything when no group applies at all", () => {
	const text = "User-agent: googlebot\nDisallow: /";
	assert.equal(verdict(text, "/anything").allowed, true);
});

test("consecutive User-agent lines share one group", () => {
	const text = "User-agent: trawl\nUser-agent: otherbot\nDisallow: /shared/";
	assert.equal(verdict(text, "/shared/x").allowed, false);
});

test("merges repeated groups for the same agent", () => {
	const text = `User-agent: *
Disallow: /a/

User-agent: *
Disallow: /b/`;
	assert.equal(verdict(text, "/a/x").allowed, false);
	assert.equal(verdict(text, "/b/x").allowed, false);
});

test("extracts Crawl-delay from the selected group only", () => {
	const text = `User-agent: *
Crawl-delay: 30
Disallow:

User-agent: trawl
Crawl-delay: 2
Disallow:`;
	assert.equal(verdict(text, "/").crawlDelay, 2);
	assert.equal(
		evaluateRobots(text, { userAgent: "otherbot/1.0", path: "/" }).crawlDelay,
		30,
	);
});

test("ignores a non-numeric Crawl-delay", () => {
	const result = verdict("User-agent: *\nCrawl-delay: soon", "/");
	assert.equal(result.crawlDelay, null);
});

test("clamps Crawl-delay to the documented maximum", () => {
	assert.equal(crawlDelayMs(2), 2000);
	assert.equal(crawlDelayMs(86400), MAX_CRAWL_DELAY_MS);
	assert.equal(crawlDelayMs(0), 0);
	assert.equal(crawlDelayMs(null), 0);
	assert.equal(crawlDelayMs(undefined), 0);
});

test("survives empty and garbage input without throwing", () => {
	assert.equal(verdict("", "/x").allowed, true);
	assert.equal(verdict("\x00\x01 nonsense ][", "/x").allowed, true);
	assert.equal(verdict(undefined, "/x").allowed, true);
	assert.equal(selectGroup([], UA), null);
});

test("ignores rules that appear before any User-agent line", () => {
	const text = "Disallow: /\nUser-agent: *\nDisallow:";
	assert.equal(verdict(text, "/x").allowed, true);
});

// --- checkRobotsAllowed, with fetch injected (still no network) ---

const ok = (body) => ({ ok: true, status: 200, text: async () => body });

test("fetches /robots.txt at the origin root and evaluates the path", async () => {
	const seen = [];
	const result = await checkRobotsAllowed(
		"https://example.com/private/deep/page?x=1",
		{
			userAgent: UA,
			fetch: async (url, init) => {
				seen.push([url, init.headers["User-Agent"]]);
				return ok("User-agent: *\nDisallow: /private/");
			},
		},
	);
	assert.deepEqual(seen, [["https://example.com/robots.txt", UA]]);
	assert.equal(result.allowed, false);
	assert.equal(result.rule, "Disallow: /private/");
});

// RFC 9309 §2.3.1.3: any 4xx means "unavailable" — no restrictions apply.
// 429 stays in this class; persistent throttling is separate work (#39).
for (const status of [400, 401, 403, 404, 410, 429]) {
	test(`allows everything on a ${status} robots.txt`, async () => {
		const result = await checkRobotsAllowed("https://example.com/private/x", {
			userAgent: UA,
			fetch: async () => ({
				ok: false,
				status,
				text: async () => "User-agent: *\nDisallow: /",
			}),
		});
		assert.deepEqual(result, { allowed: true, rule: null, crawlDelay: null });
	});
}

test("a 204 (empty body) is parsed, not treated as a failure", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		fetch: async () => ({ ok: true, status: 204, text: async () => "" }),
	});
	assert.deepEqual(result, { allowed: true, rule: null, crawlDelay: null });
});

test("a 200 with malformed text stays on the parser path", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		fetch: async () => ok("  nonsense ][\n<html>503</html>"),
	});
	assert.equal(result.allowed, true);
	assert.equal(result.failure, undefined);
});

// RFC 9309 §2.3.1.4: a server error means "unreachable" — complete disallow.
for (const status of [500, 502, 503, 599]) {
	test(`denies everything on a ${status} robots.txt, with no fictitious rule`, async () => {
		const result = await checkRobotsAllowed("https://example.com/public/x", {
			userAgent: UA,
			fetch: async () => ({
				ok: false,
				status,
				// Even a permissive body must not be consulted.
				text: async () => "User-agent: *\nDisallow:",
			}),
		});
		assert.equal(result.allowed, false);
		assert.equal(result.rule, null);
		assert.deepEqual(result.failure, {
			url: "https://example.com/robots.txt",
			kind: "server-error",
			status,
		});
	});
}

test("denies on a network error and names the cause", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		fetch: async () => {
			// The shape Node's fetch actually throws.
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				}),
			});
		},
	});
	assert.equal(result.allowed, false);
	assert.equal(result.rule, null);
	assert.equal(result.failure.kind, "network-error");
	assert.equal(result.failure.detail, "ECONNREFUSED");
	assert.equal(result.failure.status, undefined);
});

test("denies on a plain thrown error", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		fetch: async () => {
			throw new Error("boom");
		},
	});
	assert.equal(result.allowed, false);
	assert.equal(result.failure.kind, "network-error");
	assert.equal(result.failure.detail, "boom");
});

test("denies when the robots.txt fetch times out awaiting headers", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		timeout: 10,
		fetch: (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			}),
	});
	assert.equal(result.allowed, false);
	assert.equal(result.rule, null);
	assert.deepEqual(result.failure, {
		url: "https://example.com/robots.txt",
		kind: "timeout",
		timeout: 10,
	});
});

test("denies when the robots.txt body read times out", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		timeout: 10,
		fetch: async (_url, init) => ({
			ok: true,
			status: 200,
			text: () =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
		}),
	});
	assert.equal(result.allowed, false);
	assert.equal(result.rule, null);
	assert.equal(result.failure.kind, "timeout");
});

test("denies when the body read fails after a 2xx", async () => {
	const result = await checkRobotsAllowed("https://example.com/private/x", {
		userAgent: UA,
		fetch: async () => ({
			ok: true,
			status: 200,
			text: async () => {
				throw new Error("terminated");
			},
		}),
	});
	assert.equal(result.allowed, false);
	assert.equal(result.rule, null);
	assert.deepEqual(result.failure, {
		url: "https://example.com/robots.txt",
		kind: "read-error",
		status: 200,
		detail: "terminated",
	});
});

test("clears its timer once the fetch settles", async () => {
	// A leaked 10s timer would hold the event loop open; settle fast and make
	// sure nothing aborts afterwards.
	let signal;
	await checkRobotsAllowed("https://example.com/x", {
		timeout: 20,
		fetch: async (_url, init) => {
			signal = init.signal;
			return ok("");
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(signal.aborted, false);
});

test("never sends userinfo from the page URL to robots.txt", async () => {
	const seen = [];
	await checkRobotsAllowed("https://user:secret@example.com/x", {
		fetch: async (url) => {
			seen.push(url);
			return ok("");
		},
	});
	assert.deepEqual(seen, ["https://example.com/robots.txt"]);
});

// --- the `gate` hook (cross-run pacing waits here, before the fetch) ---

test("gate wraps the fetch: nothing is sent until it calls start()", async () => {
	const events = [];
	const result = await checkRobotsAllowed("https://example.com/x", {
		fetch: async () => {
			events.push("fetch");
			return ok("User-agent: *\nCrawl-delay: 2\n");
		},
		gate: async (start) => {
			events.push("gate");
			await new Promise((resolve) => setTimeout(resolve, 5));
			events.push("start");
			return start();
		},
	});
	assert.deepEqual(events, ["gate", "start", "fetch"]);
	assert.equal(result.allowed, true);
	assert.equal(result.crawlDelay, 2);
});

test("time spent waiting in the gate does not count against the robots timeout", async () => {
	const result = await checkRobotsAllowed("https://example.com/x", {
		timeout: 20,
		fetch: async (_url, init) => {
			assert.equal(init.signal.aborted, false);
			return ok("");
		},
		gate: async (start) => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return start();
		},
	});
	assert.equal(result.allowed, true);
	assert.equal(result.failure, undefined);
});

test("an error from the gate before start() propagates instead of reading as a network error", async () => {
	let fetched = false;
	await assert.rejects(
		checkRobotsAllowed("https://example.com/x", {
			fetch: async () => {
				fetched = true;
				return ok("");
			},
			gate: async () => {
				throw new Error("pacing: gave up");
			},
		}),
		/pacing: gave up/,
	);
	assert.equal(fetched, false);
});

test("a fetch failure inside the gate is still a network-error verdict", async () => {
	const result = await checkRobotsAllowed("https://example.com/x", {
		fetch: async () => {
			throw new Error("boom");
		},
		gate: (start) => start(),
	});
	assert.equal(result.allowed, false);
	assert.equal(result.failure.kind, "network-error");
});

// --- robotsDenialMessage ---

test("a matched-rule denial keeps the existing wording", () => {
	assert.equal(
		robotsDenialMessage({ allowed: false, rule: "Disallow: /x" }),
		"robots.txt disallows this path (Disallow: /x). Use --ignore-robots to override.",
	);
});

test("each retrieval failure names robots.txt, its cause, cookies, and the override", () => {
	const url = "https://example.com/robots.txt";
	const cases = [
		[{ kind: "server-error", status: 503 }, /returned HTTP 503 \(server error\)/],
		[{ kind: "network-error", detail: "ENOTFOUND" }, /network error: ENOTFOUND/],
		[{ kind: "timeout", timeout: 10000 }, /timed out after 10000ms/],
		[{ kind: "read-error", status: 200, detail: "terminated" }, /reading the body of .* failed \(terminated\)/],
	];
	for (const [failure, cause] of cases) {
		const message = robotsDenialMessage({
			allowed: false,
			rule: null,
			failure: { url, ...failure },
		});
		assert.match(message, /^robots\.txt is unreachable: /);
		assert.ok(message.includes(url), message);
		assert.match(message, cause);
		assert.doesNotMatch(message, /disallows this path/);
		assert.match(message, /no browser-profile cookies/);
		assert.match(message, /Use --ignore-robots to override\.$/);
	}
});

// --- the Cookie header (#79) ---

test("a cookie string is sent as the Cookie header, and only when given", async () => {
	const seen = [];
	const fetch = async (_url, init) => {
		seen.push(init.headers);
		return ok("User-agent: *\nDisallow:\n");
	};
	await checkRobotsAllowed("https://example.com/", { userAgent: UA, fetch, cookie: "a=1; b=2" });
	await checkRobotsAllowed("https://example.com/", { userAgent: UA, fetch });
	await checkRobotsAllowed("https://example.com/", { userAgent: UA, fetch, cookie: "" });
	assert.deepEqual(seen, [
		{ "User-Agent": UA, Cookie: "a=1; b=2" },
		{ "User-Agent": UA },
		{ "User-Agent": UA },
	]);
});

test("a cookie never reaches the verdict or the denial message", async () => {
	const secret = "s3cr3t-c00kie-VALUE";
	const verdicts = [
		await checkRobotsAllowed("https://example.com/", {
			cookie: `k=${secret}`,
			fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
		}),
		await checkRobotsAllowed("https://example.com/", {
			cookie: `k=${secret}`,
			fetch: async () => {
				throw new Error("boom");
			},
		}),
	];
	for (const v of verdicts) {
		assert.equal(v.allowed, false);
		const message = robotsDenialMessage(v, { sentCookies: true });
		assert.ok(!JSON.stringify(v).includes(secret));
		assert.ok(!message.includes(secret), message);
		assert.doesNotMatch(message, /no browser-profile cookies/);
		assert.match(message, /^robots\.txt is unreachable: .*Use --ignore-robots to override\.$/);
	}
});

// --- the Cookie header goes out as UTF-8 bytes, encoded once (#89) ---

test("checkRobotsAllowed sends a ready byte-string cookie header unchanged and does not throw", async () => {
	let raw;
	const server = createServer((req, res) => {
		raw = req.rawHeaders;
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("User-agent: *\nDisallow:\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		const url = `http://127.0.0.1:${server.address().port}/page`;
		for (const [value, hex] of [
			["snow\u2603man", "736e6f77e298836d616e"],
			["caf\u00e9", "636166c3a9"],
		]) {
			raw = undefined;
			const v = await checkRobotsAllowed(url, { cookie: cookieHeaderFor([{ name: "p", value, domain: "127.0.0.1", path: "/" }], `${new URL(url).origin}/robots.txt`) });
			assert.deepEqual(v, { allowed: true, rule: null, crawlDelay: null });
			const header = raw[raw.findIndex((h) => h.toLowerCase() === "cookie") + 1];
			assert.equal(Buffer.from(header, "latin1").toString("hex"), `703d${hex}`);
		}
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("without sentCookies the cookie note is kept verbatim", () => {
	const verdict = { allowed: false, rule: null, failure: { url: "https://e.com/robots.txt", kind: "server-error", status: 503 } };
	assert.equal(robotsDenialMessage(verdict), robotsDenialMessage(verdict, { sentCookies: false }));
	assert.equal(
		robotsDenialMessage(verdict, { sentCookies: true }),
		"robots.txt is unreachable: https://e.com/robots.txt returned HTTP 503 (server error). RFC 9309 treats an unreachable robots.txt as disallowing the whole site. Use --ignore-robots to override.",
	);
});

// --- #87: with a Cookie header sent, a failure is a code or fixed text ---

// Every character JSON or URL encoding rewrites, so an echo in any encoding
// differs from the raw value; any 6-character run of it counts as a leak.
const AWKWARD = 'aw"KW\\rd/V4l+u3=Zq-77Xk';

function assertNoValue(haystacks, value = AWKWARD) {
	const forms = [value, encodeURIComponent(value), JSON.stringify(value)];
	for (let i = 0; i + 6 <= value.length; i++) forms.push(value.slice(i, i + 6));
	for (const h of haystacks) {
		for (const f of forms) assert.ok(!h.includes(f), `leaked ${JSON.stringify(f)} in ${JSON.stringify(h)}`);
	}
}

// Errors that quote the header everywhere an error can carry text.
function quotingErrors(header) {
	const quoted = `Headers.append: "${header}" is an invalid header value.`;
	const withStack = new TypeError(quoted);
	withStack.stack = `TypeError: ${quoted}\n    at ${header}`;
	return [
		new TypeError(quoted),
		withStack,
		new TypeError("fetch failed", { cause: new Error(quoted) }),
		new TypeError("fetch failed", { cause: quoted }),
		Object.assign(new TypeError("fetch failed"), { header, headers: { cookie: header }, code: header }),
		Object.assign(new TypeError("fetch failed"), { cause: { code: header, message: header } }),
		// A code that contains an allowlisted one is not that code.
		Object.assign(new TypeError("fetch failed"), { cause: { code: `ECONNREFUSED ${header}` } }),
		header, // a thrown string
		{ message: header, toString: () => header },
	];
}

test("with a cookie sent, the failure detail is fixed text, whatever the error says", async () => {
	const header = `k=${AWKWARD}`;
	for (const err of quotingErrors(header)) {
		for (const where of ["fetch", "body"]) {
			const fetch =
				where === "fetch"
					? async () => {
							throw err;
						}
					: async () => ({ ok: true, status: 200, text: async () => Promise.reject(err) });
			const v = await checkRobotsAllowed("https://example.com/", { cookie: header, fetch });
			assert.equal(v.allowed, false);
			assert.equal(v.failure.kind, where === "fetch" ? "network-error" : "read-error");
			assert.equal(v.failure.detail, "request failed");
			const message = robotsDenialMessage(v, { sentCookies: true });
			assert.ok(message.includes("(network error: request failed)") || message.includes("failed (request failed)"), message);
			assertNoValue([JSON.stringify(v), message]);
		}
	}
});

test("with a cookie sent, an allowlisted code is kept, read from cause first", async () => {
	const header = `k=${AWKWARD}`;
	const run = (err) =>
		checkRobotsAllowed("https://example.com/", {
			cookie: header,
			fetch: async () => {
				throw err;
			},
		});
	const cases = [
		[new TypeError(`fetch failed ${header}`, { cause: Object.assign(new Error(header), { code: "ECONNREFUSED" }) }), "ECONNREFUSED"],
		[Object.assign(new Error(header), { code: "UND_ERR_SOCKET" }), "UND_ERR_SOCKET"],
		[Object.assign(new Error(header), { code: "ENOTFOUND", cause: { code: "ECONNRESET" } }), "ECONNRESET"],
		// cause.code not allowlisted: falls through to err.code.
		[Object.assign(new Error(header), { code: "EAI_AGAIN", cause: { code: header } }), "EAI_AGAIN"],
	];
	for (const [err, code] of cases) {
		const v = await run(err);
		assert.equal(v.failure.detail, code);
		const message = robotsDenialMessage(v, { sentCookies: true });
		assert.ok(message.includes(`(network error: ${code})`), message);
		assertNoValue([JSON.stringify(v), message]);
	}
});

test("safeErrorCode reads defensively: throwing getters and odd shapes are no code", () => {
	const throwing = (key) =>
		Object.defineProperty(new Error("x"), key, {
			get() {
				throw new Error(`getter k=${AWKWARD}`);
			},
		});
	assert.equal(safeErrorCode(throwing("code")), undefined);
	assert.equal(safeErrorCode(throwing("cause")), undefined);
	const causeThrows = Object.assign(throwing("cause"), { code: "ECONNRESET" });
	assert.equal(safeErrorCode(causeThrows), "ECONNRESET");
	const proxy = new Proxy({}, { get() { throw new Error(AWKWARD); } });
	assert.equal(safeErrorCode(proxy), undefined);
	for (const odd of [undefined, null, 0, "ECONNREFUSED", { code: 1 }, { code: ["ECONNREFUSED"] }, { code: "econnrefused" }]) {
		assert.equal(safeErrorCode(odd), undefined);
	}
	assert.ok(SAFE_ERROR_CODES.has("ECONNREFUSED") && SAFE_ERROR_CODES.has("UND_ERR_SOCKET"));
	for (const code of SAFE_ERROR_CODES) assert.match(code, /^[A-Z][A-Z0-9_]+$/);
});

test("with a cookie sent, a throwing getter on the error does not escape", async () => {
	for (const key of ["message", "cause", "code"]) {
		const err = Object.defineProperty(new Error("x"), key, {
			get() {
				throw new Error(`getter k=${AWKWARD}`);
			},
		});
		const v = await checkRobotsAllowed("https://example.com/", {
			cookie: `k=${AWKWARD}`,
			fetch: async () => {
				throw err;
			},
		});
		assert.equal(v.failure.detail, "request failed");
	}
});

test("without a cookie the error is described as before (cookie-less runs unchanged)", async () => {
	const cases = [
		[new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }), "ECONNREFUSED"],
		[new TypeError("fetch failed", { cause: new Error("bad port") }), "bad port"],
		[Object.assign(new Error("boom"), { code: "NOT_ALLOWLISTED" }), "NOT_ALLOWLISTED"],
		[new Error("boom"), "boom"],
	];
	for (const cookie of [undefined, ""]) {
		for (const [err, detail] of cases) {
			const v = await checkRobotsAllowed("https://example.com/", {
				...(cookie !== undefined && { cookie }),
				fetch: async () => {
					throw err;
				},
			});
			assert.equal(v.failure.detail, detail);
		}
	}
});

// --- #93: the cookie note on --profile, and the plain wording pinned ---

test("the plain-path cookie note is byte-identical; --profile gets its own fixed note", () => {
	const verdict = { allowed: false, rule: null, failure: { url: "https://e.com/robots.txt", kind: "server-error", status: 503 } };
	const head = "robots.txt is unreachable: https://e.com/robots.txt returned HTTP 503 (server error). RFC 9309 treats an unreachable robots.txt as disallowing the whole site. ";
	assert.equal(
		robotsDenialMessage(verdict),
		`${head}The robots.txt request sends no browser-profile cookies, so a cookie-gated robots.txt can fail here even when the page itself would load. Use --ignore-robots to override.`,
	);
	assert.equal(
		robotsDenialMessage(verdict, { profile: true }),
		`${head}No cookie from the profile matched robots.txt, so the request carried none, and a cookie-gated robots.txt can fail here even when the page itself would load. Use --ignore-robots to override.`,
	);
	// With cookies sent there is no note on either path.
	assert.equal(robotsDenialMessage(verdict, { sentCookies: true, profile: true }), `${head}Use --ignore-robots to override.`);
	// A matched rule never had a note.
	assert.equal(
		robotsDenialMessage({ allowed: false, rule: "Disallow: /" }, { profile: true }),
		"robots.txt disallows this path (Disallow: /). Use --ignore-robots to override.",
	);
});

// --- #93: a cross-origin redirect drops the Cookie header; say so ---

const REDIRECT_HINT =
	"The robots.txt request was redirected to another origin, and cookies are not sent across a cross-origin redirect, so a cookie-gated robots.txt there was requested without them. ";

// Two local servers (two ports, so two origins). `a` redirects /robots.txt to
// `to(a, b)`; `b` serves a robots.txt that answers 503 without `gate=open`,
// or `body` with it. Records each robots request's Cookie header.
async function redirectRig({ to, body = "User-agent: *\nDisallow:\n" }) {
	const seen = [];
	const handler = (name) => (req, res) => {
		seen.push({ at: name, url: req.url, cookie: req.headers.cookie ?? null });
		if (name === "a" && req.url === "/robots.txt") {
			res.writeHead(301, { location: to(origins) });
			return res.end();
		}
		const open = (req.headers.cookie ?? "").split("; ").includes("gate=open");
		res.writeHead(open ? 200 : 503, { "content-type": "text/plain" });
		res.end(open ? body : "busy");
	};
	const a = createServer(handler("a"));
	const b = createServer(handler("b"));
	await Promise.all([a, b].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
	const origins = { a: `http://127.0.0.1:${a.address().port}`, b: `http://127.0.0.1:${b.address().port}` };
	return {
		...origins,
		seen,
		close: () => Promise.all([a, b].map((s) => new Promise((r) => s.close(r)))),
	};
}

test("a cookie-carrying robots.txt redirected to another origin is refused with a fixed hint", async () => {
	const rig = await redirectRig({ to: (o) => `${o.b}/robots.txt` });
	try {
		const v = await checkRobotsAllowed(`${rig.a}/page`, { userAgent: UA, cookie: "gate=open" });
		// The second hop went without the header (Node fetch), so the gate shut.
		assert.deepEqual(
			rig.seen.map((s) => [s.at, s.cookie]),
			[["a", "gate=open"], ["b", null]],
		);
		assert.deepEqual(v, {
			allowed: false,
			rule: null,
			crawlDelay: null,
			failure: { url: `${rig.a}/robots.txt`, kind: "server-error", status: 503 },
			crossOriginRedirect: true,
		});
		const message = robotsDenialMessage(v, { sentCookies: true });
		assert.equal(
			message,
			`robots.txt is unreachable: ${rig.a}/robots.txt returned HTTP 503 (server error). RFC 9309 treats an unreachable robots.txt as disallowing the whole site. ${REDIRECT_HINT}Use --ignore-robots to override.`,
		);
		// Fixed text: the final URL is not named.
		assert.ok(!message.includes(rig.b), message);
		assert.equal(robotsDenialMessage(v, { sentCookies: true, profile: true }), message);
	} finally {
		await rig.close();
	}
});

test("a matched-rule denial after a cross-origin redirect carries no hint", async () => {
	const rig = await redirectRig({ to: (o) => `${o.b}/robots.txt` });
	try {
		const v = await checkRobotsAllowed(`${rig.a}/page`, {
			userAgent: UA,
			cookie: "x=1",
			fetch: async (url, init) => {
				const r = await fetch(url, init);
				// The real redirect's `redirected` and `url`, with a disallowing
				// robots.txt in place of `b`'s 503.
				return { ok: true, status: 200, redirected: r.redirected, url: r.url, text: async () => "User-agent: *\nDisallow: /\n" };
			},
		});
		assert.equal(v.crossOriginRedirect, true);
		assert.equal(
			robotsDenialMessage(v, { sentCookies: true }),
			"robots.txt disallows this path (Disallow: /). Use --ignore-robots to override.",
		);
	} finally {
		await rig.close();
	}
});

test("no hint without a Cookie header: the verdict and message are as before", async () => {
	const rig = await redirectRig({ to: (o) => `${o.b}/robots.txt` });
	try {
		for (const cookie of [undefined, ""]) {
			const v = await checkRobotsAllowed(`${rig.a}/page`, { userAgent: UA, ...(cookie !== undefined && { cookie }) });
			assert.deepEqual(v, {
				allowed: false,
				rule: null,
				crawlDelay: null,
				failure: { url: `${rig.a}/robots.txt`, kind: "server-error", status: 503 },
			});
			assert.doesNotMatch(robotsDenialMessage(v), /redirected/);
		}
	} finally {
		await rig.close();
	}
});

test("a same-origin redirect keeps the Cookie header and gets no hint", async () => {
	const rig = await redirectRig({ to: (o) => `${o.a}/real-robots.txt`, body: "User-agent: *\nDisallow: /page\n" });
	try {
		const v = await checkRobotsAllowed(`${rig.a}/page`, { userAgent: UA, cookie: "gate=open" });
		assert.deepEqual(
			rig.seen.map((s) => [s.at, s.url, s.cookie]),
			[
				["a", "/robots.txt", "gate=open"],
				["a", "/real-robots.txt", "gate=open"],
			],
		);
		assert.deepEqual(v, { allowed: false, rule: "Disallow: /page", crawlDelay: null });
		// Allowed through a cross-origin redirect: nothing to hint at.
		const ok2 = await checkRobotsAllowed(`${rig.a}/other`, { userAgent: UA, cookie: "gate=open" });
		assert.deepEqual(ok2, { allowed: true, rule: null, crawlDelay: null });
	} finally {
		await rig.close();
	}
});

test("the redirect check reads defensively: odd or throwing responses get no hint", async () => {
	const responses = [
		{ ok: false, status: 503, text: async () => "" },
		{ ok: false, status: 503, redirected: true, text: async () => "" },
		{ ok: false, status: 503, redirected: true, url: "", text: async () => "" },
		{ ok: false, status: 503, redirected: true, url: "not a url", text: async () => "" },
		{ ok: false, status: 503, redirected: "yes", url: "https://other.example/robots.txt", text: async () => "" },
		{ ok: false, status: 503, redirected: true, url: "https://example.com/elsewhere", text: async () => "" },
		Object.defineProperty({ ok: false, status: 503, text: async () => "" }, "redirected", {
			get() {
				throw new Error("k=s3cr3t");
			},
		}),
	];
	for (const response of responses) {
		const v = await checkRobotsAllowed("https://example.com/", { cookie: "k=1", fetch: async () => response });
		assert.equal(v.allowed, false);
		assert.equal(v.crossOriginRedirect, undefined);
	}
	// http -> https on the same host is another origin.
	const v = await checkRobotsAllowed("http://example.com/", {
		cookie: "k=1",
		fetch: async () => ({ ok: false, status: 503, redirected: true, url: "https://example.com/robots.txt", text: async () => "" }),
	});
	assert.equal(v.crossOriginRedirect, true);
});
