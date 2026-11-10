#!/usr/bin/env node
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AUTH_COOKIES,
	addCookiesFailure,
	browserWouldReject,
	CookieParseError,
	describeExpiry,
	filterCookies,
	parseCookies,
	plural,
	printable,
	sourceUserAgent,
	summarize,
	whyNoneLeft,
} from "./cookies.mjs";
import {
	DEFAULT_MIN_INTERVAL_MS,
	MAX_MIN_INTERVAL_MS,
	validateMinInterval,
} from "./pacing.mjs";
import {
	AuthWallError,
	CooldownError,
	FORMATS,
	normalizeClickSteps,
	render,
} from "./render.mjs";

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
  trawl cookies import <file> --profile <dir>
                            Copy cookies from a HAR, a Netscape cookies.txt
                            or a copy-as-cURL command into a profile (below)
  trawl mcp                Serve fetch_page/fetch_links over MCP (stdio)

Options:
  -f, --format <fmt>       text | html | links | title | markdown (md)
                                                               (default: text)
      --no-readability     Skip article extraction for -f markdown
  -s, --selector <css>     Extract only this element
  -w, --wait-for <css>     Block until this selector appears
      --click <css>        Click the first match after load, before
                            extracting. Repeatable; runs in the order given.
                            Each waits until visible (up to --timeout), then
                            --settle (at least 250ms). Fails (exit 1) if it
                            never appears, or if a click would load another
                            page.
      --then-wait <css>    After the preceding --click, block until this
                            selector appears
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
      --har <file>         Write a HAR 1.2 network trace to this file.
                            It records cookie headers, values included, for
                            any fetch that sends cookies (--cookies or
                            --profile)
      --har-omit-content   Record HAR metadata only, no response bodies
                            (cookie headers and values are still recorded)
      --har-redact         Redact cookie and credential header values in the HAR
      --executable-path <p>  Chromium binary to use
      --screenshot <file>  Also write a PNG screenshot to this path
      --full-page          Screenshot the whole scroll height
      --viewport <WxH>     Viewport size, e.g. 1280x800     (default: 1280x2000)
      --ignore-robots      Skip the robots.txt check (not --min-interval)
      --min-interval <ms>  Minimum gap between requests to one origin,
                            across separate runs; Crawl-delay still wins if
                            larger. 0 drops the floor only. Max ${MAX_MIN_INTERVAL_MS}.
                                                             (default: ${DEFAULT_MIN_INTERVAL_MS})
      --no-pacing          Don't pace requests across runs (Crawl-delay is
                            still honored within a run). Pacing state lives
                            in $TRAWL_STATE_DIR, else
                            \${XDG_CACHE_HOME:-~/.cache}/trawl
      --ignore-cooldown    Fetch even if the origin is cooling down after a
                            429/503 (see exit code 4). Bypasses the refusal
                            only: robots.txt and pacing still apply, and a
                            new 429/503 is still recorded.
      --profile <dir>      Persistent browser profile dir (cookies/
                            localStorage survive across runs); also read from
                            $TRAWL_PROFILE_DIR. Populate one with "trawl login"
                            (which defaults this to ~/.trawl/profile, shared
                            across every origin, if you don't pass --profile/
                            $TRAWL_PROFILE_DIR there either). A plain fetch
                            stays isolated (no persistence) unless you pass
                            --profile/$TRAWL_PROFILE_DIR here too.
      --cookies <file>     Send the cookies from a HAR, a Netscape
                            cookies.txt or a copy-as-cURL command with this
                            one fetch; no profile or cookie store is written
                            (--har records them unless --har-redact). Filtered as cookies
                            import is (below: same defaults, and --domain,
                            --allow, --include-auth work here too). Prints
                            names/domains/expiry to stderr under -S, or when
                            any were dropped; never values. Not with
                            --profile/$TRAWL_PROFILE_DIR: use cookies import
                            to keep them. The robots.txt request carries
                            the ones that match it.
      --no-auth-check      Skip login-wall detection (see exit code 3 below)
  -S, --show-status        Print HTTP status + final URL to stderr
  -h, --help               Show this help
  -v, --version            Show version

Cookie import (trawl cookies import <file>):
                            Writes the file's cookies into --profile <dir>
                            (or $TRAWL_PROFILE_DIR; required, no default) for
                            a later "trawl <url> --profile <dir>". Prints
                            names, domains and expiry only, never values.
                            Session cookies are kept for 7 days. Expired
                            cookies are dropped, and so are sign-in
                            cookies (best-effort list, e.g. ${AUTH_COOKIES.names.slice(0, 3).join(", ")}:
                            AUTH_COOKIES in src/cookies.mjs). Cookies the
                            browser would refuse are skipped by name. If none
                            are left, nothing is written and the exit code
                            is 1.
                            Delete the source file afterwards.
                            These three filters also apply to --cookies:
      --domain <host>      Only cookies that would be sent to this host
      --allow <names>      Only these cookie names (comma-separated)
      --include-auth       Keep sign-in cookies too

Examples:
  trawl https://example.com/spa
  trawl https://example.com -f links
  trawl https://example.com -s '#main' -f html -o page.html
  trawl https://example.com -w '.results-loaded' --settle 500
  trawl https://example.com --click '#show-details' --then-wait '#details' \\
        -s '#details'
  trawl https://example.com --screenshot page.png --full-page
  trawl login https://example.com --profile ~/.trawl/example
  trawl https://example.com --profile ~/.trawl/example
  trawl cookies import cookies.txt --profile ~/.trawl/example \\
        --domain example.com
  trawl https://example.com/account --cookies cookies.txt \\
        --domain example.com

Cooldowns: when a page answers 429 or 503, trawl records a per-origin
cooldown in the same state directory — until its Retry-After (seconds or an
HTTP-date), else 60s doubling per consecutive failure up to 1h. Until then,
every trawl call to that origin is refused before any request is made. A 2xx
page, or 24h without a failure, resets the backoff.

Exit codes: 0 success, 22 page returned 4xx/5xx (as curl --fail), 3 page
appears to be behind a login wall (see --no-auth-check / trawl login),
4 origin is cooling down after a 429/503 (see --ignore-cooldown),
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
	"--min-interval",
	"--click",
	"--then-wait",
	"--cookies",
	"--domain",
	"--allow",
]);

// `--click` repeats, and each `--then-wait` belongs to the `--click` right
// before it, so both are folded into one ordered list as they are parsed
// rather than stored as a last-one-wins value.
function addClickArg(out, key, value) {
	out.clicks ??= [];
	if (key === "--click") {
		out.clicks.push({ selector: value });
		return;
	}
	const last = out.clicks.at(-1);
	if (!last) throw new Error("--then-wait must follow a --click");
	if (last.waitFor !== undefined) {
		throw new Error(
			`--then-wait given twice for --click "${last.selector}"; add another --click first`,
		);
	}
	last.waitFor = value;
}

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
			if (key === "--click" || key === "--then-wait") {
				addClickArg(out, key, arg.slice(eq + 1));
			} else {
				out[key] = arg.slice(eq + 1);
			}
			continue;
		}
		if (VALUED.has(arg)) {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			if (arg === "--click" || arg === "--then-wait") {
				addClickArg(out, arg, value);
			} else {
				out[arg] = value;
			}
			continue;
		}
		if (
			arg === "--help" ||
			arg === "--version" ||
			arg === "--show-status" ||
			arg === "--har-omit-content" ||
			arg === "--har-redact" ||
			arg === "--full-page" ||
			arg === "--ignore-robots" ||
			arg === "--no-readability" ||
			arg === "--no-auth-check" ||
			arg === "--no-pacing" ||
			arg === "--ignore-cooldown" ||
			arg === "--include-auth"
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

// `deps` (render, env, stderr) is a test seam, as in runLogin; the CLI entry
// point below never passes it.
export async function main(argv, deps = {}) {
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
	if (argv[0] === "cookies") {
		return await runCookies(argv.slice(1));
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
	const minIntervalMs =
		args["--min-interval"] === undefined
			? undefined
			: validateMinInterval(args["--min-interval"], "--min-interval");
	// Same up-front rule for the click list (empty selectors and the like).
	const click = args.clicks ? normalizeClickSteps(args.clicks) : undefined;
	// Playwright writes a zip archive for a .zip path; redaction rewrites JSON.
	if (args["--har-redact"] && !args["--har"]) throw new Error("--har-redact requires --har");
	if (args["--har-redact"] && /\.zip$/i.test(args["--har"])) {
		throw new Error("--har-redact does not support a .zip --har path; use a .har or .json file");
	}
	const profileDir = args["--profile"] ?? (deps.env ?? process.env).TRAWL_PROFILE_DIR;
	// And for --cookies: a bad file, or one with nothing usable left, fails
	// here, before robots.txt, pacing or any browser launch.
	const cookies = loadFetchCookies(args, {
		profileDir,
		stderr: deps.stderr ?? ((s) => process.stderr.write(s)),
	});

	const result = await (deps.render ?? render)(args._[0], {
		format,
		readability: !args["--no-readability"],
		selector: args["--selector"],
		waitForSelector: args["--wait-for"],
		...(click ? { click } : {}),
		settle: args["--settle"] ? toNumber(args["--settle"], "--settle") : 0,
		waitUntil: args["--wait-until"] ?? "networkidle",
		timeout: args["--timeout"]
			? toNumber(args["--timeout"], "--timeout")
			: 30000,
		userAgent: args["--user-agent"],
		executablePath: args["--executable-path"],
		har: args["--har"],
		harOmitContent: Boolean(args["--har-omit-content"]),
		harRedact: Boolean(args["--har-redact"]),
		screenshot: args["--screenshot"],
		fullPage: !!args["--full-page"],
		ignoreRobots: args["--ignore-robots"] === true,
		// Deliberately NOT defaulted the way `trawl login`'s profile dir is
		// (#24): a plain fetch stays ephemeral-by-default (render.mjs's own
		// documented isolation guarantee — nothing one run does is visible to
		// the next) unless the caller opts in with --profile/$TRAWL_PROFILE_DIR.
		// Pass --profile ~/.trawl/profile (the same default `trawl login`
		// used) to pick the saved session back up.
		profileDir,
		...(cookies ? { cookies } : {}),
		authCheck: !args["--no-auth-check"],
		pacing: !args["--no-pacing"],
		ignoreCooldown: args["--ignore-cooldown"] === true,
		...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
		// pacingStateDir is left to render(), which reads $TRAWL_STATE_DIR.
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

// The flags that only mean something next to --cookies on a fetch.
const COOKIE_FILTER_FLAGS = ["--domain", "--allow", "--include-auth"];

// `trawl <url> --cookies <file>`: the cookies for this one fetch, or
// `undefined` without --cookies. Same parsing and filtering as `trawl cookies
// import` (sign-in cookies dropped unless --include-auth, expired dropped,
// cookies the browser would refuse skipped by name), but nothing is written
// anywhere and session cookies keep `expires: -1`: the context is ephemeral,
// so there is no store for them to fall out of.
//
// No value is ever printed: the stderr summary (only under -S/--show-status,
// or when something was dropped or skipped) carries names, domains and
// expiry. Zero survivors throws, so main() exits 1 before any request.
function loadFetchCookies(args, { profileDir, stderr }) {
	const file = args["--cookies"];
	if (file === undefined) {
		const given = COOKIE_FILTER_FLAGS.find((f) => args[f] !== undefined);
		if (given) throw new Error(`${given} requires --cookies`);
		return undefined;
	}
	// --cookies promises to persist nothing, and a profile would keep them.
	if (profileDir) {
		const source = args["--profile"] !== undefined ? "--profile" : "$TRAWL_PROFILE_DIR";
		throw new Error(
			`--cookies cannot be combined with ${source}` +
				(source === "$TRAWL_PROFILE_DIR" ? " (unset it for this run)" : "") +
				'; to keep cookies in a profile use "trawl cookies import"',
		);
	}
	if (!file) throw new Error("--cookies expects a file, e.g. --cookies cookies.txt");
	const { allow, domain } = cookieFilterFlags(args);
	const { parsed } = readCookieSource(file);
	const { accepted, summary, dropped, why } = selectCookies(parsed, {
		domain,
		allow,
		includeAuth: args["--include-auth"] === true,
		now: Date.now(),
		verb: "use",
	});
	if (summary.kept.length === 0) {
		stderr(dropped.join(""));
		throw new Error(`no cookies left to use from ${file}: ${why()}`);
	}
	const har = args["--har"];
	if (args["--show-status"] || dropped.length > 0) {
		stderr(
			`Using ${plural(summary.kept.length, "cookie")} from ${file} for this fetch only${har ? "" : " (not saved)"}:\n` +
				summary.kept
					.map(
						(c) =>
							`  ${printable(c.name)}\t${printable(c.domain)}\t${
								c.expires === -1 ? "session" : describeExpiry(c.expires)
							}\n`,
					)
					.join("") +
				dropped.join(""),
		);
	}
	// The HAR is a full network trace: it keeps each request's Cookie header
	// and parsed cookies, values included (--har-omit-content drops bodies
	// only). Always said, -S or not; names the HAR file, never a value.
	// With --har-redact the values are scrubbed, so the warning would be false.
	if (har && !args["--har-redact"]) {
		stderr(
			`trawl: warning: --har records request cookies, values included; ${har} will contain the cookies from --cookies (add --har-redact to redact them)\n`,
		);
	}
	return accepted;
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
	// parseArgs knows the fetch-only cookie flags; login takes none of them.
	const fetchOnly = ["--cookies", ...COOKIE_FILTER_FLAGS].find((f) => args[f] !== undefined);
	if (fetchOnly) throw new Error(`Unknown option: ${fetchOnly}`);

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

// `trawl cookies <subcommand>`. Only `import` exists today.
export async function runCookies(argv, deps = {}) {
	if (argv[0] === "import") return await runCookiesImport(argv.slice(1), deps);
	if (argv[0] === "--help" || argv[0] === "-h") {
		(deps.stdout ?? ((s) => process.stdout.write(s)))(USAGE);
		return 0;
	}
	throw new Error(
		argv[0] === undefined
			? "trawl cookies requires a subcommand: trawl cookies import <file> --profile <dir>"
			: `Unknown cookies subcommand: ${argv[0]} (expected: import)`,
	);
}

// Its own small parser, not parseArgs: the two commands take different flag
// sets (a fetch's --domain/--allow/--include-auth only work next to
// --cookies, and --cookies is no import flag).
const COOKIES_IMPORT_VALUED = new Set(["--profile", "--domain", "--allow", "--executable-path"]);
const COOKIES_IMPORT_BOOLEAN = new Set(["--include-auth", "--help"]);

export function parseCookiesImportArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] === "-h" ? "--help" : argv[i];
		if (!arg.startsWith("-") || arg === "-") {
			out._.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const key = eq > -1 ? arg.slice(0, eq) : arg;
		if (COOKIES_IMPORT_VALUED.has(key)) {
			const value = eq > -1 ? arg.slice(eq + 1) : argv[++i];
			if (value === undefined) throw new Error(`${key} requires a value`);
			out[key] = value;
			continue;
		}
		if (eq < 0 && COOKIES_IMPORT_BOOLEAN.has(arg)) {
			out[arg] = true;
			continue;
		}
		throw new Error(`Unknown option for trawl cookies import: ${key}`);
	}
	return out;
}

// Browser family of a User-Agent string, for the "your cookies came from a
// different client" warning. Order matters: Edge and Opera also say Chrome,
// and Chrome also says Safari.
export function browserFamily(ua) {
	const s = String(ua ?? "");
	if (/\btrawl\//i.test(s)) return "trawl";
	if (/\bEdg(e|A|iOS)?\//.test(s)) return "Edge";
	if (/\b(OPR|Opera)\//.test(s)) return "Opera";
	if (/\b(Firefox|FxiOS)\//.test(s)) return "Firefox";
	if (/\b(Chrome|Chromium|CriOS)\//.test(s)) return "Chrome";
	if (/\bSafari\//.test(s)) return "Safari";
	if (/^curl\//i.test(s)) return "curl";
	return "another client";
}

// How long an imported session cookie (no expiry of its own) is kept. Import
// only: a one-off --cookies fetch persists nothing, so its session cookies
// stay session cookies.
const SESSION_COOKIE_TTL_S = 7 * 86400;

function cookieWriteError(err, profileDir) {
	const known = addCookiesFailure(err);
	return new Error(
		`could not write cookies to ${profileDir}; nothing was imported${known ? ` (${known})` : ""}`,
	);
}

// --domain / --allow, validated the same way for an import and a fetch.
function cookieFilterFlags(args) {
	let allow;
	if (args["--allow"] !== undefined) {
		allow = args["--allow"]
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean);
		if (allow.length === 0) throw new Error("--allow expects cookie names, e.g. --allow a,b");
	}
	const domain = args["--domain"];
	if (domain !== undefined && !domain.trim()) {
		throw new Error("--domain expects a host, e.g. --domain example.com");
	}
	return { allow, domain };
}

// Read and parse a cookie source; no message ever quotes the file.
// CookieParseError messages are fixed strings that never quote the input;
// anything else a parser throws might, so it is replaced, not passed on.
function readCookieSource(file, read = readFileSync) {
	let text;
	try {
		text = read(file, "utf8");
	} catch (err) {
		throw new Error(`cannot read cookie source ${file}${err?.code ? ` (${err.code})` : ""}`);
	}
	let parsed;
	try {
		parsed = parseCookies(text);
	} catch (err) {
		if (err instanceof CookieParseError) throw err;
		throw new Error(`could not parse cookie source ${file}`);
	}
	return { text, parsed };
}

// Filter a parsed list, then set aside what Chromium would refuse: one
// refused cookie fails the whole addCookies batch. `dropped` is the
// value-free report of what was removed; `verb` finishes its --include-auth
// hint ("import" / "use").
function selectCookies(parsed, { domain, allow, includeAuth, now, verb }) {
	const result = filterCookies(parsed, { domain, allow, includeAuth, now });
	const accepted = result.cookies.filter((c) => !browserWouldReject(c));
	const refused = result.cookies.filter((c) => browserWouldReject(c));
	const summary = summarize({ ...result, cookies: accepted });

	const dropped = [];
	if (summary.authDropped.count > 0) {
		dropped.push(
			`Dropped ${plural(summary.authDropped.count, "sign-in cookie")} ` +
				`(${summary.authDropped.names.map(printable).join(", ")}); ` +
				`pass --include-auth to ${verb} them.\n`,
		);
	}
	if (summary.expiredDropped > 0) {
		dropped.push(`Dropped ${plural(summary.expiredDropped, "expired cookie")}.\n`);
	}
	if (refused.length > 0) {
		dropped.push(
			`Skipped ${plural(refused.length, "cookie")} the browser would refuse ` +
				`(${refused.map((c) => (c.name === "" ? "(unnamed)" : printable(c.name))).join(", ")}).\n`,
		);
	}
	const why = () => whyNoneLeft(parsed.length, result, refused.length, { domain, allow, verb });
	return { accepted, summary, dropped, why };
}

// `trawl cookies import <file> --profile <dir>` — parse a cookie export,
// filter it, and write what survives into a persistent profile, so a later
// `trawl <url> --profile <dir>` presents it.
//
// Chromium's cookie store is encrypted and not something Node can write, so
// the write goes through Playwright: launch the profile, addCookies, close.
// Closing is what flushes the store to disk.
//
// Nothing touches the profile (not even mkdir) until the file has parsed and
// at least one cookie survives filtering; zero survivors is exit 1 with the
// summary, so a script cannot mistake "imported nothing" for success.
//
// No cookie value ever reaches stdout, stderr or an error message: output is
// built from summarize(), which carries names, domains and expiry only.
//
// `deps` mirrors runLogin: the browser lifecycle, filesystem and output are
// injectable so tests need no Chromium.
export async function runCookiesImport(argv, deps = {}) {
	const env = deps.env ?? process.env;
	const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
	const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
	const args = parseCookiesImportArgs(argv);

	if (args["--help"]) {
		stdout(USAGE);
		return 0;
	}
	const file = args._[0];
	if (!file) {
		throw new Error(
			"trawl cookies import requires a file, e.g. trawl cookies import cookies.txt --profile <dir>",
		);
	}
	if (args._.length > 1) {
		throw new Error(`Expected one file, got ${args._.length}`);
	}
	const profileDir = args["--profile"] ?? env.TRAWL_PROFILE_DIR;
	if (!profileDir) {
		throw new Error(
			"trawl cookies import requires --profile <dir> (or $TRAWL_PROFILE_DIR)",
		);
	}
	const { allow, domain } = cookieFilterFlags(args);

	const { text, parsed } = readCookieSource(file, deps.readFileSync);
	const now = deps.now ?? Date.now();
	// Set aside before the profile is touched, and reported by name.
	const { accepted, summary, dropped, why } = selectCookies(parsed, {
		domain,
		allow,
		includeAuth: args["--include-auth"] === true,
		now,
		verb: "import",
	});

	if (summary.kept.length === 0) {
		stderr(
			`${dropped.join("")}trawl: no cookies left to import from ${file}: ` +
				`${why()}; ${profileDir} was not touched.\n`,
		);
		return 1;
	}

	// Resolved before the profile is created, so a missing browser also
	// leaves no trace.
	const resolveExe =
		deps.resolveExecutablePath ??
		(await import("./browser.mjs")).resolveExecutablePath;
	const executablePath = resolveExe(args["--executable-path"]);

	// 0700 only on a directory trawl creates now; an existing one's mode is
	// the operator's choice and is left alone.
	const exists = deps.existsSync ?? existsSync;
	if (!exists(profileDir)) {
		(deps.mkdirSync ?? mkdirSync)(profileDir, { recursive: true, mode: 0o700 });
		// mkdir's mode is filtered by the umask; set it outright.
		(deps.chmodSync ?? chmodSync)(profileDir, 0o700);
	}

	// Chromium never writes session cookies to the profile's store, so a
	// session cookie imported as-is is gone by the next run. Every cookie a
	// HAR request header or a cURL line yields is a session cookie, so give
	// those a short, bounded lifetime instead.
	const sessionUntil = Math.floor(now / 1000) + SESSION_COOKIE_TTL_S;
	const payload = accepted.map((c) =>
		c.expires === -1 ? { ...c, expires: sessionUntil } : c,
	);
	const sessionCount = accepted.filter((c) => c.expires === -1).length;

	// As with addCookies below, the browser's own message is never shown.
	const launch = deps.launchPersistentContext ?? defaultLaunchPersistentContext;
	let context;
	try {
		context = await launch(profileDir, { executablePath, headless: true });
	} catch {
		throw new Error(
			`could not start the browser with profile ${profileDir}; nothing was imported ` +
				"(browser errors are not shown during a cookie import; is the profile open elsewhere?)",
		);
	}
	try {
		await context.addCookies(payload);
	} catch (err) {
		await context.close().catch(() => {});
		throw cookieWriteError(err, profileDir);
	}
	try {
		await context.close();
	} catch {
		throw new Error(
			`could not save cookies to ${profileDir}: the browser failed while closing, ` +
				"so the import may be incomplete",
		);
	}

	stdout(
		`Imported ${plural(summary.kept.length, "cookie")} into ${profileDir}:\n` +
			summary.kept
				.map(
					(c) =>
						`  ${printable(c.name)}\t${printable(c.domain)}\t${
							c.expires === -1
								? `session, kept until ${describeExpiry(sessionUntil)}`
								: describeExpiry(c.expires)
						}\n`,
				)
				.join("") +
			(sessionCount > 0
				? `${plural(sessionCount, "session cookie")} stored with a ` +
					`${SESSION_COOKIE_TTL_S / 86400}-day expiry: a profile only keeps ` +
					"cookies that have one.\n"
				: "") +
			dropped.join(""),
	);

	const agent = sourceUserAgent(text);
	if (agent) {
		const family = browserFamily(agent);
		if (family !== "trawl") {
			const { defaultUserAgent } = await import("./render.mjs");
			stderr(
				`trawl: warning: these cookies were captured by ${family}, but trawl ` +
					`identifies itself as "${await defaultUserAgent()}" unless you pass ` +
					"-A/--user-agent. Some sites bind cookies to the client that " +
					"received them and may reject them from trawl.\n",
			);
		}
	}
	stderr(
		`Reminder: ${file} still contains every cookie, including sign-in ` +
			"cookies. Delete it now that the import is done.\n",
	);
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
		// Likewise a cooldown refusal: wait until the stated time, don't retry.
		process.exitCode =
			err instanceof AuthWallError ? 3 : err instanceof CooldownError ? 4 : 1;
	}
}
