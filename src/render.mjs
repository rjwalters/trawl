// Render a URL in headless Chromium and extract it in a requested shape.

import { chromium } from "playwright-core";
import { resolveExecutablePath } from "./browser.mjs";

export const FORMATS = ["text", "html", "links", "title"];

const DEFAULTS = {
	format: "text",
	waitUntil: "networkidle",
	settle: 0,
	timeout: 30000,
	viewport: { width: 1280, height: 2000 },
};

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

	const executablePath = resolveExecutablePath(opts.executablePath);
	const browser = await chromium.launch({ executablePath, headless: true });

	try {
		const context = await browser.newContext({
			viewport: opts.viewport,
			userAgent: opts.userAgent,
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
		return { body, status: response?.status() ?? null, url: page.url() };
	} finally {
		await browser.close();
	}
}
