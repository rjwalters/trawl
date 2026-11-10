// Guards the two hand-maintained copies CLAUDE.md names: the README's usage
// block (a copy of `--help`) and its MCP tool table (a copy of TOOLS in
// src/mcp.mjs). Compares flags and argument names, not prose. No browser needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TOOLS } from "../src/mcp.mjs";
import { FORMATS } from "../src/render.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

// An option line starts within a few columns of the margin; continuation
// prose is indented far deeper, so `--settle` mid-description is ignored.
const OPTION_LINE = /^ {0,6}(?:(-\w), )?(--[\w-]+)/;

function optionFlags(text) {
	const flags = new Set();
	for (const line of text.split("\n")) {
		const m = OPTION_LINE.exec(line);
		if (!m) continue;
		if (m[1]) flags.add(m[1]);
		flags.add(m[2]);
	}
	return flags;
}

function section(heading) {
	const start = readme.indexOf(`\n${heading}\n`);
	assert.notEqual(start, -1, `README.md has no "${heading}" heading`);
	const rest = readme.slice(start + heading.length + 2);
	const next = rest.search(/^#{2,3} /m);
	return next === -1 ? rest : rest.slice(0, next);
}

test("README usage block lists the same flags as --help", () => {
	const fence = /```\n([\s\S]*?)```/.exec(section("## Usage"));
	assert.ok(fence, "README.md '## Usage' has no fenced block");
	const help = spawnSync(process.execPath, [path.join(root, "src/cli.mjs"), "--help"], {
		encoding: "utf8",
	});
	assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);

	const inReadme = optionFlags(fence[1]);
	const inHelp = optionFlags(help.stdout);
	const missing = [...inHelp].filter((f) => !inReadme.has(f));
	const extra = [...inReadme].filter((f) => !inHelp.has(f));
	assert.deepEqual(
		{ missing, extra },
		{ missing: [], extra: [] },
		`README usage block is out of sync with --help: missing from README: [${missing.join(", ")}]; ` +
			`in README but not in --help: [${extra.join(", ")}]`,
	);
});

test("README MCP tool table matches TOOLS", () => {
	const rows = new Map();
	for (const line of section("### As an MCP server").split("\n")) {
		const m = /^\|\s*`(\w+)`\s*\|(.*)\|\s*$/.exec(line);
		if (m) rows.set(m[1], m[2]);
	}
	const names = TOOLS.map((t) => t.name);
	assert.deepEqual(
		[...rows.keys()].sort(),
		[...names].sort(),
		`README MCP table tools [${[...rows.keys()].sort().join(", ")}] differ from TOOLS [${[...names].sort().join(", ")}]`,
	);

	for (const tool of TOOLS) {
		const cell = rows.get(tool.name);
		// Strip the parenthesised value list so its backticks aren't read as args.
		const argsCell = cell.replace(/\([^)]*\)/g, "");
		const documented = new Map();
		for (const m of argsCell.matchAll(/`(\w+)(\?)?`/g)) documented.set(m[1], m[2] !== "?");

		const props = Object.keys(tool.inputSchema.properties);
		const required = new Set(tool.inputSchema.required ?? []);
		for (const p of props) {
			assert.ok(documented.has(p), `README table row for ${tool.name} is missing argument "${p}"`);
			assert.equal(
				documented.get(p),
				required.has(p),
				`README table row for ${tool.name}: argument "${p}" should be ${required.has(p) ? "required (no ?)" : "optional (trailing ?)"}`,
			);
		}
		for (const d of documented.keys()) {
			assert.ok(props.includes(d), `README table row for ${tool.name} documents "${d}", which is not in its inputSchema`);
		}

		const formatProp = tool.inputSchema.properties.format;
		if (formatProp) {
			const paren = /`format\?`\s*\(([^)]*)\)/.exec(cell);
			assert.ok(paren, `README table row for ${tool.name} has no format value list`);
			const values = [...paren[1].matchAll(/`(\w+)`/g)].map((m) => m[1]);
			assert.deepEqual(
				values,
				[...FORMATS],
				`README format values [${values.join(", ")}] for ${tool.name} differ from FORMATS [${FORMATS.join(", ")}]`,
			);
		}
	}
});
