// Cache-lookup tests for src/browser.mjs. Each test builds a fake
// ms-playwright cache in a temp dir and injects platform/arch/home, so no
// browser is needed and these always run.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findCachedShell } from "../src/browser.mjs";

function tempHome(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "trawl-browser-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// Create `<root>/chromium_headless_shell-<rev>/chrome-headless-shell-<archDir>/<bin>`
// and return the binary's path.
function plantShell(root, rev, archDir, bin = "chrome-headless-shell") {
	const dir = path.join(
		root,
		`chromium_headless_shell-${rev}`,
		`chrome-headless-shell-${archDir}`,
	);
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, bin);
	writeFileSync(file, "");
	return file;
}

const linuxRoot = (home) => path.join(home, ".cache/ms-playwright");

test("linux x64 resolves Playwright's current linux64 layout", (t) => {
	const home = tempHome(t);
	const bin = plantShell(linuxRoot(home), 1187, "linux64");
	assert.equal(findCachedShell({ platform: "linux", arch: "x64", home }), bin);
});

test("linux x64 still resolves the legacy linux layout", (t) => {
	const home = tempHome(t);
	const bin = plantShell(linuxRoot(home), 1100, "linux");
	assert.equal(findCachedShell({ platform: "linux", arch: "x64", home }), bin);
});

test("linux arm64 resolves the linux-arm64 layout", (t) => {
	const home = tempHome(t);
	const bin = plantShell(linuxRoot(home), 1187, "linux-arm64");
	assert.equal(
		findCachedShell({ platform: "linux", arch: "arm64", home }),
		bin,
	);
});

test("darwin arm64 resolves the mac-arm64 layout", (t) => {
	const home = tempHome(t);
	const root = path.join(home, "Library/Caches/ms-playwright");
	const bin = plantShell(root, 1187, "mac-arm64");
	assert.equal(
		findCachedShell({ platform: "darwin", arch: "arm64", home }),
		bin,
	);
});

test("win32 x64 resolves the win64 layout under LOCALAPPDATA", (t) => {
	const localAppData = tempHome(t);
	const root = path.join(localAppData, "ms-playwright");
	const bin = plantShell(root, 1187, "win64", "chrome-headless-shell.exe");
	assert.equal(
		findCachedShell({
			platform: "win32",
			arch: "x64",
			home: "/nonexistent",
			localAppData,
		}),
		bin,
	);
});

test("picks the highest revision numerically, not lexicographically", (t) => {
	const home = tempHome(t);
	const root = linuxRoot(home);
	plantShell(root, 999, "linux64");
	plantShell(root, 1099, "linux64");
	const newest = plantShell(root, 1100, "linux64");
	assert.equal(
		findCachedShell({ platform: "linux", arch: "x64", home }),
		newest,
	);
});

test("highest revision wins across linux64 and legacy linux layouts", (t) => {
	const home = tempHome(t);
	const root = linuxRoot(home);
	plantShell(root, 1099, "linux64");
	const newest = plantShell(root, 1100, "linux");
	assert.equal(
		findCachedShell({ platform: "linux", arch: "x64", home }),
		newest,
	);
});

test("returns null when the cache root is missing", (t) => {
	const home = tempHome(t);
	assert.equal(findCachedShell({ platform: "linux", arch: "x64", home }), null);
	assert.equal(
		findCachedShell({ platform: "darwin", arch: "arm64", home }),
		null,
	);
});
