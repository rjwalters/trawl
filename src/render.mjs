// Render a URL in headless Chromium and extract it in a requested shape.

import { chromium } from "playwright-core";
import { resolveExecutablePath } from "./browser.mjs";
import {
	ROBOTS_TIMEOUT_MS,
	checkRobotsAllowed,
	crawlDelayMs,
} from "./robots.mjs";

export const FORMATS = ["text", "html", "links", "title"];

const DEFAULTS = {
	format: "text",
	waitUntil: "networkidle",
	settle: 0,
	timeout: 30000,
	viewport: { width: 1280, height: 2000 },
};

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

async function extract(page, { format, selector }) {
	const scope = selector ?? "body";

	if (format === "title") return await page.title();

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
			timeout: Math.min(opts.timeout, ROBOTS_TIMEOUT_MS),
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
	const browser = await chromium.launch({ executablePath, headless: true });

	// Declared out here so the `finally` can close the context even if
	// navigation throws — see the teardown comment below.
	let context;
	// Set immediately before the successful return, so the teardown can tell
	// "nothing went wrong" from "an error is already propagating".
	let ok = false;
	try {
		context = await browser.newContext({
			viewport: opts.viewport,
			userAgent,
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
		});
		const page = await context.newPage();

		const response = await page.goto(url, {
			waitUntil: opts.waitUntil,
			timeout: opts.timeout,
		});

		if (opts.waitForSelector) {
			await page.waitForSelector(opts.waitForSelector, {
				timeout: opts.timeout,
			});
		}
		// Some frameworks paint after the network goes idle; `--settle` buys
		// them a fixed grace period.
		if (opts.settle > 0) await page.waitForTimeout(opts.settle);

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
		await browser.close();
		if (closeError) throw closeError;
	}
}
