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
