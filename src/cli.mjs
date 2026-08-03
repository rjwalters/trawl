#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { FORMATS, render } from "./render.mjs";

const USAGE = `trawl — curl for the JavaScript web

Usage:
  trawl <url> [options]

Options:
  -f, --format <fmt>       text | html | links | title      (default: text)
  -s, --selector <css>     Extract only this element
  -w, --wait-for <css>     Block until this selector appears
      --settle <ms>        Extra pause after load                (default: 0)
      --wait-until <ev>    load | domcontentloaded | networkidle
                                                        (default: networkidle)
      --timeout <ms>       Navigation/selector timeout       (default: 30000)
  -o, --output <file>      Write to a file instead of stdout
  -A, --user-agent <ua>    Override the User-Agent
      --har <file>         Write a HAR 1.2 network trace to this file
      --har-omit-content   Record HAR metadata only, no response bodies
      --executable-path <p>  Chromium binary to use
  -S, --show-status        Print HTTP status + final URL to stderr
  -h, --help               Show this help
  -v, --version            Show version

Examples:
  trawl https://example.com/spa
  trawl https://example.com -f links
  trawl https://example.com -s '#main' -f html -o page.html
  trawl https://example.com -w '.results-loaded' --settle 500
`;

const FLAG_ALIASES = {
	"-f": "--format",
	"-s": "--selector",
	"-w": "--wait-for",
	"-o": "--output",
	"-A": "--user-agent",
	"-S": "--show-status",
	"-h": "--help",
	"-v": "--version",
};

const VALUED = new Set([
	"--format",
	"--selector",
	"--wait-for",
	"--settle",
	"--wait-until",
	"--timeout",
	"--output",
	"--user-agent",
	"--executable-path",
	"--har",
]);

export function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (FLAG_ALIASES[arg]) arg = FLAG_ALIASES[arg];

		if (!arg.startsWith("-")) {
			out._.push(arg);
			continue;
		}
		// Support --flag=value as well as --flag value.
		const eq = arg.indexOf("=");
		if (eq > -1) {
			const key = arg.slice(0, eq);
			if (!VALUED.has(key)) throw new Error(`Unknown option: ${key}`);
			out[key] = arg.slice(eq + 1);
			continue;
		}
		if (VALUED.has(arg)) {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			out[arg] = value;
			continue;
		}
		if (
			arg === "--help" ||
			arg === "--version" ||
			arg === "--show-status" ||
			arg === "--har-omit-content"
		) {
			out[arg] = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return out;
}

function toNumber(value, flag) {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`${flag} expects a non-negative number, got "${value}"`);
	}
	return n;
}

export async function main(argv) {
	const args = parseArgs(argv);

	if (args["--help"] || (args._.length === 0 && !args["--version"])) {
		process.stdout.write(USAGE);
		return args["--help"] ? 0 : 1;
	}
	if (args["--version"]) {
		const { default: pkg } = await import("../package.json", {
			with: { type: "json" },
		});
		process.stdout.write(`${pkg.version}\n`);
		return 0;
	}
	if (args._.length > 1) {
		throw new Error(`Expected one URL, got ${args._.length}: ${args._.join(" ")}`);
	}

	const format = args["--format"] ?? "text";
	if (!FORMATS.includes(format)) {
		throw new Error(
			`Unknown format "${format}" (expected one of: ${FORMATS.join(", ")})`,
		);
	}

	const result = await render(args._[0], {
		format,
		selector: args["--selector"],
		waitForSelector: args["--wait-for"],
		settle: args["--settle"] ? toNumber(args["--settle"], "--settle") : 0,
		waitUntil: args["--wait-until"] ?? "networkidle",
		timeout: args["--timeout"]
			? toNumber(args["--timeout"], "--timeout")
			: 30000,
		userAgent: args["--user-agent"],
		executablePath: args["--executable-path"],
		har: args["--har"],
		harOmitContent: Boolean(args["--har-omit-content"]),
	});

	if (args["--show-status"]) {
		process.stderr.write(`${result.status} ${result.url}\n`);
	}
	if (args["--output"]) {
		writeFileSync(args["--output"], result.body);
	} else {
		process.stdout.write(`${result.body}\n`);
	}

	// Mirror curl --fail-ish semantics: a 4xx/5xx is a non-zero exit even
	// though we still emit whatever the page rendered.
	return result.status && result.status >= 400 ? 22 : 0;
}

const invokedDirectly = process.argv[1]?.endsWith("cli.mjs");
if (invokedDirectly) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`trawl: ${err.message}\n`);
		process.exitCode = 1;
	}
}
