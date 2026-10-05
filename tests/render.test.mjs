// End-to-end render tests. These need a Chromium binary; when none is
// installed (a fresh checkout, or CI before the browser step) they skip
// rather than fail, so `npm test` is always runnable.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveExecutablePath } from "../src/browser.mjs";
import { AuthWallError, detectAuthWall, render } from "../src/render.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const opts = { skip: haveBrowser ? false : "no Chromium binary installed" };

// render() paces http(s) requests through a persistent per-origin state dir
// (src/pacing.mjs). Point it at a throwaway directory so no test here ever
// reads or writes the real ~/.cache/trawl.
process.env.TRAWL_STATE_DIR = mkdtempSync(path.join(tmpdir(), "trawl-state-"));

// A page whose content only exists after scripts run — the whole point of
// the tool. Static fetchers see the empty root div.
const SPA = `<!doctype html>
<title>Fixture</title>
<div id="root"></div>
<script>
  document.getElementById("root").innerHTML =
    '<h1>Hydrated</h1><a href="https://example.com/a">First</a>';
</script>`;

const STYLESHEET = "body { color: rgb(1, 2, 3); }";

// A page with a *real* subresource request, which the inline-only SPA fixture
// above deliberately lacks. Served over HTTP because that is what a HAR
// records — file:// loads are not network requests.
const PAGE_WITH_SUBRESOURCE = `<!doctype html>
<title>Fixture</title>
<link rel="stylesheet" href="/style.css">
<h1>Served</h1>`;

// Same idea, but deliberately taller than any viewport we screenshot it at,
// so --full-page has something to prove.
const TALL_SPA = `<!doctype html>
<title>Tall fixture</title>
<div id="root"></div>
<script>
  document.getElementById("root").innerHTML =
    '<h1>Hydrated</h1><div style="height:1500px;background:#0af"></div>';
</script>`;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG stores width/height as big-endian uint32s in the IHDR chunk, at fixed
// offsets right after the 8-byte signature — no image library needed.
function pngSize(file) {
	const buf = readFileSync(file);
	assert.deepEqual(
		buf.subarray(0, 8),
		PNG_MAGIC,
		"file does not start with the PNG signature",
	);
	assert.ok(
		buf.length > 500,
		`expected a non-trivial PNG, got ${buf.length} bytes`,
	);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function tmpFile(name) {
	return path.join(mkdtempSync(path.join(tmpdir(), "trawl-shot-")), name);
}

// Readability only treats a page as an article once it has a meaningful
// amount of prose, so the structured fixture below pads itself past that
// threshold.
const PROSE =
	"Readability scores a page on how much prose it carries, so this " +
	"paragraph exists to push the fixture past that threshold and let the " +
	"article branch run the way it would on a real post. ";

// Every structure the Markdown round trip is supposed to preserve, plus the
// nav/footer chrome Readability is supposed to drop.
const ARTICLE = `<!doctype html>
<title>Structured Fixture</title>
<nav><a href="https://example.com/nav">Site navigation</a></nav>
<article>
  <h1>Top Heading</h1>
  <p>${PROSE.repeat(3)}</p>
  <h2>Second Heading</h2>
  <ul><li>alpha</li><li>beta</li></ul>
  <ol><li>first step</li><li>second step</li></ol>
  <p><a href="https://example.com/deep">Deep link</a> ${PROSE}</p>
  <pre><code class="language-js">const answer = 42;</code></pre>
  <p>${PROSE.repeat(2)}</p>
</article>
<footer>Footer chrome</footer>`;

// No text at all: Readability's parse() gives up and returns null here, which
// is the case the "still returns something" acceptance criterion is about.
const APP_SHELL = `<!doctype html>
<title>App shell</title>
<div id="app"><img src="https://example.com/logo.png" alt="Logo"></div>`;

function fixtureUrl(html, name) {
	const dir = mkdtempSync(path.join(tmpdir(), "trawl-test-"));
	const file = path.join(dir, name);
	writeFileSync(file, html);
	return pathToFileURL(file).href;
}

function harPath(name = "out.har") {
	return path.join(mkdtempSync(path.join(tmpdir(), "trawl-har-")), name);
}

// Minimal static server on an ephemeral port, so tests never depend on the
// network or a fixed port being free.
async function startServer() {
	const server = createServer((req, res) => {
		if (req.url === "/style.css") {
			res.writeHead(200, { "content-type": "text/css" });
			res.end(STYLESHEET);
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(PAGE_WITH_SUBRESOURCE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function readHar(file) {
	const har = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(har.log.version, "1.2");
	return har;
}

test("extracts text that only exists after JS runs", opts, async () => {
	const { body } = await render(fixtureUrl(SPA, "spa.html"));
	assert.match(body, /Hydrated/);
});

test("returns rendered markup for --format html", opts, async () => {
	const { body } = await render(fixtureUrl(SPA, "spa.html"), {
		format: "html",
	});
	assert.match(body, /<h1>Hydrated<\/h1>/);
});

test("lists links for --format links", opts, async () => {
	const { body } = await render(fixtureUrl(SPA, "spa.html"), {
		format: "links",
	});
	assert.match(body, /https:\/\/example\.com\/a\tFirst/);
});

test("scopes extraction to --selector", opts, async () => {
	const url = fixtureUrl(
		`<!doctype html><div id="a">alpha</div><div id="b">beta</div>`,
		"two.html",
	);
	const { body } = await render(url, { selector: "#b" });
	assert.equal(body.trim(), "beta");
});

test("returns null for screenshot when none was requested", opts, async () => {
	const { screenshot } = await render(fixtureUrl(SPA, "spa.html"));
	assert.equal(screenshot, null);
});

test("writes a PNG screenshot alongside the normal body", opts, async () => {
	const shot = tmpFile("out.png");
	const { body, screenshot } = await render(fixtureUrl(SPA, "spa.html"), {
		screenshot: shot,
	});
	// One page load produced both artifacts.
	assert.match(body, /Hydrated/);
	assert.equal(screenshot, shot);
	const { width, height } = pngSize(shot);
	// Default viewport, non-full-page: exactly DEFAULTS.viewport.
	assert.equal(width, 1280);
	assert.equal(height, 2000);
});

test("clips a non-full-page screenshot to an explicit viewport", opts, async () => {
	const shot = tmpFile("small.png");
	await render(fixtureUrl(TALL_SPA, "tall.html"), {
		screenshot: shot,
		viewport: { width: 400, height: 300 },
	});
	assert.deepEqual(pngSize(shot), { width: 400, height: 300 });
});

test("--full-page produces a taller screenshot than the viewport", opts, async () => {
	const shot = tmpFile("full.png");
	await render(fixtureUrl(TALL_SPA, "tall.html"), {
		screenshot: shot,
		fullPage: true,
		viewport: { width: 400, height: 300 },
	});
	const { width, height } = pngSize(shot);
	assert.equal(width, 400);
	assert.ok(
		height > 300,
		`expected full-page height > viewport 300, got ${height}`,
	);
});

test("ignores fullPage when no screenshot was requested", opts, async () => {
	const { body, screenshot } = await render(fixtureUrl(SPA, "spa.html"), {
		fullPage: true,
	});
	assert.match(body, /Hydrated/);
	assert.equal(screenshot, null);
});

test("preserves document structure for --format markdown", opts, async () => {
	const { body } = await render(fixtureUrl(ARTICLE, "article.html"), {
		format: "markdown",
	});

	// Readability promotes the document title to the article title and demotes
	// the in-body <h1> to <h2>, so the heading hierarchy shifts by one level
	// but every heading survives as an ATX heading rather than setext.
	assert.match(body, /^# Structured Fixture$/m);
	assert.match(body, /^## Top Heading$/m);
	assert.match(body, /^## Second Heading$/m);
	assert.match(body, /^-\s+alpha$/m);
	assert.match(body, /^-\s+beta$/m);
	assert.match(body, /^1\.\s+first step$/m);
	assert.match(body, /^2\.\s+second step$/m);
	assert.match(body, /\[Deep link\]\(https:\/\/example\.com\/deep\)/);
	// Fenced, not the 4-space-indented default Turndown would otherwise emit.
	assert.match(body, /```\nconst answer = 42;\n```/);
	assert.doesNotMatch(body, /^ {4}const answer = 42;$/m);
	// Readability's whole job: the nav/footer chrome is gone.
	assert.doesNotMatch(body, /Site navigation/);
	assert.doesNotMatch(body, /Footer chrome/);
});

test("treats --format md as an alias for markdown", opts, async () => {
	const url = fixtureUrl(ARTICLE, "article.html");
	const alias = await render(url, { format: "md" });
	const canonical = await render(url, { format: "markdown" });
	assert.equal(alias.body, canonical.body);
	assert.match(alias.body, /^## Top Heading$/m);
});

test("skips Readability when readability: false", opts, async () => {
	const url = fixtureUrl(ARTICLE, "article.html");
	const raw = await render(url, { format: "markdown", readability: false });
	const filtered = await render(url, { format: "markdown" });

	// The escape hatch exists so boilerplate-stripping can be turned off; prove
	// it actually changes what comes back rather than merely not crashing.
	assert.notEqual(raw.body, filtered.body);
	assert.match(raw.body, /Site navigation/);
	assert.match(raw.body, /Footer chrome/);
	// Untouched markup also keeps the language hint Readability strips with
	// the rest of the class attributes.
	assert.match(raw.body, /```js\nconst answer = 42;\n```/);
});

test("still returns markdown when there is no article", opts, async () => {
	const { body } = await render(fixtureUrl(APP_SHELL, "shell.html"), {
		format: "markdown",
	});
	assert.notEqual(body, "");
	assert.match(body, /!\[Logo\]\(https:\/\/example\.com\/logo\.png\)/);
});

// Readability is injected as an inline <script>, which a nonce/hash-based
// `script-src` blocks outright — that killed `-f markdown` on github.com and
// MDN. `file://` fixtures carry no CSP, so reproducing it needs a real
// response header; serve one from loopback rather than depending on a
// third-party site.
async function serveWithCsp(html, csp) {
	const server = createServer((req, res) => {
		if (req.url === "/robots.txt") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("User-agent: *\nAllow: /\n");
			return;
		}
		res.writeHead(200, {
			"content-type": "text/html",
			"content-security-policy": csp,
		});
		res.end(html);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/article.html`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test("renders markdown on a page with a strict script-src CSP", opts, async () => {
	const s = await serveWithCsp(ARTICLE, "script-src 'self'");
	try {
		const { body } = await render(s.url, { format: "markdown" });

		// Not just "didn't throw": the boilerplate stripping proves Readability
		// itself ran, rather than the run silently degrading to the raw-HTML
		// fallback (which would keep the nav and footer).
		assert.match(body, /^# Structured Fixture$/m);
		assert.match(body, /^## Top Heading$/m);
		assert.match(body, /^-\s+alpha$/m);
		assert.doesNotMatch(body, /Site navigation/);
		assert.doesNotMatch(body, /Footer chrome/);
	} finally {
		await s.close();
	}
});

test("still renders text under a strict CSP without bypassing it", opts, async () => {
	// The bypass is scoped to the Readability injection; formats that inject
	// nothing must keep the page's own CSP enforced.
	const s = await serveWithCsp(ARTICLE, "script-src 'self'");
	try {
		const { body } = await render(s.url, { format: "text" });
		assert.match(body, /Top Heading/);
		assert.match(body, /Site navigation/);
	} finally {
		await s.close();
	}
});

test("rejects an unknown format before launching a browser", async () => {
	await assert.rejects(
		() => render("https://example.com", { format: "yaml" }),
		/Unknown format "yaml"/,
	);
});

// --- auth-wall detection (#22) ---
//
// `detectAuthWall` is pure and browser-free, so its decision logic is fully
// covered here without Chromium; the browser-gated tests further down only
// need to prove `render()` actually wires the probe up.

test("detectAuthWall: no signals means not a wall", () => {
	assert.deepEqual(
		detectAuthWall({ text: "A perfectly normal page.", url: "https://example.com/" }),
		[],
	);
});

test("detectAuthWall: tiny text with sign-in vocabulary is a wall", () => {
	const reasons = detectAuthWall({ text: "  Sign in  ", url: "https://example.com/" });
	assert.equal(reasons.length, 1);
	assert.match(reasons[0], /tiny text \(7 chars\) contains "sign in"/);
});

test("detectAuthWall: long text mentioning login vocabulary is not flagged", () => {
	// The length gate exists so a real page that merely *mentions* "log in"
	// somewhere in a large body (a help article, a nav link) isn't flagged —
	// only pages that are *almost nothing but* the sign-in prompt are.
	const long = "Welcome to the site. ".repeat(20) + "Log in to see more.";
	assert.deepEqual(detectAuthWall({ text: long, url: "https://example.com/" }), []);
});

test("detectAuthWall: a password field is a wall regardless of text length", () => {
	const long = "Manage your account settings below. ".repeat(10);
	const reasons = detectAuthWall({ text: long, hasPasswordField: true });
	assert.deepEqual(reasons, ["page has a form with a password field"]);
});

test("detectAuthWall: a known auth-provider host is a wall", () => {
	const reasons = detectAuthWall({
		text: "loading…",
		url: "https://accounts.google.com/signin/v2/identifier",
	});
	assert.match(reasons.join(), /known auth provider \(accounts\.google\.com\)/);
});

test("detectAuthWall: a /login-shaped path is a wall", () => {
	for (const path of ["/login", "/login/", "/log-in", "/signin", "/oauth2/authorize"]) {
		const reasons = detectAuthWall({ url: `https://example.com${path}` });
		assert.equal(reasons.length, 1, `expected a match for ${path}`);
		assert.match(reasons[0], /looks like a login page/);
	}
});

test("detectAuthWall: a path merely containing 'login' as a substring is not flagged", () => {
	assert.deepEqual(
		detectAuthWall({ url: "https://example.com/blog/login-tips" }),
		[],
	);
});

test("detectAuthWall: multiple signals all get reported", () => {
	const reasons = detectAuthWall({
		text: "Please sign in",
		hasPasswordField: true,
		url: "https://example.com/login",
	});
	assert.equal(reasons.length, 3);
});

test("records the page's subresource requests in a HAR", opts, async () => {
	const server = await startServer();
	const file = harPath();
	try {
		await render(server.url, { har: file });
	} finally {
		await server.close();
	}

	const { log } = readHar(file);
	const urls = log.entries.map((e) => e.request.url);
	assert.ok(
		urls.some((u) => u.endsWith("/style.css")),
		`expected a /style.css entry, got: ${urls.join(", ")}`,
	);
	const document = log.entries.find((e) => e.request.url === server.url);
	assert.equal(document.response.status, 200);
});

test("embeds response bodies in the HAR by default", opts, async () => {
	const server = await startServer();
	const file = harPath();
	try {
		await render(server.url, { har: file });
	} finally {
		await server.close();
	}

	const { log } = readHar(file);
	const css = log.entries.find((e) => e.request.url.endsWith("/style.css"));
	const { text, encoding } = css.response.content;
	const decoded =
		encoding === "base64" ? Buffer.from(text, "base64").toString() : text;
	assert.equal(decoded, STYLESHEET);
});

test("omits response bodies with harOmitContent", opts, async () => {
	const server = await startServer();
	const file = harPath();
	try {
		await render(server.url, { har: file, harOmitContent: true });
	} finally {
		await server.close();
	}

	const { log } = readHar(file);
	const css = log.entries.find((e) => e.request.url.endsWith("/style.css"));
	assert.ok(css, "the request itself is still recorded");
	assert.ok(
		!css.response.content.text,
		`expected no body, got: ${css.response.content.text}`,
	);
});

test("still writes a valid HAR when navigation throws", opts, async () => {
	// Bind then immediately release a port: connections to it are refused, so
	// `page.goto` rejects mid-navigation. The HAR must survive that path — it
	// only flushes on context.close().
	const server = await startServer();
	const url = server.url;
	await server.close();

	const file = harPath();
	// ignoreRobots: the refused robots.txt fetch would otherwise be a full
	// disallow (RFC 9309 §2.3.1.4) and stop us before navigation even starts.
	await assert.rejects(
		() => render(url, { har: file, timeout: 5000, ignoreRobots: true }),
		/ERR_CONNECTION_REFUSED|net::/,
	);

	assert.ok(existsSync(file), "HAR file was written despite the failure");
	readHar(file);
});

test("surfaces a HAR that could not be written", opts, async () => {
	// The HAR is flushed on context.close(), so an unwritable path only fails
	// during teardown — after an otherwise-successful render. That failure must
	// reject rather than be swallowed, or `--har /typo/out.har` would print the
	// page and exit 0 with no trace on disk and nothing on stderr.
	const server = await startServer();
	// A *file* standing where the HAR's parent directory would have to be:
	// unwritable in a way no amount of directory creation can fix, on every
	// platform and without depending on privileges.
	const blocker = harPath("blocker");
	writeFileSync(blocker, "not a directory");
	const file = path.join(blocker, "out.har");
	try {
		await assert.rejects(
			() => render(server.url, { har: file }),
			/ENOTDIR|EEXIST|ENOENT|EACCES|EPERM/,
		);
	} finally {
		await server.close();
	}

	assert.ok(!existsSync(file), "no HAR should have been written");
});

// --- robots.txt ---
//
// These serve robots.txt (and, where a test needs a real navigation, a page)
// from a throwaway loopback server, so nothing here touches a third-party
// site. Tests that only need the pre-navigation check run unconditionally:
// like the unknown-format test above, they throw before any browser launch.

// A Chromium path that cannot exist: render() rejects at browser resolution,
// which is *after* the robots check, so a rejection here still proves what
// the check did (or didn't) do first.
const NO_BROWSER = {
	executablePath: path.join(tmpdir(), "trawl-no-such-chrome"),
};

// Serve a fixed body per path; anything unlisted is a 404.
async function serve(routes) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const body = routes[url.pathname];
		if (body === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const type = url.pathname.endsWith(".txt") ? "text/plain" : "text/html";
		res.writeHead(200, { "content-type": type });
		res.end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test("refuses a robots.txt-disallowed path before launching a browser", async () => {
	const s = await serve({
		"/robots.txt": "User-agent: *\nDisallow: /private/\n",
	});
	try {
		await assert.rejects(
			() => render(`${s.origin}/private/page.html`),
			/robots\.txt disallows this path \(Disallow: \/private\/\)\. Use --ignore-robots to override\./,
		);
	} finally {
		await s.close();
	}
});

// Regression: the robots budget used to be `Math.min(opts.timeout,
// ROBOTS_TIMEOUT_MS)`. Playwright's convention — which `--timeout` inherits —
// is that `0` means "no timeout", so `Math.min(0, …)` aborted the robots fetch
// on the next tick, the check failed open, and `--timeout 0` became a silent
// synonym for `--ignore-robots`. An implausibly small timeout did the same.
test("a disallowed path is still refused when timeout is 0 or tiny", async () => {
	const s = await serve({
		"/robots.txt": "User-agent: *\nDisallow: /\n",
	});
	try {
		for (const timeout of [0, 1, 5]) {
			await assert.rejects(
				// NO_BROWSER makes the failure mode unambiguous: if the robots
				// check were skipped we would reach browser resolution and see
				// "Chromium binary not found" instead of this rejection.
				() => render(`${s.origin}/secret.html`, { ...NO_BROWSER, timeout }),
				/robots\.txt disallows this path \(Disallow: \/\)\. Use --ignore-robots to override\./,
				`timeout: ${timeout} should not bypass the robots check`,
			);
		}
	} finally {
		await s.close();
	}
});

test("ignoreRobots skips the check entirely", async () => {
	const s = await serve({
		"/robots.txt": "User-agent: *\nDisallow: /\n",
	});
	try {
		// Reaching the (missing) browser proves the check did not fire.
		await assert.rejects(
			() =>
				render(`${s.origin}/private/page.html`, {
					...NO_BROWSER,
					ignoreRobots: true,
				}),
			/Chromium binary not found/,
		);
	} finally {
		await s.close();
	}
});

test("a missing (404) robots.txt allows the page", async () => {
	const s = await serve({});
	try {
		await assert.rejects(
			() => render(`${s.origin}/anything`, NO_BROWSER),
			/Chromium binary not found/,
		);
	} finally {
		await s.close();
	}
});

// A loopback server whose robots.txt answers with `robots(req, res)`; every
// other request is counted as a page request and served a tiny page.
async function serveRobots(robots) {
	const hits = { robots: 0, page: 0 };
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url, "http://127.0.0.1");
		if (pathname === "/robots.txt" || pathname.startsWith("/robots-")) {
			hits.robots++;
			robots(req, res, pathname);
			return;
		}
		hits.page++;
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><title>Page</title><p>reached the page</p>");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

const status = (code) => (_req, res) => {
	res.writeHead(code, { "content-type": "text/plain" });
	res.end("User-agent: *\nDisallow:\n");
};

const UNREACHABLE_503 =
	/robots\.txt is unreachable: http:\/\/127\.0\.0\.1:\d+\/robots\.txt returned HTTP 503 \(server error\)\. .*no browser-profile cookies.*Use --ignore-robots to override\./;

test("a 503 robots.txt refuses the page before launching a browser", async () => {
	const s = await serveRobots(status(503));
	try {
		// NO_BROWSER: had the check passed we would see "Chromium binary not
		// found" instead.
		await assert.rejects(
			() => render(`${s.origin}/page`, NO_BROWSER),
			UNREACHABLE_503,
		);
		assert.equal(s.hits.robots, 1);
		assert.equal(s.hits.page, 0);
	} finally {
		await s.close();
	}
});

test("a 500 robots.txt refuses the page too", async () => {
	const s = await serveRobots(status(500));
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, NO_BROWSER),
			/robots\.txt is unreachable: .* returned HTTP 500/,
		);
		assert.equal(s.hits.page, 0);
	} finally {
		await s.close();
	}
});

test("a robots.txt redirect that ends in a 503 refuses the page", async () => {
	const s = await serveRobots((_req, res, pathname) => {
		if (pathname === "/robots.txt") {
			res.writeHead(302, { location: "/robots-down" });
			res.end();
			return;
		}
		status(503)(_req, res);
	});
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, NO_BROWSER),
			/robots\.txt is unreachable: .* returned HTTP 503/,
		);
		assert.equal(s.hits.robots, 2, "the redirect should have been followed");
		assert.equal(s.hits.page, 0);
	} finally {
		await s.close();
	}
});

for (const code of [404, 410, 429]) {
	test(`a ${code} robots.txt still allows the page`, async () => {
		const s = await serveRobots(status(code));
		try {
			await assert.rejects(
				() => render(`${s.origin}/page`, NO_BROWSER),
				/Chromium binary not found/,
			);
		} finally {
			await s.close();
		}
	});
}

test("an unreachable robots.txt host refuses with a network-error message", async () => {
	// Bind then close, so the port is (almost certainly) refusing connections.
	const s = await serveRobots(status(200));
	const { origin } = s;
	await s.close();
	await assert.rejects(
		() => render(`${origin}/page`, NO_BROWSER),
		/robots\.txt is unreachable: .*could not be fetched \(network error: .+\)\. .*Use --ignore-robots to override\./,
	);
});

test("ignoreRobots never requests an unreachable robots.txt", async () => {
	const s = await serveRobots(status(503));
	try {
		await assert.rejects(
			() =>
				render(`${s.origin}/page`, { ...NO_BROWSER, ignoreRobots: true }),
			/Chromium binary not found/,
		);
		assert.equal(s.hits.robots, 0);
	} finally {
		await s.close();
	}
});

test("never fetches robots.txt for a file:// URL", async () => {
	let calls = 0;
	const spy = async () => {
		calls++;
		throw new Error("robots.txt should not be fetched for file://");
	};

	await assert.rejects(
		() => render(fixtureUrl(SPA, "spa.html"), { ...NO_BROWSER, fetch: spy }),
		/Chromium binary not found/,
	);
	assert.equal(calls, 0);

	// Same options against an http(s) URL *do* consult robots.txt — otherwise
	// the assertion above would pass for the wrong reason. The spy throws, so
	// that consultation is now a network-error denial (RFC 9309 §2.3.1.4).
	await assert.rejects(
		() => render("http://127.0.0.1:1/page", { ...NO_BROWSER, fetch: spy }),
		/robots\.txt is unreachable: .*network error/,
	);
	assert.equal(calls, 1);
});

test("identifies itself with a default trawl User-Agent on the robots.txt fetch", async () => {
	const seen = [];
	const spy = async (url, init) => {
		seen.push([url, init.headers["User-Agent"]]);
		return { ok: true, status: 200, text: async () => "" };
	};

	await assert.rejects(
		() => render("http://127.0.0.1:1/page", { ...NO_BROWSER, fetch: spy }),
		/Chromium binary not found/,
	);
	assert.deepEqual(seen[0][0], "http://127.0.0.1:1/robots.txt");
	assert.match(
		seen[0][1],
		/^trawl\/\d[\w.-]* \(\+https:\/\/github\.com\/rjwalters\/trawl\)$/,
	);

	// An explicit userAgent still wins outright.
	await assert.rejects(
		() =>
			render("http://127.0.0.1:1/page", {
				...NO_BROWSER,
				fetch: spy,
				userAgent: "my-own-agent/9",
			}),
		/Chromium binary not found/,
	);
	assert.equal(seen[1][1], "my-own-agent/9");
});

// With pacing on, the Crawl-delay wait moves to the gate in front of the page
// navigation (after browser launch) — covered by the pacing tests below. With
// pacing off, the original in-run sleep must still happen.
test("with pacing: false, still sleeps for Crawl-delay between the robots.txt fetch and the page fetch", async () => {
	const s = await serve({ "/robots.txt": "User-agent: *\nCrawl-delay: 1\n" });
	const started = Date.now();
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, { ...NO_BROWSER, pacing: false }),
			/Chromium binary not found/,
		);
	} finally {
		await s.close();
	}
	assert.ok(
		Date.now() - started >= 900,
		`expected a ~1s crawl delay, waited ${Date.now() - started}ms`,
	);
});

test("navigates an allowed path and sends the default User-Agent", opts, async () => {
	const s = await serve({
		"/robots.txt": "User-agent: *\nDisallow: /private/\n",
		"/ua.html": `<!doctype html><div id="root"></div>
<script>document.getElementById("root").textContent = navigator.userAgent;</script>`,
	});
	try {
		const { body, status } = await render(`${s.origin}/ua.html`);
		assert.equal(status, 200);
		assert.match(body, /^trawl\/\d/);
	} finally {
		await s.close();
	}
});

test("ignoreRobots navigates a path robots.txt would block", opts, async () => {
	const s = await serve({
		"/robots.txt": "User-agent: *\nDisallow: /\n",
		"/private/page.html": `<!doctype html><p>secret</p>`,
	});
	try {
		await assert.rejects(() => render(`${s.origin}/private/page.html`));
		const { body } = await render(`${s.origin}/private/page.html`, {
			ignoreRobots: true,
		});
		assert.match(body, /secret/);
	} finally {
		await s.close();
	}
});

test("ignoreRobots reaches the page past a 503 robots.txt", opts, async () => {
	const s = await serveRobots(status(503));
	try {
		await assert.rejects(() => render(`${s.origin}/page`), UNREACHABLE_503);
		assert.equal(s.hits.page, 0);
		const { body } = await render(`${s.origin}/page`, { ignoreRobots: true });
		assert.match(body, /reached the page/);
		assert.equal(s.hits.robots, 1, "only the guarded run requested robots.txt");
		assert.ok(s.hits.page >= 1);
	} finally {
		await s.close();
	}
});

// --- auth-wall detection, end-to-end (#22) ---

const LOGIN_WALL = `<!doctype html><title>Gated</title><body>Sign in</body>`;

const PASSWORD_FORM_PAGE = `<!doctype html><title>Account</title>
<body>
  <p>${"Manage your account settings below. ".repeat(10)}</p>
  <form><input type="password" name="p"></form>
</body>`;

test("render() rejects with AuthWallError for a tiny sign-in page", opts, async () => {
	await assert.rejects(
		() => render(fixtureUrl(LOGIN_WALL, "wall.html")),
		(err) => {
			assert.ok(err instanceof AuthWallError, `expected AuthWallError, got ${err}`);
			assert.match(err.message, /login wall/);
			assert.match(err.message, /"sign in"/);
			return true;
		},
	);
});

test("render() rejects with AuthWallError for a page with a password field", opts, async () => {
	await assert.rejects(
		() => render(fixtureUrl(PASSWORD_FORM_PAGE, "password.html")),
		(err) => {
			assert.ok(err instanceof AuthWallError);
			assert.match(err.message, /password field/);
			return true;
		},
	);
});

test("authCheck: false bypasses login-wall detection", opts, async () => {
	const { body } = await render(fixtureUrl(LOGIN_WALL, "wall2.html"), {
		authCheck: false,
	});
	assert.match(body, /Sign in/);
});

test("a redirect to a known login path is reported as an auth wall", opts, async () => {
	// `serve()`'s fixed-body routing can't express a redirect, so this test
	// drives its own tiny server instead.
	const server = createServer((req, res) => {
		if (req.url === "/app") {
			res.writeHead(302, { location: "/login" });
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><title>Log in</title><body>please wait…</body>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		await assert.rejects(
			() => render(`http://127.0.0.1:${port}/app`, { ignoreRobots: true }),
			(err) => {
				assert.ok(err instanceof AuthWallError);
				assert.match(err.message, /login page \(\/login\)/);
				return true;
			},
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

// --- persistent profiles (#22) ---

function tmpProfileDir() {
	return mkdtempSync(path.join(tmpdir(), "trawl-profile-"));
}

// A page whose body reflects whether *this* request carried the cookie the
// *previous* request's response set — the simplest possible "did the browser
// remember something across two separate render() calls" probe.
function serveCookieProbe() {
	const server = createServer((req, res) => {
		if (req.headers.cookie?.includes("seen=1")) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(`<!doctype html><body>cookie: yes</body>`);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/html",
			// Max-Age matters: a session cookie (no Max-Age/Expires) is correctly
			// discarded when the browser context closes, in a *real* browser too —
			// only a persistent cookie is expected to survive into the next
			// render() call.
			"set-cookie": "seen=1; Path=/; Max-Age=3600",
		});
		res.end(`<!doctype html><body>cookie: no</body>`);
	});
	return server;
}

test("--profile persists cookies across separate render() calls", opts, async () => {
	const server = serveCookieProbe();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}/`;
	const profileDir = tmpProfileDir();
	try {
		const first = await render(url, { profileDir, ignoreRobots: true });
		assert.match(first.body, /cookie: no/);

		const second = await render(url, { profileDir, ignoreRobots: true });
		assert.match(
			second.body,
			/cookie: yes/,
			"a second render() against the same --profile dir should reuse the cookie jar",
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("without --profile, cookies do not survive across render() calls", opts, async () => {
	const server = serveCookieProbe();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}/`;
	try {
		const first = await render(url, { ignoreRobots: true });
		assert.match(first.body, /cookie: no/);

		const second = await render(url, { ignoreRobots: true });
		assert.match(
			second.body,
			/cookie: no/,
			"an ephemeral (no --profile) context must not carry state between calls",
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

// --- softening the networkidle footgun (#22) ---

// A page that kicks off a `fetch()` whose response never arrives — the
// connection stays open indefinitely, so `networkidle` (the default
// `--wait-until`) never fires against it. This is the same shape as the
// websocket/SSE connections real SPAs (claude.ai among them) hold open.
function serveHangingStream() {
	const server = createServer((req, res) => {
		if (req.url === "/stream") {
			res.writeHead(200, { "content-type": "text/plain" });
			// Deliberately never write or end the response — the open connection
			// is the whole point of the fixture.
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(
			`<!doctype html><title>Hang</title><body><h1>Loaded</h1>` +
				`<script>fetch('/stream');</script></body>`,
		);
	});
	return server;
}

test("a networkidle timeout retries once with domcontentloaded instead of failing", opts, async () => {
	const server = serveHangingStream();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		const result = await render(`http://127.0.0.1:${port}/`, {
			ignoreRobots: true,
			timeout: 2000,
		});
		assert.match(result.body, /Loaded/);
		assert.deepEqual(result.waitUntilFallback, {
			from: "networkidle",
			to: "domcontentloaded",
		});
	} finally {
		// The open /stream connection would otherwise keep the server (and the
		// test process) alive indefinitely.
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("an explicit non-networkidle wait condition still fails on timeout, unretried", opts, async () => {
	// Bind then immediately release a port: connections to it are refused, so
	// `page.goto` rejects for a reason that is not "networkidle timed out" —
	// the fallback must not fire, and the original error must surface.
	const server = createServer((_, res) => res.end());
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));

	await assert.rejects(() =>
		render(`http://127.0.0.1:${port}/`, {
			ignoreRobots: true,
			waitUntil: "load",
			timeout: 2000,
		}),
	);
});

// --- cross-run pacing (#38) ---
//
// render() gates every explicit request — robots.txt, the page navigation,
// and the networkidle-fallback navigation — behind the last request made to
// the same origin, persisted in a state dir. Each test uses its own temporary
// state dir.
//
// What the spacing assertions measure: the gate paces on the *recorded start*
// of each request (the `lastRequestAt` it writes just before initiating it),
// as #38 specifies. Server arrival is not a reliable proxy for that — the
// first fetch() in a Node process spends 100-200ms (more under load) between
// the call and the request reaching the server, so a cold request followed
// by a warm one can arrive closer together than the interval even though
// the gate spaced them correctly. Any tolerance on arrival gaps is a guess
// about that latency.
//
// So the server snapshots the state file as each request arrives. The gate
// writes `lastRequestAt` before sending, and the next request cannot record
// until the interval has passed, so the snapshot is exactly that request's
// recorded start (as long as it arrives within one interval of being sent).
// Spacing is then asserted on recorded starts with no tolerance, plus the
// causal check that each request arrived no earlier than its recorded start.

// The recorded start of the last gated request, or null if none yet. One
// origin per test, so the pacing dir holds at most one state file (`.tmp`
// files are in-flight writes, which are renamed atomically into place).
function recordedStart(stateDir) {
	const dir = path.join(stateDir, "pacing");
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	if (files.length !== 1) return null;
	try {
		return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")).lastRequestAt ?? null;
	} catch {
		return null;
	}
}

// Serves fixed bodies like `serve()` above, but logs when each path was hit
// and, given `stateDir`, the recorded start of the request that hit it.
async function serveLogged(routes, { stateDir } = {}) {
	const hits = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		hits.push({
			path: url.pathname,
			at: Date.now(),
			recorded: stateDir ? recordedStart(stateDir) : null,
		});
		const body = routes[url.pathname];
		if (body === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const type = url.pathname.endsWith(".txt") ? "text/plain" : "text/html";
		res.writeHead(200, { "content-type": type });
		res.end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function freshStateDir() {
	return mkdtempSync(path.join(tmpdir(), "trawl-pacing-state-"));
}

// Every consecutive pair of gated requests started at least `minGapMs` apart
// (by recorded start, exact), and none reached the server before it was
// recorded. See the section comment above for why not arrival gaps.
function assertSpaced(hits, minGapMs) {
	for (const h of hits) {
		assert.equal(typeof h.recorded, "number", `${h.path} arrived with no recorded start`);
		assert.ok(h.at >= h.recorded, `${h.path} arrived before its recorded start`);
	}
	for (let i = 1; i < hits.length; i++) {
		const gap = hits[i].recorded - hits[i - 1].recorded;
		assert.ok(
			gap >= minGapMs,
			`${hits[i - 1].path} -> ${hits[i].path} started only ${gap}ms apart ` +
				`(want >= ${minGapMs})` +
				(gap === 0 ? "; the earlier request arrived after the later one was recorded" : ""),
		);
	}
}

// Capture what render() writes to stderr (the degraded-mode warning).
async function captureStderr(fn) {
	const original = process.stderr.write;
	let captured = "";
	process.stderr.write = (chunk, ...rest) => {
		captured += chunk;
		return original.call(process.stderr, chunk, ...rest);
	};
	try {
		return { result: await fn(), stderr: () => captured };
	} finally {
		process.stderr.write = original;
	}
}

for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 60001, "abc"]) {
	test(`rejects minIntervalMs ${String(bad)} before any request`, async () => {
		let fetched = false;
		await assert.rejects(
			() =>
				render("http://127.0.0.1:1/page", {
					...NO_BROWSER,
					minIntervalMs: bad,
					fetch: async () => {
						fetched = true;
						return new Response("");
					},
				}),
			/minIntervalMs expects/,
		);
		assert.equal(fetched, false);
	});
}

test("a non-http(s) URL never touches the pacing state dir", async () => {
	const dir = freshStateDir();
	await assert.rejects(
		() => render(fixtureUrl(SPA, "spa.html"), { ...NO_BROWSER, pacingStateDir: dir }),
		/Chromium binary not found/,
	);
	assert.deepEqual(readdirSync(dir), []);
});

test("robots.txt fetches from separate render() calls are paced on the minimum interval", async () => {
	const pacingStateDir = freshStateDir();
	const s = await serveLogged({ "/robots.txt": "User-agent: *\nAllow: /\n" }, { stateDir: pacingStateDir });
	try {
		for (let i = 0; i < 2; i++) {
			await assert.rejects(
				() => render(`${s.origin}/page`, { ...NO_BROWSER, pacingStateDir, minIntervalMs: 700 }),
				/Chromium binary not found/,
			);
		}
	} finally {
		await s.close();
	}
	assert.equal(s.hits.length, 2);
	assertSpaced(s.hits, 700);
	assert.equal(readdirSync(path.join(pacingStateDir, "pacing")).length, 1);
});

test("pacing: false neither waits across calls nor writes state", async () => {
	const s = await serveLogged({ "/robots.txt": "User-agent: *\nAllow: /\n" });
	const pacingStateDir = freshStateDir();
	try {
		for (let i = 0; i < 2; i++) {
			await assert.rejects(
				() =>
					render(`${s.origin}/page`, {
						...NO_BROWSER,
						pacing: false,
						pacingStateDir,
						minIntervalMs: 5000,
					}),
				/Chromium binary not found/,
			);
		}
	} finally {
		await s.close();
	}
	assert.equal(s.hits.length, 2);
	assert.ok(s.hits[1].at - s.hits[0].at < 5000, "pacing: false still waited");
	assert.deepEqual(readdirSync(pacingStateDir), []);
});

test("Crawl-delay paces robots and page requests across two render() calls", opts, async () => {
	const pacingStateDir = freshStateDir();
	const s = await serveLogged({
		"/robots.txt": "User-agent: *\nCrawl-delay: 0.8\n",
		"/page.html": "<!doctype html><title>P</title><h1>Paced</h1>",
	}, { stateDir: pacingStateDir });
	try {
		for (let i = 0; i < 2; i++) {
			// A zero minimum: every gap below comes from Crawl-delay alone —
			// including the second robots.txt fetch, paced on the stored delay.
			const { body } = await render(`${s.origin}/page.html`, { pacingStateDir, minIntervalMs: 0 });
			assert.match(body, /Paced/);
		}
	} finally {
		await s.close();
	}
	const explicit = s.hits.filter((h) => h.path === "/robots.txt" || h.path === "/page.html");
	assert.deepEqual(
		explicit.map((h) => h.path),
		["/robots.txt", "/page.html", "/robots.txt", "/page.html"],
	);
	assertSpaced(explicit, 800);
});

test("ignoreRobots skips Crawl-delay but still paces on the minimum interval", opts, async () => {
	const pacingStateDir = freshStateDir();
	const s = await serveLogged({
		"/robots.txt": "User-agent: *\nCrawl-delay: 30\n",
		"/page.html": "<!doctype html><title>P</title><h1>Paced</h1>",
	}, { stateDir: pacingStateDir });
	try {
		for (let i = 0; i < 2; i++) {
			await render(`${s.origin}/page.html`, { pacingStateDir, ignoreRobots: true, minIntervalMs: 900 });
		}
	} finally {
		await s.close();
	}
	const pages = s.hits.filter((h) => h.path === "/page.html");
	assert.equal(s.hits.filter((h) => h.path === "/robots.txt").length, 0);
	assert.equal(pages.length, 2);
	assertSpaced(pages, 900);
	assert.ok(pages[1].at - pages[0].at < 30_000, "ignoreRobots honoured Crawl-delay");
});

test("the networkidle-fallback navigation passes through the same gate", opts, async () => {
	const hits = [];
	const pacingStateDir = freshStateDir();
	const server = serveHangingStream();
	server.on("request", (req) => {
		if (req.url === "/") {
			hits.push({ path: "/", at: Date.now(), recorded: recordedStart(pacingStateDir) });
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		const result = await render(`http://127.0.0.1:${port}/`, {
			ignoreRobots: true,
			timeout: 1000,
			// Longer than the navigation timeout, so only the gate can explain
			// the retry waiting this long after the first navigation.
			minIntervalMs: 2500,
			pacingStateDir,
		});
		assert.ok(result.waitUntilFallback);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	assert.equal(hits.length, 2);
	assertSpaced(hits, 2500);
});

test("an unwritable state dir warns on stderr and still renders", opts, async () => {
	const s = await serveLogged({
		"/robots.txt": "User-agent: *\nAllow: /\n",
		"/page.html": "<!doctype html><title>P</title><h1>Still here</h1>",
	});
	const parent = freshStateDir();
	const notADir = path.join(parent, "occupied");
	writeFileSync(notADir, "a file, not a directory");
	try {
		const { result, stderr } = await captureStderr(() =>
			render(`${s.origin}/page.html`, { pacingStateDir: notADir, minIntervalMs: 300 }),
		);
		assert.match(result.body, /Still here/);
		assert.match(stderr(), /pacing state directory .* is unusable/);
		assert.equal(stderr().match(/is unusable/g).length, 1, "warned more than once");
	} finally {
		await s.close();
	}
	// Both requests still went out, robots.txt first. With no state file there
	// is no recorded start to observe here, and server arrival gaps cannot
	// prove spacing (see the section comment); the degraded in-run wait itself
	// is asserted deterministically, on a fake clock, in tests/pacing.test.mjs
	// ("an unwritable state dir warns once and falls back to in-run pacing").
	assert.deepEqual(
		s.hits.filter((h) => h.path === "/robots.txt" || h.path === "/page.html").map((h) => h.path),
		["/robots.txt", "/page.html"],
	);
});
