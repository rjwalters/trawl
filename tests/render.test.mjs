// End-to-end render tests. These need a Chromium binary; when none is
// installed (a fresh checkout, or CI before the browser step) they skip
// rather than fail, so `npm test` is always runnable.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

function fixtureUrl(html, name) {
	const dir = mkdtempSync(path.join(tmpdir(), "trawl-test-"));
	const file = path.join(dir, name);
	writeFileSync(file, html);
	return pathToFileURL(file).href;
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

test("rejects an unknown format before launching a browser", async () => {
	await assert.rejects(
		() => render("https://example.com", { format: "yaml" }),
		/Unknown format "yaml"/,
	);
});
