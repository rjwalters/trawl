// End-to-end render tests. These need a Chromium binary; when none is
// installed (a fresh checkout, or CI before the browser step) they skip
// rather than fail, so `npm test` is always runnable.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveExecutablePath } from "../src/browser.mjs";
import { render } from "../src/render.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const opts = { skip: haveBrowser ? false : "no Chromium binary installed" };

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

test("rejects an unknown format before launching a browser", async () => {
	await assert.rejects(
		() => render("https://example.com", { format: "yaml" }),
		/Unknown format "yaml"/,
	);
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
	await assert.rejects(() => render(url, { har: file, timeout: 5000 }));

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

test("a missing robots.txt fails open", async () => {
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
	// the assertion above would pass for the wrong reason.
	await assert.rejects(
		() => render("http://127.0.0.1:1/page", { ...NO_BROWSER, fetch: spy }),
		/Chromium binary not found/,
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

test("sleeps for Crawl-delay between the robots.txt fetch and the page fetch", async () => {
	const s = await serve({ "/robots.txt": "User-agent: *\nCrawl-delay: 1\n" });
	const started = Date.now();
	try {
		await assert.rejects(
			() => render(`${s.origin}/page`, NO_BROWSER),
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
