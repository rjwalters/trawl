// Unit tests for the MCP tool handlers. These drive `callTool` directly with
// an injected `render`, so no MCP client, browser, or network is needed. The
// handful of tests that do want a real render use the shared `browserOpts`
// skip guard from tests/helpers.mjs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	DEFAULT_MAX_CHARS,
	TOOLS,
	MAX_WAIT_MS,
	WAIT_UNTIL,
	callTool,
	maxChars,
	renderOptionsFor,
	truncate,
} from "../src/mcp.mjs";
import { browserOpts as opts, fixtureUrl as sharedFixtureUrl } from "./helpers.mjs";

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
	assert.deepEqual(schema.format.enum, [
		"text",
		"html",
		"links",
		"title",
		"markdown",
	]);
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

// --- load controls: wait_until / settle_ms / timeout_ms ---------------------

test("both tools advertise the three load controls", () => {
	for (const tool of TOOLS) {
		const props = tool.inputSchema.properties;
		// Enum derived from WAIT_UNTIL, like `format`'s is from FORMATS: a
		// hand-written copy here is exactly how the format list went stale.
		assert.deepEqual(props.wait_until.enum, [...WAIT_UNTIL]);
		assert.equal(props.settle_ms.type, "number");
		assert.equal(props.settle_ms.minimum, 0);
		assert.equal(props.settle_ms.maximum, MAX_WAIT_MS);
		assert.equal(props.timeout_ms.type, "number");
		// Playwright reads 0 as "no timeout"; this surface refuses it rather
		// than letting an agent hang a stdio call with no way to cancel it.
		assert.equal(props.timeout_ms.minimum, 1);
		assert.equal(props.timeout_ms.maximum, MAX_WAIT_MS);
		assert.match(props.timeout_ms.description, /no timeout/);
	}
});

test("fetch_page maps the load controls onto render's option names", () => {
	const { options } = renderOptionsFor("fetch_page", {
		url: "https://example.com",
		wait_until: "domcontentloaded",
		settle_ms: 2000,
		timeout_ms: 45000,
	});
	assert.equal(options.waitUntil, "domcontentloaded");
	assert.equal(options.settle, 2000);
	assert.equal(options.timeout, 45000);
});

test("fetch_links maps the load controls too", () => {
	const { options } = renderOptionsFor("fetch_links", {
		url: "https://example.com",
		wait_until: "load",
		settle_ms: 500,
		timeout_ms: 1,
	});
	assert.equal(options.format, "links");
	assert.equal(options.waitUntil, "load");
	assert.equal(options.settle, 500);
	assert.equal(options.timeout, 1);
});

// The guard for "omitting all three leaves behaviour exactly as today".
// `render()` merges `{ ...DEFAULTS, ...options }` and an object spread does
// NOT skip `undefined`, so an always-set key would overwrite
// `waitUntil: "networkidle"` with `undefined` — making `page.goto` fall back
// to Playwright's own `load` default and silently disabling the
// networkidle->domcontentloaded retry this whole feature exists to reach.
// The keys must be absent, not present-and-undefined.
test("omitting the load controls leaves the keys absent, not undefined", () => {
	for (const name of ["fetch_page", "fetch_links"]) {
		const { options } = renderOptionsFor(name, { url: "https://example.com" });
		assert.equal("waitUntil" in options, false, `${name} set waitUntil`);
		assert.equal("settle" in options, false, `${name} set settle`);
		assert.equal("timeout" in options, false, `${name} set timeout`);
	}
});

test("a partial call sets only the load controls it was given", () => {
	const { options } = renderOptionsFor("fetch_page", {
		url: "https://example.com",
		settle_ms: 1500,
	});
	assert.equal(options.settle, 1500);
	assert.equal("waitUntil" in options, false);
	assert.equal("timeout" in options, false);
});

// Mirrors `requireString`, which treats an explicit null as "not supplied".
test("an explicit null load control counts as absent", () => {
	const { options } = renderOptionsFor("fetch_page", {
		url: "u",
		wait_until: null,
		settle_ms: null,
		timeout_ms: null,
	});
	assert.equal("waitUntil" in options, false);
	assert.equal("settle" in options, false);
	assert.equal("timeout" in options, false);
});

test("settle_ms accepts 0 and both accept exactly MAX_WAIT_MS", () => {
	const zero = renderOptionsFor("fetch_page", { url: "u", settle_ms: 0 });
	assert.equal(zero.options.settle, 0);
	const max = renderOptionsFor("fetch_page", {
		url: "u",
		settle_ms: MAX_WAIT_MS,
		timeout_ms: MAX_WAIT_MS,
	});
	assert.equal(max.options.settle, MAX_WAIT_MS);
	assert.equal(max.options.timeout, MAX_WAIT_MS);
});

test("rejects a wait_until outside the enum, naming the allowed values", () => {
	assert.throws(
		() => renderOptionsFor("fetch_page", { url: "u", wait_until: "bogus" }),
		/"wait_until" must be one of: load, domcontentloaded, networkidle/,
	);
	assert.throws(
		() => renderOptionsFor("fetch_links", { url: "u", wait_until: 42 }),
		/"wait_until" must be one of: load, domcontentloaded, networkidle/,
	);
});

test("rejects non-numeric and out-of-range load controls on both tools", () => {
	const cases = [
		[{ settle_ms: "2000" }, /"settle_ms" must be a number/],
		[{ settle_ms: true }, /"settle_ms" must be a number/],
		[{ settle_ms: Number.NaN }, /"settle_ms" must be a finite number/],
		[
			{ settle_ms: Number.POSITIVE_INFINITY },
			/"settle_ms" must be a finite number/,
		],
		[{ settle_ms: -1 }, /"settle_ms" must be at least 0/],
		[{ settle_ms: MAX_WAIT_MS + 1 }, /"settle_ms" must be at most 600000/],
		[{ timeout_ms: 0 }, /"timeout_ms" must be at least 1/],
		[{ timeout_ms: -5 }, /"timeout_ms" must be at least 1/],
		[{ timeout_ms: MAX_WAIT_MS + 1 }, /"timeout_ms" must be at most 600000/],
		[{ timeout_ms: "30s" }, /"timeout_ms" must be a number/],
	];
	for (const [extra, pattern] of cases) {
		for (const name of ["fetch_page", "fetch_links"]) {
			assert.throws(
				() => renderOptionsFor(name, { url: "u", ...extra }),
				pattern,
				`${name} accepted ${JSON.stringify(extra)}`,
			);
		}
	}
});

test("a rejected load control is a tool error and never reaches render", async () => {
	const render = stubRender("body");
	const bad = [
		{ wait_until: "bogus" },
		{ settle_ms: -1 },
		{ settle_ms: "2000" },
		{ settle_ms: Number.NaN },
		{ timeout_ms: 0 },
		{ timeout_ms: MAX_WAIT_MS + 1 },
	];
	for (const extra of bad) {
		for (const name of ["fetch_page", "fetch_links"]) {
			const result = await callTool(name, { url: "u", ...extra }, { render, env: {} });
			assert.equal(result.isError, true, `${name} ${JSON.stringify(extra)}`);
		}
	}
	assert.equal(render.calls.length, 0);

	// ...and the server still serves the next, valid call.
	const good = await callTool(
		"fetch_page",
		{ url: "u", wait_until: "domcontentloaded", settle_ms: 2000 },
		{ render, env: {} },
	);
	assert.equal(good.isError, undefined);
	assert.equal(text(good), "body");
	assert.deepEqual(render.calls, [
		{
			url: "u",
			options: {
				format: "text",
				selector: undefined,
				waitForSelector: undefined,
				waitUntil: "domcontentloaded",
				settle: 2000,
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
	for (const args of [
		{},
		{ url: "u", format: "yaml" },
		{ url: "u", wait_until: "bogus" },
		{ url: "u", timeout_ms: 0 },
	]) {
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

const fixtureUrl = (html, name) => sharedFixtureUrl(html, name, "trawl-mcp-test-");

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
