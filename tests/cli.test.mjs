import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutablePath } from "../src/browser.mjs";
import {
	defaultProfileDir,
	isMainModule,
	main,
	parseArgs,
	parseViewport,
	runLogin,
} from "../src/cli.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const opts = { skip: haveBrowser ? false : "no Chromium binary installed" };

test("collects a bare url as a positional", () => {
	assert.deepEqual(parseArgs(["https://example.com"])._, [
		"https://example.com",
	]);
});

test("expands short aliases", () => {
	const args = parseArgs(["https://example.com", "-f", "html", "-s", "#main"]);
	assert.equal(args["--format"], "html");
	assert.equal(args["--selector"], "#main");
});

test("accepts --flag=value", () => {
	assert.equal(parseArgs(["--format=links", "u"])["--format"], "links");
});

test("treats boolean flags as booleans", () => {
	assert.equal(parseArgs(["-S", "u"])["--show-status"], true);
});

test("treats --ignore-robots as a boolean", () => {
	assert.equal(parseArgs(["--ignore-robots", "u"])["--ignore-robots"], true);
	assert.equal(parseArgs(["u"])["--ignore-robots"], undefined);
});

test("keeps the url positional even after valued flags", () => {
	const args = parseArgs(["--timeout", "5000", "https://example.com"]);
	assert.deepEqual(args._, ["https://example.com"]);
	assert.equal(args["--timeout"], "5000");
});

test("rejects an unknown option", () => {
	assert.throws(() => parseArgs(["--nope", "u"]), /Unknown option: --nope/);
});

test("rejects a valued flag with no value", () => {
	assert.throws(
		() => parseArgs(["https://example.com", "--format"]),
		/--format requires a value/,
	);
});

test("takes a file path for --har", () => {
	const args = parseArgs(["https://example.com", "--har", "out.har"]);
	assert.equal(args["--har"], "out.har");
	assert.deepEqual(args._, ["https://example.com"]);
});

test("treats --har-omit-content as a boolean", () => {
	const args = parseArgs(["https://example.com", "--har-omit-content"]);
	assert.equal(args["--har-omit-content"], true);
	assert.deepEqual(args._, ["https://example.com"]);
});

test("does not mistake a negative-looking value for a flag", () => {
	assert.equal(parseArgs(["-A", "-weird-ua", "u"])["--user-agent"], "-weird-ua");
});

test("takes a path for --screenshot", () => {
	assert.equal(
		parseArgs(["u", "--screenshot", "out.png"])["--screenshot"],
		"out.png",
	);
});

test("treats --full-page as a boolean", () => {
	assert.equal(parseArgs(["u", "--full-page"])["--full-page"], true);
});

test("takes a WxH value for --viewport", () => {
	assert.equal(
		parseArgs(["u", "--viewport", "1280x800"])["--viewport"],
		"1280x800",
	);
});

test("parses a well-formed --viewport into width/height", () => {
	assert.deepEqual(parseViewport("1280x800"), { width: 1280, height: 800 });
});

for (const bad of ["1280", "1280x", "x800", "1280X800", "1280x800px", ""]) {
	test(`rejects malformed --viewport ${JSON.stringify(bad)}`, () => {
		assert.throws(
			() => parseViewport(bad),
			new Error(
				`--viewport expects <width>x<height>, e.g. 1280x800, got "${bad}"`,
			),
		);
	});
}

for (const bad of ["0x600", "1280x0", "0x0"]) {
	test(`rejects a non-positive --viewport dimension ${bad}`, () => {
		assert.throws(
			() => parseViewport(bad),
			new Error(
				`--viewport expects <width>x<height>, e.g. 1280x800, got "${bad}"`,
			),
		);
	});
}

test("treats --no-readability as a boolean flag", () => {
	const args = parseArgs(["u", "-f", "md", "--no-readability"]);
	assert.equal(args["--no-readability"], true);
	assert.deepEqual(args._, ["u"]);
});

test("takes a directory for --profile", () => {
	const args = parseArgs(["u", "--profile", "/tmp/my-profile"]);
	assert.equal(args["--profile"], "/tmp/my-profile");
	assert.deepEqual(args._, ["u"]);
});

test("treats --no-auth-check as a boolean flag", () => {
	const args = parseArgs(["u", "--no-auth-check"]);
	assert.equal(args["--no-auth-check"], true);
	assert.equal(parseArgs(["u"])["--no-auth-check"], undefined);
});

// --- `trawl login` (#22) ---
//
// The browser lifecycle is injected via `deps`, so these exercise the real
// argument-validation and orchestration logic without launching a (headed)
// Chromium — which this environment usually can't do anyway (no display, and
// the cached `chrome-headless-shell` binary can't run headed at all).

test("login requires a URL", async () => {
	await assert.rejects(
		() => runLogin([], { env: { TRAWL_PROFILE_DIR: "/tmp/whatever" } }),
		/trawl login requires a URL/,
	);
});

test("login rejects more than one positional", async () => {
	await assert.rejects(
		() => runLogin(["https://a.example", "https://b.example"], { env: {} }),
		/Expected one URL, got 2/,
	);
});

// #24: `trawl login` used to require --profile/TRAWL_PROFILE_DIR and throw
// otherwise, forcing the operator to invent a path before they understood
// what it was for. It now defaults to a fixed directory under homedir() —
// this is an intentional behavior change from the old "throws" contract.
test("login with no --profile/TRAWL_PROFILE_DIR defaults to defaultProfileDir()", async () => {
	const mkdirCalls = [];
	const stderrLines = [];
	const context = {
		newPage: async () => ({ goto: async () => {} }),
		closed: false,
		close: async function () {
			this.closed = true;
		},
	};
	const deps = {
		env: {},
		mkdirSync: (dir, options) => mkdirCalls.push([dir, options]),
		launchPersistentContext: async (dir, launchOptions) => {
			mkdirCalls.push(["launch", dir, launchOptions]);
			return context;
		},
		waitForUser: async () => {},
		stderr: (s) => stderrLines.push(s),
	};

	const code = await runLogin(["https://example.com"], deps);

	assert.equal(code, 0);
	// The mkdirSync call (not the launchPersistentContext call) proves which
	// directory was actually used — mirrors the TRAWL_PROFILE_DIR-fallback
	// assertion pattern below.
	const mkdirCall = mkdirCalls.find((c) => c[0] !== "launch");
	assert.equal(mkdirCall[0], defaultProfileDir());
	const stderrText = stderrLines.join("");
	assert.ok(
		stderrText.includes(`session to:\n  ${defaultProfileDir()}`),
		`expected stderr to mention ${defaultProfileDir()}, got: ${stderrText}`,
	);
	assert.match(stderrText, /no --profile\/TRAWL_PROFILE_DIR given/);
});

function fakeLoginDeps({ profileDir } = {}) {
	const mkdirCalls = [];
	const stderrLines = [];
	const page = { goto: async () => {} };
	const gotoCalls = [];
	page.goto = async (url) => gotoCalls.push(url);
	const context = {
		newPage: async () => page,
		closed: false,
		close: async function () {
			this.closed = true;
		},
	};
	return {
		deps: {
			env: profileDir ? {} : { TRAWL_PROFILE_DIR: "/tmp/env-profile" },
			mkdirSync: (dir, options) => mkdirCalls.push([dir, options]),
			launchPersistentContext: async (dir, launchOptions) => {
				mkdirCalls.push(["launch", dir, launchOptions]);
				return context;
			},
			waitForUser: async () => {},
			stderr: (s) => stderrLines.push(s),
		},
		mkdirCalls,
		stderrLines,
		gotoCalls,
		context,
	};
}

test("login navigates to the given origin and closes the context on completion", async () => {
	const { deps, gotoCalls, context, stderrLines } = fakeLoginDeps({
		profileDir: "/tmp/explicit-profile",
	});

	const code = await runLogin(
		["https://example.com", "--profile", "/tmp/explicit-profile"],
		deps,
	);

	assert.equal(code, 0);
	assert.deepEqual(gotoCalls, ["https://example.com"]);
	assert.equal(context.closed, true);
	assert.match(stderrLines.join(""), /A browser window has opened at https:\/\/example\.com/);
	assert.match(stderrLines.join(""), /Session saved to \/tmp\/explicit-profile/);
});

test("login falls back to TRAWL_PROFILE_DIR when --profile is not given", async () => {
	const { deps, mkdirCalls } = fakeLoginDeps();

	await runLogin(["https://example.com"], deps);

	// The mkdirSync call (not the launchPersistentContext call) proves which
	// directory was actually used.
	const mkdirCall = mkdirCalls.find((c) => c[0] !== "launch");
	assert.equal(mkdirCall[0], "/tmp/env-profile");
});

test("login tolerates the user already having closed the browser window", async () => {
	const { deps, context } = fakeLoginDeps({ profileDir: "/tmp/explicit-profile" });
	// Simulate the window already being gone by the time we try to close it.
	context.close = async () => {
		throw new Error("Target page, context or browser has been closed");
	};

	const code = await runLogin(
		["https://example.com", "--profile", "/tmp/explicit-profile"],
		deps,
	);
	assert.equal(code, 0);
});

test("main() dispatches `trawl login <origin>` to runLogin", async () => {
	// Not a real render: proves `main()` special-cases "login" the same way it
	// special-cases "mcp", by observing runLogin's own validation error rather
	// than trying to fetch a URL.
	await assert.rejects(
		() => main(["login"]),
		/trawl login requires a URL/,
	);
});

// Entry-point detection (#14).
//
// npm installs `bin` as a symlink and the shebang re-execs as `node <symlink>`,
// so process.argv[1] is the symlink, not this file. The guard used to match on
// the "cli.mjs" suffix, which is false for every global install — `trawl
// --help` printed nothing and exited 0. These tests run the CLI THROUGH A
// SYMLINK, which is the shape nothing else in the suite covers: every other
// test imports the module or spawns `node src/cli.mjs`, and both of those pass
// even with the bug present.

const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function runCli(entry, args = []) {
	return new Promise((resolve) => {
		execFile(process.execPath, [entry, ...args], (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("isMainModule() resolves a symlinked entry back to this module", () => {
	const dir = mkdtempSync(join(tmpdir(), "trawl-bin-"));
	try {
		const link = join(dir, "trawl");
		symlinkSync(CLI_PATH, link);
		// The exact comparison the shebang path makes for a global install.
		assert.equal(isMainModule(link, pathToFileURL(CLI_PATH).href), true);
		// An unrelated entry is still correctly "not main".
		assert.equal(isMainModule(dir, pathToFileURL(CLI_PATH).href), false);
		// A missing argv[1] must not throw.
		assert.equal(isMainModule(undefined, pathToFileURL(CLI_PATH).href), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runs when invoked through a bin symlink, not just by real path", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trawl-bin-"));
	try {
		const link = join(dir, "trawl");
		symlinkSync(CLI_PATH, link);

		const viaLink = await runCli(link, ["--help"]);
		// The bug was silence-with-exit-0, so assert on real output, not the code.
		assert.ok(
			viaLink.stdout.length > 0,
			"CLI produced no stdout when run through a symlink",
		);
		assert.match(viaLink.stdout, /curl for the JavaScript web/);

		// And it behaves identically to invoking the real path.
		const viaReal = await runCli(CLI_PATH, ["--help"]);
		assert.equal(viaLink.stdout, viaReal.stdout);
		assert.equal(viaLink.code, viaReal.code);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a symlinked CLI reports the same version as the real path", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trawl-bin-"));
	try {
		const link = join(dir, "trawl");
		symlinkSync(CLI_PATH, link);
		const { stdout, code } = await runCli(link, ["--version"]);
		assert.equal(code, 0);
		assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- auth-wall exit code, end-to-end through the real CLI process (#22) ---

function fixtureUrl(html, name) {
	const dir = mkdtempSync(join(tmpdir(), "trawl-cli-fixture-"));
	const file = join(dir, name);
	writeFileSync(file, html);
	return pathToFileURL(file).href;
}

test("exits 3 and reports a login wall for a tiny sign-in page", opts, async () => {
	const url = fixtureUrl(
		`<!doctype html><title>Gated</title><body>Sign in</body>`,
		"wall.html",
	);
	const { code, stdout, stderr } = await runCli(CLI_PATH, [url]);
	assert.equal(code, 3);
	assert.equal(stdout, "");
	assert.match(stderr, /login wall/);
	assert.match(stderr, /"sign in"/);
});

test("--no-auth-check exits 0 for the same login-wall page", opts, async () => {
	const url = fixtureUrl(
		`<!doctype html><title>Gated</title><body>Sign in</body>`,
		"wall2.html",
	);
	const { code, stdout } = await runCli(CLI_PATH, [url, "--no-auth-check"]);
	assert.equal(code, 0);
	assert.match(stdout, /Sign in/);
});
