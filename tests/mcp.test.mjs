// Unit tests for the MCP tool handlers. These drive `callTool` directly with
// an injected `render`, so no MCP client, browser, or network is needed. The
// handful of tests that do want a real render use the same `haveBrowser`
// guard as tests/render.test.mjs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveExecutablePath } from "../src/browser.mjs";
import {
	DEFAULT_MAX_CHARS,
	TOOLS,
	callTool,
	maxChars,
	renderOptionsFor,
	truncate,
} from "../src/mcp.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const opts = { skip: haveBrowser ? false : "no Chromium binary installed" };

// A render stub that records what it was handed and replays a canned result.
function stubRender(body = "ok") {
	const calls = [];
	const fn = async (url, options) => {
		calls.push({ url, options });
		return { body, status: 200, url };
	};
	fn.calls = calls;
	return fn;
}

const text = (result) => result.content[0].text;

// --- tool advertisement -----------------------------------------------------

test("advertises exactly fetch_page and fetch_links", () => {
	assert.deepEqual(
		TOOLS.map((t) => t.name),
		["fetch_page", "fetch_links"],
	);
});

test("both tool schemas require a url", () => {
	for (const tool of TOOLS) {
		assert.equal(tool.inputSchema.type, "object");
		assert.deepEqual(tool.inputSchema.required, ["url"]);
		assert.equal(tool.inputSchema.properties.url.type, "string");
	}
});

test("fetch_page advertises the renderer's formats", () => {
	const schema = TOOLS[0].inputSchema.properties;
	assert.deepEqual(schema.format.enum, ["text", "html", "links", "title"]);
	assert.ok(schema.selector && schema.wait_for);
});

// --- argument mapping -------------------------------------------------------

test("fetch_page defaults to text and maps wait_for to waitForSelector", () => {
	const { url, options } = renderOptionsFor("fetch_page", {
		url: "https://example.com",
		selector: "#main",
		wait_for: ".loaded",
	});
	assert.equal(url, "https://example.com");
	assert.equal(options.format, "text");
	assert.equal(options.selector, "#main");
	assert.equal(options.waitForSelector, ".loaded");
});

test("fetch_links always renders as links", () => {
	const { options } = renderOptionsFor("fetch_links", {
		url: "https://example.com",
		selector: "nav",
	});
	assert.equal(options.format, "links");
	assert.equal(options.selector, "nav");
	assert.equal(options.waitForSelector, undefined);
});

test("rejects an unsupported format", () => {
	assert.throws(
		() => renderOptionsFor("fetch_page", { url: "u", format: "yaml" }),
		/Unknown format "yaml"/,
	);
});

test("rejects a missing url", () => {
	assert.throws(() => renderOptionsFor("fetch_page", {}), /"url" is required/);
});

test("rejects a non-string url", () => {
	assert.throws(
		() => renderOptionsFor("fetch_links", { url: 42 }),
		/"url" must be a non-empty string/,
	);
});

test("rejects an unknown tool name", () => {
	assert.throws(() => renderOptionsFor("click_button", { url: "u" }), /Unknown tool/);
});

test("callTool passes the mapped options through to render", async () => {
	const render = stubRender("hello");
	const result = await callTool(
		"fetch_page",
		{ url: "https://example.com", format: "html" },
		{ render, env: {} },
	);
	assert.equal(text(result), "hello");
	assert.equal(result.isError, undefined);
	assert.deepEqual(render.calls, [
		{
			url: "https://example.com",
			options: {
				format: "html",
				selector: undefined,
				waitForSelector: undefined,
			},
		},
	]);
});

// --- truncation -------------------------------------------------------------

test("leaves a body inside the budget alone", () => {
	assert.equal(truncate("short", 100), "short");
	assert.equal(truncate("exact", 5), "exact");
});

test("truncates with a notice naming both lengths", () => {
	const out = truncate("x".repeat(50), 10);
	assert.ok(out.startsWith("x".repeat(10)));
	assert.ok(!out.includes("x".repeat(11)));
	assert.match(out, /truncated to 10 of 50 characters/);
	assert.match(out, /TRAWL_MCP_MAX_CHARS/);
	assert.match(out, /fetch_links/);
});

test("maxChars defaults, honours the env override, and rejects garbage", () => {
	assert.equal(maxChars({}), DEFAULT_MAX_CHARS);
	assert.equal(maxChars({ TRAWL_MCP_MAX_CHARS: "" }), DEFAULT_MAX_CHARS);
	assert.equal(maxChars({ TRAWL_MCP_MAX_CHARS: "25" }), 25);
	assert.throws(
		() => maxChars({ TRAWL_MCP_MAX_CHARS: "nope" }),
		/expects a positive number/,
	);
	assert.throws(() => maxChars({ TRAWL_MCP_MAX_CHARS: "0" }), /positive number/);
});

test("a body over budget comes back truncated, not cut silently", async () => {
	const result = await callTool(
		"fetch_page",
		{ url: "https://example.com" },
		{ render: stubRender("y".repeat(500)), env: { TRAWL_MCP_MAX_CHARS: "20" } },
	);
	assert.equal(result.isError, undefined);
	assert.match(text(result), /truncated to 20 of 500 characters/);
});

// --- error translation ------------------------------------------------------

test("a render failure becomes a tool error, not a throw", async () => {
	const boom = async () => {
		throw new Error("net::ERR_NAME_NOT_RESOLVED at http://nope.invalid/");
	};
	const result = await callTool(
		"fetch_page",
		{ url: "http://nope.invalid/" },
		{ render: boom, env: {} },
	);
	assert.equal(result.isError, true);
	assert.match(text(result), /ERR_NAME_NOT_RESOLVED/);
});

test("a missing browser becomes a tool error carrying the install hint", async () => {
	const boom = async () => {
		const err = new Error("No Chromium binary found (looked in ...).");
		err.name = "NoBrowserError";
		throw err;
	};
	const result = await callTool("fetch_links", { url: "u" }, { render: boom, env: {} });
	assert.equal(result.isError, true);
	assert.match(text(result), /No Chromium binary found/);
});

test("bad arguments become a tool error, not a throw", async () => {
	const render = stubRender();
	for (const args of [{}, { url: "u", format: "yaml" }]) {
		const result = await callTool("fetch_page", args, { render, env: {} });
		assert.equal(result.isError, true);
	}
	// The failures were rejected before any browser work happened.
	assert.equal(render.calls.length, 0);
});

test("the handler survives a failure and serves the next call", async () => {
	let first = true;
	const flaky = async (url) => {
		if (first) {
			first = false;
			throw new Error("transient");
		}
		return { body: "second call fine", status: 200, url };
	};
	const bad = await callTool("fetch_page", { url: "u" }, { render: flaky, env: {} });
	assert.equal(bad.isError, true);
	const good = await callTool("fetch_page", { url: "u" }, { render: flaky, env: {} });
	assert.equal(good.isError, undefined);
	assert.equal(text(good), "second call fine");
});

// --- process lifecycle ------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("`trawl mcp` stays up until stdin closes, then exits 0", async () => {
	const child = spawn(process.execPath, [CLI, "mcp"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (c) => {
		stderr += c;
	});

	const exited = new Promise((resolve) => child.once("exit", resolve));
	// Still running with stdin held open.
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(child.exitCode, null, `exited early: ${stderr}`);

	child.stdin.end();
	assert.equal(await exited, 0);
	// Nothing error-shaped on the way out (a Node ExperimentalWarning on older
	// runtimes is not this test's business).
	assert.doesNotMatch(stderr, /trawl:|Error/);
});

test("`trawl mcp` rejects trailing arguments instead of silently serving", async () => {
	const child = spawn(process.execPath, [CLI, "mcp", "-f", "links"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (c) => {
		stderr += c;
	});
	const code = await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(code, 1);
	assert.match(stderr, /mcp takes no arguments/);
});

// --- against a real browser -------------------------------------------------

const SPA = `<!doctype html>
<title>Fixture</title>
<div id="root"></div>
<script>
  document.getElementById("root").innerHTML =
    '<h1>Hydrated</h1><a href="https://example.com/a">First</a>';
</script>`;

function fixtureUrl(html, name) {
	const dir = mkdtempSync(path.join(tmpdir(), "trawl-mcp-test-"));
	const file = path.join(dir, name);
	writeFileSync(file, html);
	return pathToFileURL(file).href;
}

test("fetch_page renders a real JS-built page", opts, async () => {
	const result = await callTool("fetch_page", {
		url: fixtureUrl(SPA, "spa.html"),
	});
	assert.equal(result.isError, undefined);
	assert.match(text(result), /Hydrated/);
});

test("fetch_page honours format and selector against a real page", opts, async () => {
	const url = fixtureUrl(SPA, "spa.html");
	const html = await callTool("fetch_page", { url, format: "html" });
	assert.match(text(html), /<h1>Hydrated<\/h1>/);

	const title = await callTool("fetch_page", { url, format: "title" });
	assert.equal(text(title), "Fixture");

	const scoped = await callTool("fetch_page", {
		url: fixtureUrl(
			`<!doctype html><div id="a">alpha</div><div id="b">beta</div>`,
			"two.html",
		),
		selector: "#b",
	});
	assert.equal(text(scoped).trim(), "beta");
});

test("fetch_links returns the same list as -f links", opts, async () => {
	const url = fixtureUrl(SPA, "spa.html");
	const viaTool = await callTool("fetch_links", { url });
	const viaFormat = await callTool("fetch_page", { url, format: "links" });
	assert.match(text(viaTool), /https:\/\/example\.com\/a\tFirst/);
	assert.equal(text(viaTool), text(viaFormat));
});
