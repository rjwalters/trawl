// A stdio MCP server that exposes trawl's renderer to agent frameworks.
//
// Two tools, deliberately: `fetch_page` (the CLI's core) and `fetch_links`
// (link extraction, kept separate so an agent can crawl without pulling whole
// page bodies into its context). Nothing here clicks, types, or navigates a
// session — trawl fetches. That is on purpose even though the CLI and
// library can `--click`: a person choosing a selector to press is one thing,
// an agent pressing whatever a page it is reading tells it to is another, so
// the agent-facing surface stays read-only.
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

// Load controls. `render()` has always accepted `waitUntil`, `settle` and
// `timeout`; only this surface's mapping and schemas were missing, so an agent
// could not reach the README's own "Pages that never go idle" recipe
// (`--wait-until domcontentloaded --settle <ms>`) and every such page waited
// out the full default timeout before the automatic retry.

// `render()`'s accepted navigation conditions, in Playwright's order. Declared
// here because `render()` passes the value straight through and has no list to
// import; this is the MCP surface's single source of truth, feeding both the
// schema enum and the rejection message so the two cannot drift.
export const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle"];

// One bound for both millisecond controls, in the spirit of
// `ROBOTS_TIMEOUT_MS`'s "one fixed, sane budget": an agent that can ask a
// stdio server for an arbitrarily long wait can hang the session, and there is
// no way to cancel a call in flight.
export const MAX_WAIT_MS = 600000;

// Defined once and spread into both tools. A hand-copied second definition is
// precisely how the `format` description drifted from its own enum.
const LOAD_CONTROL_PROPERTIES = {
	wait_until: {
		type: "string",
		enum: [...WAIT_UNTIL],
		// Derived from WAIT_UNTIL, like `format`'s text is from FORMATS.
		description:
			`Navigation condition to wait for: ${WAIT_UNTIL.join(", ")}. ` +
			"Defaults to networkidle, which also retries automatically with " +
			"domcontentloaded if it times out. Pass domcontentloaded together " +
			"with settle_ms for a page that holds a socket open and never goes " +
			"idle.",
	},
	settle_ms: {
		type: "number",
		minimum: 0,
		maximum: MAX_WAIT_MS,
		description:
			`Extra milliseconds to wait after navigation, 0 to ${MAX_WAIT_MS}. ` +
			"Defaults to 0. Use with wait_until=domcontentloaded to give a " +
			"client-rendered page time to paint.",
	},
	timeout_ms: {
		type: "number",
		minimum: 1,
		maximum: MAX_WAIT_MS,
		description:
			`Navigation timeout in milliseconds, 1 to ${MAX_WAIT_MS}. Defaults ` +
			"to 30000. 0 is rejected rather than read as Playwright's \"no " +
			"timeout\", which would hang this call with no way to cancel it.",
	},
};

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
					// Derived from FORMATS like the enum above: a hand-written list
					// here silently went stale when `markdown` was added.
					description: `Shape of the result: ${FORMATS.join(", ")}. Defaults to text.`,
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
				...LOAD_CONTROL_PROPERTIES,
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
				...LOAD_CONTROL_PROPERTIES,
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

// Absent (or an explicit null, matching `requireString`) means "not supplied";
// anything else must be in the advertised enum. The message is built from
// `allowed` so it cannot disagree with the schema.
function optionalEnum(args, key, allowed) {
	const value = args?.[key];
	if (value === undefined || value === null) return undefined;
	if (!allowed.includes(value)) {
		throw new Error(`"${key}" must be one of: ${allowed.join(", ")}`);
	}
	return value;
}

// The schema's `minimum`/`maximum` are advertisement only: `callTool` is
// called directly by tests and by any embedder, and nothing in
// `createServer` validates arguments against the advertised schema, so an
// unchecked value would reach `page.goto`. Enforce the same bounds here.
function optionalMs(args, key, { min, max = MAX_WAIT_MS }) {
	const value = args?.[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number") throw new Error(`"${key}" must be a number`);
	if (!Number.isFinite(value)) {
		throw new Error(`"${key}" must be a finite number`);
	}
	if (value < min) throw new Error(`"${key}" must be at least ${min}`);
	if (value > max) throw new Error(`"${key}" must be at most ${max}`);
	return value;
}

// Returns ONLY the keys the caller actually supplied. This is load-bearing:
// `render()` merges `{ ...DEFAULTS, ...options }`, and an object spread does
// not skip `undefined` values — so always setting these three would overwrite
// `waitUntil: "networkidle"` with `undefined` on every call that omits them.
// That would drop the default *and* silently disable the
// networkidle->domcontentloaded retry that this feature exists to reach.
// `selector`/`waitForSelector` may keep passing `undefined`: neither key is in
// `DEFAULTS`, so neither clobbers anything.
function loadControlsFor(args) {
	const waitUntil = optionalEnum(args, "wait_until", WAIT_UNTIL);
	// `settle_ms` accepts 0 (that is `render()`'s own default). `timeout_ms`
	// floors at 1 because Playwright reads 0 as "no timeout".
	const settle = optionalMs(args, "settle_ms", { min: 0 });
	const timeout = optionalMs(args, "timeout_ms", { min: 1 });
	return {
		...(waitUntil !== undefined && { waitUntil }),
		...(settle !== undefined && { settle }),
		...(timeout !== undefined && { timeout }),
	};
}

// Map an MCP tool call's arguments onto `render()`'s options. Kept separate
// from the handlers so the mapping is unit-testable without a browser.
export function renderOptionsFor(name, args = {}) {
	if (name === "fetch_links") {
		return {
			url: requireString(args, "url", { required: true }),
			options: {
				format: "links",
				selector: requireString(args, "selector"),
				...loadControlsFor(args),
			},
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
				...loadControlsFor(args),
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
