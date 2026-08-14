// Render a URL in headless Chromium and extract it in a requested shape.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import TurndownService from "turndown";
import { resolveExecutablePath } from "./browser.mjs";
import {
	ROBOTS_TIMEOUT_MS,
	checkRobotsAllowed,
	crawlDelayMs,
} from "./robots.mjs";

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

	const userAgent = opts.userAgent ?? (await defaultUserAgent());

	// Etiquette, enforced rather than promised: consult robots.txt before we
	// touch the page at all. Skipped for non-http(s) URLs and when the caller
	// opts out with `ignoreRobots`.
	if (!opts.ignoreRobots && isHttpUrl(url)) {
		const verdict = await checkRobotsAllowed(url, {
			userAgent,
			// Deliberately NOT coupled to `opts.timeout`. Playwright's convention
			// — which `--timeout` inherits — is that `0` means "no timeout", and
			// the fetch fails open, so borrowing the page budget here made
			// `--timeout 0` (and any implausibly small value) silently skip the
			// check entirely rather than enforce it. `ROBOTS_TIMEOUT_MS` already
			// bounds this fetch independently at 10s, so the old `Math.min` could
			// only ever shorten the budget — and every shortening was a silent
			// skip. One fixed, sane budget instead.
			timeout: ROBOTS_TIMEOUT_MS,
			fetch: opts.fetch,
		});
		if (!verdict.allowed) {
			throw new Error(
				`robots.txt disallows this path (${verdict.rule}). Use --ignore-robots to override.`,
			);
		}
		// One invocation fetches one page, so honoring `Crawl-delay` means
		// spacing the two requests we do make — robots.txt, then the page.
		const delay = crawlDelayMs(verdict.crawlDelay);
		if (delay > 0) await sleep(delay);
	}

	const executablePath = resolveExecutablePath(opts.executablePath);

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
	try {
		if (opts.profileDir) {
			mkdirSync(opts.profileDir, { recursive: true });
			context = await chromium.launchPersistentContext(opts.profileDir, {
				executablePath,
				headless: true,
				...contextOptions,
			});
		} else {
			browser = await chromium.launch({ executablePath, headless: true });
			context = await browser.newContext(contextOptions);
		}
		const page = await context.newPage();

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
			response = await page.goto(url, {
				waitUntil: opts.waitUntil,
				timeout: opts.timeout,
			});
		} catch (err) {
			if (opts.waitUntil !== "networkidle" || !/Timeout .*exceeded/.test(err.message)) {
				throw err;
			}
			response = await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: opts.timeout,
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
		if (opts.authCheck !== false) {
			const reasons = await probeAuthWall(page);
			if (reasons.length > 0) throw new AuthWallError(reasons, page.url());
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

		ok = true;
		return {
			body,
			status: response?.status() ?? null,
			url: page.url(),
			screenshot,
			waitUntilFallback,
		};
	} finally {
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
