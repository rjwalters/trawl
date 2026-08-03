import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule, parseArgs, parseViewport } from "../src/cli.mjs";

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
