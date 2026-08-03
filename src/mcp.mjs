// A stdio MCP server that exposes trawl's renderer to agent frameworks.
//
// Two tools, deliberately: `fetch_page` (the CLI's core) and `fetch_links`
// (link extraction, kept separate so an agent can crawl without pulling whole
// page bodies into its context). Nothing here clicks, types, or navigates a
// session — trawl fetches.
//
// Browser lifecycle is per call: every handler goes through `render()`, which
// owns its own launch/close, exactly like the CLI does. No pooling, no shared
// state between calls.

import { readFileSync } from "node:fs";
import { FORMATS, render } from "./render.mjs";

// Page text routinely blows past a sane tool-result budget. v1 truncates with
// a notice rather than paginating: `fetch_links` already covers the
// crawl-without-the-body case that pagination would otherwise be needed for.
export const DEFAULT_MAX_CHARS = 100000;

export function maxChars(env = process.env) {
	const raw = env.TRAWL_MCP_MAX_CHARS;
	if (raw === undefined || raw === "") return DEFAULT_MAX_CHARS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(
			`TRAWL_MCP_MAX_CHARS expects a positive number, got "${raw}"`,
		);
	}
	return Math.floor(n);
}

export function truncate(body, limit) {
	if (body.length <= limit) return body;
	return [
		body.slice(0, limit),
		"",
		`[trawl: output truncated to ${limit} of ${body.length} characters.`,
		"Raise the budget with TRAWL_MCP_MAX_CHARS, narrow the page with the",
		"`selector` argument, or use `fetch_links` to crawl without page bodies.]",
	].join("\n");
}

export const TOOLS = [
	{
		name: "fetch_page",
		description:
			"Render a URL in headless Chromium and return what a human would " +
			"actually see. Use this instead of a plain HTTP fetch when the page " +
			"is client-rendered and a raw fetch comes back as an empty shell.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Absolute URL to render (http, https, or file).",
				},
				format: {
					type: "string",
					enum: [...FORMATS],
					description:
						"Shape of the result: text (default), html, links, or title.",
				},
				selector: {
					type: "string",
					description: "CSS selector to extract instead of the whole body.",
				},
				wait_for: {
					type: "string",
					description:
						"CSS selector to block on before extracting, for content that " +
						"appears after the initial paint.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
	{
		name: "fetch_links",
		description:
			"Render a URL and return only its links, one per line as " +
			"'href<TAB>text'. Cheaper than fetch_page for crawling, because page " +
			"bodies never enter the context.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Absolute URL to render (http, https, or file).",
				},
				selector: {
					type: "string",
					description: "CSS selector to scope link extraction to.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
];

function requireString(args, key, { required = false } = {}) {
	const value = args?.[key];
	if (value === undefined || value === null) {
		if (required) throw new Error(`"${key}" is required`);
		return undefined;
	}
	if (typeof value !== "string" || value === "") {
		throw new Error(`"${key}" must be a non-empty string`);
	}
	return value;
}

// Map an MCP tool call's arguments onto `render()`'s options. Kept separate
// from the handlers so the mapping is unit-testable without a browser.
export function renderOptionsFor(name, args = {}) {
	if (name === "fetch_links") {
		return {
			url: requireString(args, "url", { required: true }),
			options: { format: "links", selector: requireString(args, "selector") },
		};
	}
	if (name === "fetch_page") {
		const format = requireString(args, "format") ?? "text";
		if (!FORMATS.includes(format)) {
			throw new Error(
				`Unknown format "${format}" (expected one of: ${FORMATS.join(", ")})`,
			);
		}
		return {
			url: requireString(args, "url", { required: true }),
			options: {
				format,
				selector: requireString(args, "selector"),
				waitForSelector: requireString(args, "wait_for"),
			},
		};
	}
	throw new Error(`Unknown tool "${name}"`);
}

// A single bad call must not take down the stdio server for the rest of the
// session, so every failure below comes back as a tool-level error result
// rather than a thrown exception.
export async function callTool(name, args = {}, deps = {}) {
	const doRender = deps.render ?? render;
	const env = deps.env ?? process.env;

	try {
		const limit = maxChars(env);
		const { url, options } = renderOptionsFor(name, args);
		const result = await doRender(url, options);
		return {
			content: [{ type: "text", text: truncate(result.body ?? "", limit) }],
		};
	} catch (err) {
		return {
			content: [{ type: "text", text: `trawl: ${err.message}` }],
			isError: true,
		};
	}
}

export async function createServer() {
	// Imported lazily so the CLI's URL path never pays to load the SDK.
	const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
	const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
		"@modelcontextprotocol/sdk/types.js"
	);
	// Read rather than `import ... with { type: "json" }`: on Node 20/22 the
	// import attribute prints an ExperimentalWarning, and an MCP server should
	// not spray anything onto a client's stderr just by starting up.
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);

	const server = new Server(
		{ name: "trawl", version: pkg.version },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS,
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
		callTool(request.params.name, request.params.arguments ?? {}),
	);

	return server;
}

export async function runMcpServer(argv = []) {
	if (argv.length > 0) {
		throw new Error(`mcp takes no arguments, got: ${argv.join(" ")}`);
	}

	const { StdioServerTransport } = await import(
		"@modelcontextprotocol/sdk/server/stdio.js"
	);
	const server = await createServer();
	await server.connect(new StdioServerTransport());

	// Stay up until the client hangs up or we're killed. The SDK's stdio
	// transport doesn't surface stdin EOF as a close, so watch for it too —
	// otherwise the await below never settles and Node warns on the way out.
	await new Promise((resolve) => {
		server.onclose = resolve;
		process.stdin.once("end", resolve);
		process.stdin.once("close", resolve);
	});
	await server.close().catch(() => {});
	return 0;
}
