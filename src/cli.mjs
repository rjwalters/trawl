#!/usr/bin/env node
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthWallError, FORMATS, render } from "./render.mjs";

// The profile directory `trawl login` writes to when neither --profile nor
// $TRAWL_PROFILE_DIR is supplied. A single shared directory (rather than one
// per origin) mirrors how a real browser profile works — one cookie jar,
// many logged-in origins — which is also exactly how `launchPersistentContext`
// already behaves per-directory; this just gives that a default name so
// `trawl login <origin>` doesn't force the operator to invent a path before
// they understand what it's for (#24). An explicit `--profile <dir>` /
// `$TRAWL_PROFILE_DIR` still takes precedence, and remains the way to
// isolate sessions per site.
//
// Deliberately NOT applied as a default for ordinary `trawl <url>` fetches —
// those stay ephemeral-by-default (see the comment above the `--profile`
// branch in render.mjs); pass `--profile <this same path>` there to reuse a
// session `trawl login` saved.
export function defaultProfileDir() {
	return path.join(homedir(), ".trawl", "profile");
}

const USAGE = `trawl — curl for the JavaScript web

Usage:
  trawl <url> [options]
  trawl login <origin>     Open a headed browser to sign in; saves the
                            session to --profile <dir> / TRAWL_PROFILE_DIR
                            (defaults to ~/.trawl/profile)
  trawl mcp                Serve fetch_page/fetch_links over MCP (stdio)

Options:
  -f, --format <fmt>       text | html | links | title | markdown (md)
                                                               (default: text)
      --no-readability     Skip article extraction for -f markdown
  -s, --selector <css>     Extract only this element
  -w, --wait-for <css>     Block until this selector appears
      --settle <ms>        Extra pause after load                (default: 0)
      --wait-until <ev>    load | domcontentloaded | networkidle
                                                        (default: networkidle)
                            networkidle never fires on pages that hold a
                            socket open (websockets, SSE); trawl retries once
                            with domcontentloaded on a networkidle timeout, or
                            pass --wait-until domcontentloaded --settle <ms>
                            yourself to skip straight to it. The same recipe
                            (--wait-until domcontentloaded --settle 15000)
                            also works around anti-bot interstitials (e.g.
                            HathiTrust's) that hold networkidle open forever.
      --timeout <ms>       Navigation/selector timeout       (default: 30000)
  -o, --output <file>      Write to a file instead of stdout
  -A, --user-agent <ua>    Override the User-Agent
      --har <file>         Write a HAR 1.2 network trace to this file
      --har-omit-content   Record HAR metadata only, no response bodies
      --executable-path <p>  Chromium binary to use
      --screenshot <file>  Also write a PNG screenshot to this path
      --full-page          Screenshot the whole scroll height
      --viewport <WxH>     Viewport size, e.g. 1280x800     (default: 1280x2000)
      --ignore-robots      Skip the robots.txt check
      --profile <dir>      Persistent browser profile dir (cookies/
                            localStorage survive across runs); also read from
                            $TRAWL_PROFILE_DIR. Populate one with "trawl login"
                            (which defaults this to ~/.trawl/profile, shared
                            across every origin, if you don't pass --profile/
                            $TRAWL_PROFILE_DIR there either). A plain fetch
                            stays isolated (no persistence) unless you pass
                            --profile/$TRAWL_PROFILE_DIR here too.
      --no-auth-check      Skip login-wall detection (see exit code 3 below)
  -S, --show-status        Print HTTP status + final URL to stderr
  -h, --help               Show this help
  -v, --version            Show version

Examples:
  trawl https://example.com/spa
  trawl https://example.com -f links
  trawl https://example.com -s '#main' -f html -o page.html
  trawl https://example.com -w '.results-loaded' --settle 500
  trawl https://example.com --screenshot page.png --full-page
  trawl login https://example.com --profile ~/.trawl/example
  trawl https://example.com --profile ~/.trawl/example

Exit codes: 0 success, 22 page returned 4xx/5xx (as curl --fail), 3 page
appears to be behind a login wall (see --no-auth-check / trawl login),
1 usage or runtime error.
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
	"--screenshot",
	"--viewport",
	"--profile",
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
			arg === "--har-omit-content" ||
			arg === "--full-page" ||
			arg === "--ignore-robots" ||
			arg === "--no-readability" ||
			arg === "--no-auth-check"
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

export function parseViewport(value) {
	const m = /^(\d+)x(\d+)$/.exec(value ?? "");
	const width = m ? Number(m[1]) : 0;
	const height = m ? Number(m[2]) : 0;
	if (!m || width <= 0 || height <= 0) {
		throw new Error(
			`--viewport expects <width>x<height>, e.g. 1280x800, got "${value}"`,
		);
	}
	return { width, height };
}

export async function main(argv) {
	// The subcommands. Checked before parseArgs so the URL path below stays
	// exactly as it was; a URL can never be the bare string "mcp"/"login"
	// because every URL trawl accepts carries a scheme.
	if (argv[0] === "mcp") {
		const { runMcpServer } = await import("./mcp.mjs");
		return await runMcpServer(argv.slice(1));
	}
	if (argv[0] === "login") {
		return await runLogin(argv.slice(1));
	}

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

	const requested = args["--format"] ?? "text";
	// Resolve the `md` alias before validating, so the error message below only
	// ever names canonical formats.
	const format = requested === "md" ? "markdown" : requested;
	if (!FORMATS.includes(format)) {
		throw new Error(
			`Unknown format "${format}" (expected one of: ${FORMATS.join(", ")})`,
		);
	}

	// Parsed up front so a malformed value fails before any browser launches.
	const viewport = args["--viewport"]
		? parseViewport(args["--viewport"])
		: undefined;

	const result = await render(args._[0], {
		format,
		readability: !args["--no-readability"],
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
		screenshot: args["--screenshot"],
		fullPage: !!args["--full-page"],
		ignoreRobots: args["--ignore-robots"] === true,
		// Deliberately NOT defaulted the way `trawl login`'s profile dir is
		// (#24): a plain fetch stays ephemeral-by-default (render.mjs's own
		// documented isolation guarantee — nothing one run does is visible to
		// the next) unless the caller opts in with --profile/$TRAWL_PROFILE_DIR.
		// Pass --profile ~/.trawl/profile (the same default `trawl login`
		// used) to pick the saved session back up.
		profileDir: args["--profile"] ?? process.env.TRAWL_PROFILE_DIR,
		authCheck: !args["--no-auth-check"],
		// Only override when the flag was actually supplied, so render()'s own
		// default viewport keeps applying to every other call.
		...(viewport ? { viewport } : {}),
	});

	if (result.waitUntilFallback) {
		process.stderr.write(
			`trawl: ${result.waitUntilFallback.from} timed out; retried with ` +
				`${result.waitUntilFallback.to}. Pass --wait-until ` +
				`${result.waitUntilFallback.to} --settle <ms> to skip the wait next time.\n`,
		);
	}
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

// `trawl login <origin>` — open a *headed* browser against a persistent
// profile directory, let a human sign in, and close. Because the profile is
// persistent, nothing extra needs to be saved on close: the same directory
// handed to `render({ profileDir })` (or `--profile`) on a later run already
// has the cookies/localStorage the sign-in left behind.
//
// `deps` exists so the browser lifecycle can be swapped out in tests without
// a real (headed) Chromium — mirrors the `deps` pattern in mcp.mjs.
export async function runLogin(argv, deps = {}) {
	const env = deps.env ?? process.env;
	const args = parseArgs(argv);

	const origin = args._[0];
	if (!origin) {
		throw new Error(
			"trawl login requires a URL, e.g. trawl login https://example.com",
		);
	}
	if (args._.length > 1) {
		throw new Error(`Expected one URL, got ${args._.length}: ${args._.join(" ")}`);
	}
	const explicitProfileDir = args["--profile"] ?? env.TRAWL_PROFILE_DIR;
	const usedDefaultProfileDir = !explicitProfileDir;
	const profileDir = explicitProfileDir ?? defaultProfileDir();

	const mkdir = deps.mkdirSync ?? mkdirSync;
	mkdir(profileDir, { recursive: true });

	const launch = deps.launchPersistentContext ?? defaultLaunchPersistentContext;
	const waitForUser = deps.waitForUser ?? defaultWaitForUser;
	const stderr = deps.stderr ?? ((s) => process.stderr.write(s));

	const { resolveExecutablePath } = await import("./browser.mjs");
	const executablePath = resolveExecutablePath(args["--executable-path"]);

	const context = await launch(profileDir, { executablePath, headless: false });
	const page = await context.newPage();
	await page.goto(origin);

	stderr(
		`A browser window has opened at ${origin}.\n` +
			"Sign in, then close the browser window (or press Enter here) to save " +
			`the session to:\n  ${profileDir}\n` +
			(usedDefaultProfileDir
				? "(no --profile/TRAWL_PROFILE_DIR given; defaulted to the above " +
					"directory, shared across every origin unless you pass " +
					"--profile/TRAWL_PROFILE_DIR to isolate a session per site)\n"
				: ""),
	);

	await waitForUser(context);
	// The user may have already closed the window themselves, in which case
	// the context is already gone — closing it again is a harmless no-op.
	await context.close().catch(() => {});

	stderr(`Session saved to ${profileDir}\n`);
	return 0;
}

async function defaultLaunchPersistentContext(profileDir, options) {
	const { chromium } = await import("playwright-core");
	return chromium.launchPersistentContext(profileDir, options);
}

function defaultWaitForUser(context) {
	return new Promise((resolve) => {
		const finish = () => {
			process.stdin.pause();
			resolve();
		};
		context.once("close", finish);
		process.stdin.resume();
		process.stdin.once("data", finish);
	});
}

// Are we the entry point, or were we imported as a library?
//
// This cannot match on the filename. npm installs `bin` as a symlink, and the
// shebang re-execs as `node <symlink>`, so process.argv[1] is the symlink
// (…/bin/trawl) rather than this file — Node never realpaths it. A suffix test
// against "cli.mjs" is therefore false for every global install, and the CLI
// exits 0 having done nothing (#14).
//
// Realpath BOTH sides: argv[1] because it may be a symlink, and import.meta.url
// because --preserve-symlinks-main leaves it un-resolved. Anything unreadable
// (argv[1] absent under `node -e`, a deleted entry) means "not the entry point".
export function isMainModule(entry = process.argv[1], self = import.meta.url) {
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(self));
	} catch {
		return false;
	}
}

if (isMainModule()) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`trawl: ${err.message}\n`);
		// A distinct exit code for the one failure mode a calling agent should
		// react to differently: stop and ask a human to sign in, rather than
		// retry or (worse) treat the login-wall body as real content.
		process.exitCode = err instanceof AuthWallError ? 3 : 1;
	}
}
