// Render a URL in headless Chromium and extract it in a requested shape.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import TurndownService from "turndown";
import { resolveExecutablePath } from "./browser.mjs";
import { addCookiesFailure, cookieHeaderFor } from "./cookies.mjs";
import {
	COOLDOWN_STATUSES,
	CooldownError,
	cooldownOrigin,
	createCooldownStore,
} from "./cooldown.mjs";
import {
	DEFAULT_MIN_INTERVAL_MS,
	createPacer,
	defaultStateDir,
	pacingOrigin,
	validateMinInterval,
} from "./pacing.mjs";
import {
	ROBOTS_TIMEOUT_MS,
	checkRobotsAllowed,
	crawlDelayMs,
	requestFetch,
	robotsDenialMessage,
} from "./robots.mjs";

export { CooldownError };

export const FORMATS = ["text", "html", "links", "title", "markdown"];

const DEFAULTS = {
	format: "text",
	waitUntil: "networkidle",
	settle: 0,
	timeout: 30000,
	viewport: { width: 1280, height: 2000 },
	readability: true,
	authCheck: true,
};

// Thrown instead of returning a body when the rendered page looks like a
// login/auth wall rather than the content the caller asked for. A distinct
// `name` (and the CLI's dedicated exit code 3) lets a calling agent tell
// "the page needs a human to sign in" apart from every other failure mode
// instead of silently treating the login-wall HTML as real content.
export class AuthWallError extends Error {
	constructor(reasons, url) {
		super(
			`page appears to be behind a login wall (matched: ${reasons.join("; ")}). ` +
				"This page needs an authenticated browser session — ask your user to " +
				"sign in with `trawl login <origin> --profile <dir>`, then retry with " +
				"--profile <dir> (or pass --no-auth-check if this isn't actually a login wall).",
		);
		this.name = "AuthWallError";
		this.reasons = reasons;
		this.url = url;
	}
}

// Thrown when a click step cannot run: its selector never became visible,
// its `waitFor` never appeared, or the click tried to navigate the page away.
// `step` is 1-based so it matches the order the caller wrote the steps in.
export class ClickError extends Error {
	constructor(message, { step, selector, waitFor } = {}) {
		super(message);
		this.name = "ClickError";
		this.step = step;
		this.selector = selector;
		this.waitFor = waitFor;
	}
}

// Accepts `click` as a string, or an array of strings and/or
// `{ selector, waitFor }` objects, and returns `[{ selector, waitFor }]`.
// Pure, so the CLI and library callers fail the same way on bad input, and
// before any network or browser work.
export function normalizeClickSteps(click) {
	if (click === undefined || click === null) return [];
	const list = Array.isArray(click) ? click : [click];
	return list.map((step, i) => {
		const where = `click step ${i + 1}`;
		const obj = typeof step === "string" ? { selector: step } : step;
		if (!obj || typeof obj !== "object") {
			throw new Error(
				`${where}: expected a CSS selector string or { selector, waitFor }`,
			);
		}
		const { selector, waitFor } = obj;
		if (typeof selector !== "string" || selector.trim() === "") {
			throw new Error(`${where}: selector must be a non-empty CSS selector`);
		}
		if (
			waitFor !== undefined &&
			waitFor !== null &&
			(typeof waitFor !== "string" || waitFor.trim() === "")
		) {
			throw new Error(`${where}: waitFor must be a non-empty CSS selector`);
		}
		return waitFor ? { selector, waitFor } : { selector };
	});
}

// The least a click step pauses after its click (and `waitFor`), whatever
// `settle` says. Click handlers often navigate on a short timer or after a
// microtask hop; this floor gives such a navigation time to reach the route
// below while its step is still the current one, so it fails the run naming
// the right step instead of racing the end of the run. Same idea as the 1s
// floor on the networkidle fallback.
const CLICK_SETTLE_FLOOR_MS = 250;

const isTimeout = (err) =>
	err?.name === "TimeoutError" || /Timeout .*exceeded/.test(err?.message ?? "");

// Press each step's element in order, on the page that is already loaded.
// A click only presses an element already on the page: a click that tries to
// load a different top-level document (a link, a form submit, a popup or
// `target=_blank`, a script that sets `location` a moment later) is aborted
// before the request leaves and fails the run, so a run still makes exactly
// one page request and every request trawl makes stays paced.
//
// The route stays on the context for the rest of the run, through
// extraction and the screenshot, until the context closes: a handler can
// navigate any number of milliseconds after its click, and a guard that ended
// with the clicks would let that request out and hand back the other page.
// Returns `checkNavigation`, which the caller runs once more right before it
// returns results, so a navigation stopped at any point after a click fails
// the run. (Routing turns Playwright's HTTP cache off for the requests the
// page makes after this point; the document and its first subresources have
// already loaded, so that costs close to nothing.)
async function runClickSteps(page, context, steps, { timeout, settle }) {
	let current = 0;
	// The first top-level navigation a click set off: its URL and the step
	// that was running when it was stopped.
	let blocked = null;
	const handler = (route) => {
		const request = route.request();
		let topLevel = false;
		if (request.isNavigationRequest()) {
			try {
				topLevel = request.frame().parentFrame() === null;
			} catch {
				// A popup's first navigation is sent before its frame exists, so
				// `frame()` throws. That is a new top-level page: block it.
				topLevel = true;
			}
		}
		if (!topLevel) return route.fallback();
		blocked ??= { url: request.url(), step: current };
		// "aborted", not "blockedbyclient": the latter makes Chromium commit
		// its own error page over the loaded document, which would then be
		// extracted as an empty body.
		return route.abort("aborted");
	};
	const checkNavigation = () => {
		if (!blocked) return;
		const { url, step } = blocked;
		const { selector, waitFor } = steps[step - 1];
		throw new ClickError(
			`click step ${step} of ${steps.length} ("${selector}"): the click ` +
				`tried to navigate to ${url}; trawl clicks only to reveal content ` +
				"on the loaded page — fetch that URL directly instead",
			{ step, selector, waitFor },
		);
	};

	await context.route("**/*", handler);
	const ms = timeout > 0 ? `${timeout}ms` : "the timeout";
	for (let i = 0; i < steps.length; i++) {
		const { selector, waitFor } = steps[i];
		const step = i + 1;
		current = step;
		const label = `click step ${step} of ${steps.length} ("${selector}")`;
		// The first match in document order, so a selector that matches
		// several buttons presses one instead of tripping strict mode.
		const target = page.locator(selector).first();
		try {
			await target.waitFor({ state: "visible", timeout });
			await target.click({ timeout });
		} catch (err) {
			if (!isTimeout(err)) throw err;
			throw new ClickError(
				`${label}: no visible, clickable element matched within ${ms}`,
				{ step, selector, waitFor },
			);
		}
		checkNavigation();
		if (waitFor) {
			try {
				await page
					.locator(waitFor)
					.first()
					.waitFor({ state: "visible", timeout });
			} catch (err) {
				// A navigation stopped while waiting is the better explanation
				// for a `waitFor` that never appeared.
				checkNavigation();
				if (!isTimeout(err)) throw err;
				throw new ClickError(
					`${label}: "${waitFor}" did not appear within ${ms} after the click`,
					{ step, selector, waitFor },
				);
			}
		}
		await page.waitForTimeout(Math.max(settle, CLICK_SETTLE_FLOOR_MS));
		// Again after the wait and settle: a handler that navigates a
		// moment after the click must fail the run, never pass silently.
		checkNavigation();
	}
	checkNavigation();
	return checkNavigation;
}

// Heuristics only — deliberately biased toward false positives over silently
// returning login-wall HTML as if it were the page. A caller that knows
// better has `--no-auth-check` / `authCheck: false`.
const AUTH_TEXT_MAX_CHARS = 200;
const AUTH_KEYWORDS = [
	"sign in",
	"log in",
	"login",
	"authenticate",
	"continue with",
];
// Prefix match against the pathname, so `/login`, `/login/`, and
// `/login?next=/` all count but `/blog/login-tips` does not.
const AUTH_PATH_RE = /^\/(login|log-in|signin|sign-in|oauth2?|auth)(?:\/|$)/i;
const AUTH_HOST_SUFFIXES = [
	"accounts.google.com",
	"appleid.apple.com",
	"login.microsoftonline.com",
	"login.live.com",
];

// Pure and browser-free so it's unit-testable without Chromium: given the
// signals a rendered page can offer, decide whether it looks like an auth
// wall and why. Returns the list of matched reasons (empty = not a wall).
export function detectAuthWall({ text, hasPasswordField, url } = {}) {
	const reasons = [];

	const trimmed = (text ?? "").trim();
	if (trimmed && trimmed.length < AUTH_TEXT_MAX_CHARS) {
		const lower = trimmed.toLowerCase();
		const keyword = AUTH_KEYWORDS.find((kw) => lower.includes(kw));
		if (keyword) {
			reasons.push(`tiny text (${trimmed.length} chars) contains "${keyword}"`);
		}
	}

	if (hasPasswordField) {
		reasons.push("page has a form with a password field");
	}

	if (url) {
		try {
			const { hostname, pathname } = new URL(url);
			const hostHit = AUTH_HOST_SUFFIXES.find(
				(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
			);
			if (hostHit) {
				reasons.push(`URL matches a known auth provider (${hostHit})`);
			} else if (AUTH_PATH_RE.test(pathname)) {
				reasons.push(`URL path looks like a login page (${pathname})`);
			}
		} catch {
			// Not a parseable absolute URL (shouldn't happen for page.url(), but
			// this check is purely advisory — never let it throw).
		}
	}

	return reasons;
}

// Probes the live page for the signals `detectAuthWall` needs. Kept separate
// from `detectAuthWall` so the decision logic stays testable without a
// browser, while this half is exercised by the render() end-to-end tests.
async function probeAuthWall(page) {
	const text = await page
		.locator("body")
		.innerText()
		.catch(() => "");
	const hasPasswordField =
		(await page.$('form input[type="password"]').catch(() => null)) !== null;
	return detectAuthWall({ text, hasPasswordField, url: page.url() });
}

// Identify ourselves honestly by default, and link somewhere an operator can
// read what this is and block it if they want. Only a fallback: an explicit
// `userAgent` option (or the CLI's -A/--user-agent) still wins outright.
let cachedUserAgent = null;
export async function defaultUserAgent() {
	if (cachedUserAgent) return cachedUserAgent;
	let version = "0";
	try {
		const { default: pkg } = await import("../package.json", {
			with: { type: "json" },
		});
		version = pkg.version;
	} catch {
		// Packaged oddly or read-restricted — the link matters more than the
		// exact version.
	}
	cachedUserAgent = `trawl/${version} (+https://github.com/rjwalters/trawl)`;
	return cachedUserAgent;
}

// robots.txt only means something over http(s). `file:` (and anything else)
// has no origin to fetch a robots.txt from, so the check is skipped entirely.
function isHttpUrl(url) {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Readability ships a browser-ready build alongside its Node entry point; we
// inject that file into the page rather than pulling a second DOM
// implementation (jsdom) into Node just to re-parse markup Chromium already
// parsed correctly.
const require = createRequire(import.meta.url);
const READABILITY_PATH = require.resolve("@mozilla/readability/Readability.js");

function markdownConverter() {
	// Turndown's defaults are setext headings and 4-space-indented code; both
	// lose information the moment output is re-parsed, so pin the ATX/fenced
	// forms every Markdown consumer expects.
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
}

// Readability's own README documents running it against a live `document`, so
// hand it the DOM the browser already built (cloned — `parse()` mutates it).
// Returns null when the page has no article-like content.
async function readArticle(page, selector) {
	await page.addScriptTag({ path: READABILITY_PATH });
	return await page.evaluate((sel) => {
		const doc = document.cloneNode(true);
		if (sel) {
			const el = doc.querySelector(sel);
			if (!el) return null;
			// Narrow the clone to the requested scope so --selector still means
			// something; skip when the selector already names the root.
			if (el !== doc.body && el !== doc.documentElement) {
				doc.body.replaceChildren(el);
			}
		}
		// `Readability` is a global declared by the script injected above.
		const article = new Readability(doc).parse();
		if (!article) return null;
		return { title: article.title ?? "", content: article.content ?? "" };
	}, selector ?? null);
}

async function scopedHtml(page, scope) {
	const locator = page.locator(scope);
	const count = await locator.count();
	const parts = [];
	for (let i = 0; i < count; i++) {
		parts.push(await locator.nth(i).innerHTML());
	}
	return parts.join("\n");
}

async function extractMarkdown(page, { selector, readability }) {
	const turndown = markdownConverter();

	if (readability !== false) {
		// Belt-and-braces: `render()` sets `bypassCSP` for this path so the
		// injected <script> survives a nonce/hash-based script-src, but an
		// injection can still fail for reasons we don't control (a page that
		// navigates away mid-extraction, a sandboxed frame). Degrade to the
		// raw-HTML conversion below rather than aborting the whole render —
		// unfiltered Markdown beats a stack trace.
		let article = null;
		try {
			article = await readArticle(page, selector);
		} catch {
			article = null;
		}
		if (article?.content) {
			const body = turndown.turndown(article.content).trim();
			if (!article.title) return body;
			// Readability strips the title heading out of `content` when it
			// duplicates the document title; put it back so the output leads
			// with a heading.
			const heading = `# ${article.title}`;
			return body.split("\n", 1)[0] === heading
				? body
				: `${heading}\n\n${body}`.trim();
		}
	}

	// Either --no-readability, or Readability found nothing article-like and
	// returned null. Convert the scoped markup verbatim — this is the
	// no-heuristics path, and it keeps sparse pages from rendering as "".
	return turndown.turndown(await scopedHtml(page, selector ?? "body")).trim();
}

async function extract(page, { format, selector, readability }) {
	const scope = selector ?? "body";

	if (format === "title") return await page.title();

	if (format === "markdown") {
		return await extractMarkdown(page, { selector, readability });
	}

	if (format === "links") {
		const links = await page.$$eval(`${scope} a[href]`, (as) =>
			as.map((a) => ({ href: a.href, text: a.innerText.trim() })),
		);
		return links.map((l) => `${l.href}\t${l.text}`).join("\n");
	}

	// `text` and `html` both operate on element matches. A page can legitimately
	// contain more than one match (embedded documents produce multiple <body>
	// elements, for instance), so collect them all rather than tripping
	// Playwright's strict mode on an ambiguous locator.
	const locator = page.locator(scope);
	const count = await locator.count();
	if (count === 0) return "";

	const parts = [];
	for (let i = 0; i < count; i++) {
		const el = locator.nth(i);
		parts.push(format === "html" ? await el.innerHTML() : await el.innerText());
	}
	return parts.join("\n");
}

export async function render(url, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	// `md` is an alias, not a format: normalize here so library callers get the
	// same spelling latitude the CLI gives, and FORMATS stays canonical.
	if (opts.format === "md") opts.format = "markdown";
	if (!FORMATS.includes(opts.format)) {
		throw new Error(
			`Unknown format "${opts.format}" (expected one of: ${FORMATS.join(", ")})`,
		);
	}

	// Validated up front, before any network or browser work — even when
	// pacing is off, a nonsensical value is a caller bug worth surfacing.
	const minIntervalMs =
		opts.minIntervalMs === undefined
			? DEFAULT_MIN_INTERVAL_MS
			: validateMinInterval(opts.minIntervalMs, "minIntervalMs");

	// Validated here for the same reason: a malformed click list is a caller
	// bug, and must not cost a robots.txt request or a browser launch.
	const clickSteps = normalizeClickSteps(opts.click);

	const userAgent = opts.userAgent ?? (await defaultUserAgent());

	// One state directory for everything trawl remembers between runs:
	// `stateDir`, else the older pacing-only `pacingStateDir`, else
	// $TRAWL_STATE_DIR / ${XDG_CACHE_HOME:-~/.cache}/trawl.
	const stateDir =
		opts.stateDir ?? opts.pacingStateDir ?? defaultStateDir();

	// Per-origin cooldowns (src/cooldown.mjs): a main-frame 429/503 seen by
	// any earlier run refuses this one with a CooldownError until it expires —
	// checked here, before robots.txt or any browser work, and again right
	// before each explicit page request. `ignoreCooldown` skips the refusal
	// only; responses are still recorded. Non-http(s) URLs never touch it.
	// Only the requested origin is admitted: a redirect to another origin is
	// not intercepted, though a 429/503 there is recorded against it.
	const origin = pacingOrigin(url);
	const cooldown = origin ? createCooldownStore({ stateDir }) : null;
	const admit = (checkOpts) => {
		if (!cooldown) return;
		if (opts.ignoreCooldown) cooldown.read(origin);
		else cooldown.check(origin, checkOpts);
	};
	admit();

	// Cross-run pacing (src/pacing.mjs): every explicit request this call
	// makes to an http(s) origin — the robots.txt fetch, the page navigation,
	// and the networkidle-fallback navigation — waits its turn behind the last
	// request any trawl process made to the same origin. Browser subresources
	// and redirects are not gated. Non-http(s) URLs never touch the state dir.
	// `pacing: false` turns this off and keeps only the in-run Crawl-delay
	// sleep below.
	const pacer =
		opts.pacing !== false && origin
			? createPacer({
					origin,
					stateDir: opts.pacingStateDir ?? stateDir,
					minIntervalMs,
				})
			: null;
	// The Crawl-delay that applies to the page navigation, as learned from
	// this run's robots.txt. `undefined` until (unless) robots.txt is fetched.
	let navCrawlDelayMs;

	// Etiquette, enforced rather than promised: consult robots.txt before we
	// touch the page at all. Skipped for non-http(s) URLs and when the caller
	// opts out with `ignoreRobots` (which skips the robots request itself, so
	// an unreachable robots.txt cannot block an explicit override either). A
	// 5xx, network error, or timeout is a full disallow (RFC 9309 §2.3.1.4)
	// and is reported as such rather than as a matched rule.
	//
	// Which cookies the request carries depends on the path (#79):
	//   - no cookies, no profile: none; Node fetch, before any browser work.
	//   - `cookies` without `profileDir`: still Node fetch before the launch,
	//     with a `Cookie` header of just the cookies that match
	//     `<origin>/robots.txt` (none match: no header at all).
	//   - `profileDir`: through the persistent context's `context.request`,
	//     which shares the profile's cookie jar, so the browser launches
	//     first (see `checkRobots` in the `try` below).
	const robotsCheck = !opts.ignoreRobots && isHttpUrl(url);
	const robotsViaProfile = robotsCheck && Boolean(opts.profileDir);
	const checkRobots = async ({ fetch, cookie, sentCookies }) => {
		const verdict = await checkRobotsAllowed(url, {
			userAgent,
			// Deliberately NOT coupled to `opts.timeout`. Playwright's convention
			// — which `--timeout` inherits — is that `0` means "no timeout". While
			// a robots timeout failed open, borrowing the page budget here made
			// `--timeout 0` (and any implausibly small value) silently skip the
			// check; now that a timeout is a full disallow (RFC 9309 §2.3.1.4),
			// the same coupling would instead refuse every such run.
			// `ROBOTS_TIMEOUT_MS` bounds this fetch independently at 10s — one
			// fixed, sane budget.
			timeout: ROBOTS_TIMEOUT_MS,
			fetch,
			...(cookie && { cookie }),
			// Paced on the Crawl-delay stored by an earlier run (if any), since
			// this run hasn't learned the current policy yet. A failed fetch
			// records the attempt but keeps the stored delay.
			// The cooldown is re-checked after the pacing wait, in case another
			// process recorded one meanwhile.
			...(pacer && {
				gate: (start) => pacer.gate(start, { admit: () => admit() }),
			}),
		});
		if (!verdict.allowed) {
			throw new Error(robotsDenialMessage(verdict, { sentCookies }));
		}
		navCrawlDelayMs = crawlDelayMs(verdict.crawlDelay);
		// Without pacing, honoring `Crawl-delay` means spacing the two requests
		// this run makes — robots.txt, then the page. With pacing, the gate in
		// front of the navigation enforces the same gap (and more).
		if (!pacer && navCrawlDelayMs > 0) await sleep(navCrawlDelayMs);
	};
	if (robotsCheck && !robotsViaProfile) {
		// A secret: it goes into the request header and nowhere else. Always a
		// value Node's fetch accepts (cookies that cannot go in a header are left
		// out, non-ASCII is sent as the same UTF-8 bytes Chromium sends), and
		// with it set a failure is described by an allowlisted code or fixed
		// text only, never the error's message.
		const cookie =
			opts.cookies?.length > 0
				? cookieHeaderFor(opts.cookies, `${new URL(url).origin}/robots.txt`)
				: undefined;
		await checkRobots({ fetch: opts.fetch, cookie, sentCookies: Boolean(cookie) });
	}

	// Under --ignore-robots there is no policy to honour, stored or fresh —
	// only the minimum interval. Read when navigating, since on the
	// `profileDir` path robots.txt is only fetched after the launch.
	const navPolicy = () =>
		navCrawlDelayMs !== undefined
			? { crawlDelayMs: navCrawlDelayMs }
			: { useStoredDelay: !opts.ignoreRobots };
	// Each explicit page request re-checks the cooldown last thing before it
	// is sent (after any pacing wait). For the networkidle-fallback retry this
	// is what stops a retry straight into the 429/503 the first attempt saw.
	const navigate = async (page, waitUntil, checkOpts) => {
		const start = () => page.goto(url, { waitUntil, timeout: opts.timeout });
		const gateAdmit = () => admit(checkOpts);
		if (pacer) return pacer.gate(start, { ...navPolicy(), admit: gateAdmit });
		gateAdmit();
		return start();
	};

	const executablePath = resolveExecutablePath(opts.executablePath);
	// Test seam, deliberately undocumented: lets a test stand in for
	// Playwright's `chromium` without a real browser.
	const browserType = opts.browserType ?? chromium;

	const contextOptions = {
		viewport: opts.viewport,
		userAgent,
		// Readability is injected into the page as an inline <script>, which
		// a nonce/hash-based `script-src` blocks outright — github.com and
		// MDN both do this, and the rejection killed the whole render. Scope
		// the bypass to exactly the path that needs it: every other format
		// reads the DOM without injecting anything, so they keep the page's
		// own CSP enforced.
		...(opts.format === "markdown" &&
			opts.readability !== false && { bypassCSP: true }),
		// Bodies are embedded (base64) rather than written as sidecar files
		// so a single `.har` is self-contained and imports cleanly into
		// Chrome DevTools. `mode: "full"` keeps timings and request bodies;
		// "minimal" would drop them.
		...(opts.har && {
			recordHar: {
				path: opts.har,
				content: opts.harOmitContent ? "omit" : "embed",
				mode: "full",
			},
		}),
	};

	// A plain `browser.launch()` starts from a blank profile every time, so
	// nothing a human does in one run (signing in, accepting a cookie banner)
	// is visible to the next. `--profile <dir>` trades that isolation for
	// persistence: `launchPersistentContext` keeps cookies/localStorage on
	// disk under `dir`, so a session established once — by hand, or via
	// `trawl login` — is reused by every later render() call against the same
	// directory. Only `context` exists on this path; there is no separate
	// `browser` handle to close.
	let browser;
	// Declared out here so the `finally` can close the context even if
	// navigation throws — see the teardown comment below.
	let context;
	// Set immediately before the successful return, so the teardown can tell
	// "nothing went wrong" from "an error is already propagating".
	let ok = false;
	let page;
	// Records every main-frame navigation response's 429/503 (or 2xx) as it
	// arrives — before goto() resolves, so a navigation that then times out
	// waiting for networkidle, or a run that fails later on, still leaves the
	// cooldown behind. Iframes and subresources are ignored, and robots.txt
	// is fetched outside the page (Node fetch, or `context.request` with a
	// profile), so neither ever lands here.
	const seenResponses = new WeakSet();
	const onResponse = (response) => {
		try {
			if (!cooldown || seenResponses.has(response)) return;
			seenResponses.add(response);
			const request = response.request();
			if (!request.isNavigationRequest()) return;
			if (request.frame() !== page.mainFrame()) return;
			const status = response.status();
			const at = cooldownOrigin(response.url());
			if (COOLDOWN_STATUSES.has(status)) {
				cooldown.recordFailure(at, {
					status,
					retryAfter: response.headers()["retry-after"],
				});
			} else if (status >= 200 && status < 300) {
				cooldown.recordSuccess(at);
			}
		} catch {
			// Advisory bookkeeping: it must never take the render down.
		}
	};
	try {
		if (opts.profileDir) {
			mkdirSync(opts.profileDir, { recursive: true });
			context = await browserType.launchPersistentContext(opts.profileDir, {
				executablePath,
				headless: true,
				...contextOptions,
			});
		} else {
			browser = await browserType.launch({ executablePath, headless: true });
			context = await browser.newContext(contextOptions);
		}
		// `cookies`: an already-parsed, already-filtered list (src/cookies.mjs),
		// added before the first page exists, so the first request carries
		// them. On the ephemeral path they die with the context; with
		// `profileDir` too they are written to that profile. Passed as-is:
		// session cookies (`expires: -1`) stay session cookies. A rejection is
		// reported with a fixed message only, never the browser's text, which
		// can quote the cookie; the `finally` still closes everything.
		if (opts.cookies?.length > 0) {
			try {
				await context.addCookies(opts.cookies);
			} catch (err) {
				const known = addCookiesFailure(err);
				throw new Error(
					`could not add cookies to the browser; the page was not fetched${known ? ` (${known})` : ""}`,
				);
			}
		}
		// The `profileDir` path's robots check, through the context so the
		// profile's cookies go with it: after `addCookies`, so it uses the jar
		// the page will. A denial, or an error from the pacing/cooldown gate,
		// throws from here and the `finally` closes the context.
		if (robotsViaProfile) {
			await checkRobots({
				fetch: requestFetch(context.request, { timeout: ROBOTS_TIMEOUT_MS }),
				sentCookies: true,
			});
		}
		page = await context.newPage();
		page.on("response", onResponse);

		// `networkidle` never fires on a page that deliberately keeps a socket
		// open — a websocket, an SSE stream, a long-poll — and that describes a
		// lot of real SPAs (claude.ai among them). The default footgun: the page
		// has usually painted long before the timeout, but the caller sees a
		// bare navigation-timeout failure with no indication the content was
		// ever reachable. On a `networkidle` timeout specifically, retry once
		// against the much cheaper `domcontentloaded` condition instead of
		// failing outright; `waitUntilFallback` on the result says this happened
		// so a caller (the CLI included) can surface it rather than pretend the
		// default just worked.
		let response;
		let waitUntilFallback = null;
		try {
			response = await navigate(page, opts.waitUntil);
		} catch (err) {
			if (opts.waitUntil !== "networkidle" || !/Timeout .*exceeded/.test(err.message)) {
				throw err;
			}
			response = await navigate(page, "domcontentloaded", {
				retrySuppressed: true,
			});
			waitUntilFallback = { from: "networkidle", to: "domcontentloaded" };
		}

		if (opts.waitForSelector) {
			await page.waitForSelector(opts.waitForSelector, {
				timeout: opts.timeout,
			});
		}
		// Some frameworks paint after the network goes idle; `--settle` buys
		// them a fixed grace period. A downgraded wait condition fires far
		// earlier than `networkidle` would have, so floor the grace period at
		// 1s even when the caller didn't ask for one — otherwise the retry
		// above just trades a clean timeout for a race against unfinished JS.
		const settle = waitUntilFallback
			? Math.max(opts.settle, 1000)
			: opts.settle;
		if (settle > 0) await page.waitForTimeout(settle);

		// Checked before extraction returns anything the caller could mistake for
		// real content: a caller that only looks at exit code + stdout must not
		// see a login page reported the same way as a successful fetch. Probes
		// the *full* page regardless of `--selector`, since the wall is usually
		// outside whatever the caller scoped extraction to.
		//
		// With click steps this runs on the loaded page first, so a login wall
		// is reported as one rather than as "selector never appeared", and
		// again after the clicks, in case the content they revealed is a wall.
		const checkAuth = async () => {
			if (opts.authCheck === false) return;
			const reasons = await probeAuthWall(page);
			if (reasons.length > 0) throw new AuthWallError(reasons, page.url());
		};
		await checkAuth();

		// Click steps run after load, `waitForSelector` and `settle`, in the
		// order given; each waits for its element to be visible, clicks it,
		// waits for its own `waitFor` if any, then `settle` again.
		let checkClickNavigation = null;
		if (clickSteps.length > 0) {
			checkClickNavigation = await runClickSteps(page, context, clickSteps, {
				timeout: opts.timeout,
				settle,
			});
			await checkAuth();
		}

		const body = await extract(page, opts);

		// Screenshots ride along on the same navigation as the text output —
		// one page load, both artifacts. Playwright writes and PNG-encodes the
		// file itself when given a `path`.
		let screenshot = null;
		if (opts.screenshot) {
			await page.screenshot({
				path: opts.screenshot,
				fullPage: !!opts.fullPage,
			});
			screenshot = opts.screenshot;
		}

		// Last word on the click guard: a navigation a click set off late —
		// during the auth probe, extraction or the screenshot — was stopped by
		// the route (the page above is still the original), but the run must
		// still fail rather than report success.
		checkClickNavigation?.();

		ok = true;
		return {
			body,
			status: response?.status() ?? null,
			url: page.url(),
			screenshot,
			waitUntilFallback,
		};
	} finally {
		// Land the cooldown writes before anything else can fail: a 429/503
		// this run saw must be on disk for the next one, whatever happened.
		page?.off("response", onResponse);
		await cooldown?.flush();
		// A recorded HAR is only flushed to disk when the *context* closes, so
		// close it explicitly and first — `browser.close()` alone would lose the
		// trace of exactly the runs worth tracing (a goto that timed out, a host
		// that never resolved).
		let closeError;
		if (context) {
			try {
				await context.close();
			} catch (err) {
				// Swallow a teardown failure only when an error is already
				// propagating: it must not mask the error that got us here. On the
				// success path there is nothing to mask, and closing the context is
				// where the HAR is written — a HAR that could not be written has to
				// surface, the same way a `--output` file that cannot be written
				// does. Rethrow *after* the browser is closed, so a failed HAR
				// write never leaks the browser process.
				if (ok) closeError = err;
			}
		}
		// Only set on the ephemeral (non-`--profile`) path — see the comment
		// above `context`.
		if (browser) await browser.close();
		if (closeError) throw closeError;
	}
}
