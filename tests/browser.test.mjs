// Cache-lookup tests for src/browser.mjs. Each test builds a fake
// ms-playwright cache in a temp dir and injects platform/arch/home, so no
// browser is needed and these always run.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	findCachedFullChromium,
	findCachedShell,
	isHeadlessShell,
	NoHeadedBrowserError,
	PROFILE_BROWSER_FILE,
	profileBrowser,
	recordProfileBrowser,
	resolveExecutablePath,
	resolveHeadedExecutablePath,
} from "../src/browser.mjs";

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

// --- headed resolution for `trawl login` (#95) -------------------------------

// Create `<root>/chromium-<rev>/<rel>` and return its path.
function plantFull(root, rev, rel) {
	const file = path.join(root, `chromium-${rev}`, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, "");
	return file;
}

const macRoot = (home) => path.join(home, "Library/Caches/ms-playwright");
const CFT = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
// Only files under the fake home "exist", so a real system Chrome on the
// test host never leaks into these assertions.
const onlyUnder = (home) => (p) => p.startsWith(home) && existsSync(p);

test("darwin arm64 finds Playwright's Chrome for Testing full build", (t) => {
	const home = tempHome(t);
	const bin = plantFull(macRoot(home), 1200, `chrome-mac-arm64/${CFT}`);
	assert.equal(findCachedFullChromium({ platform: "darwin", arch: "arm64", home }), bin);
});

test("darwin finds the legacy chrome-mac/Chromium.app layout", (t) => {
	const home = tempHome(t);
	const bin = plantFull(macRoot(home), 1100, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
	assert.equal(findCachedFullChromium({ platform: "darwin", arch: "arm64", home }), bin);
});

test("linux x64 finds chrome-linux64/chrome, highest revision first", (t) => {
	const home = tempHome(t);
	plantFull(linuxRoot(home), 900, "chrome-linux64/chrome");
	const bin = plantFull(linuxRoot(home), 1200, "chrome-linux64/chrome");
	assert.equal(findCachedFullChromium({ platform: "linux", arch: "x64", home }), bin);
});

test("full-Chromium lookup ignores headless-shell builds", (t) => {
	const home = tempHome(t);
	plantShell(linuxRoot(home), 1200, "linux64");
	assert.equal(findCachedFullChromium({ platform: "linux", arch: "x64", home }), null);
});

test("isHeadlessShell recognises the shell binary only", () => {
	assert.equal(isHeadlessShell("/x/chrome-headless-shell-linux64/chrome-headless-shell"), true);
	assert.equal(isHeadlessShell("C:\\x\\chrome-headless-shell.exe"), true);
	assert.equal(isHeadlessShell("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), false);
});

test("headed resolution never returns the headless shell, even when it is the only browser", (t) => {
	const home = tempHome(t);
	plantShell(linuxRoot(home), 1200, "linux64");
	assert.throws(
		() => resolveHeadedExecutablePath(undefined, { platform: "linux", arch: "x64", home, exists: onlyUnder(home) }),
		NoHeadedBrowserError,
	);
});

test("headed resolution rejects an explicit headless-shell path", (t) => {
	const home = tempHome(t);
	const shell = plantShell(linuxRoot(home), 1200, "linux64");
	assert.throws(
		() => resolveHeadedExecutablePath(shell, { platform: "linux", arch: "x64", home, exists: onlyUnder(home) }),
		/cannot open a window/,
	);
});

test("headed resolution prefers a system Chrome over the Playwright cache", (t) => {
	const home = tempHome(t);
	plantFull(macRoot(home), 1200, `chrome-mac-arm64/${CFT}`);
	const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const exists = (p) => p === system || onlyUnder(home)(p);
	assert.equal(
		resolveHeadedExecutablePath(undefined, { platform: "darwin", arch: "arm64", home, exists }),
		system,
	);
});

test("headed resolution falls back to the cached full Chromium", (t) => {
	const home = tempHome(t);
	const bin = plantFull(macRoot(home), 1200, `chrome-mac-arm64/${CFT}`);
	assert.equal(
		resolveHeadedExecutablePath(undefined, { platform: "darwin", arch: "arm64", home, exists: onlyUnder(home) }),
		bin,
	);
});

// --- profile browser marker (#95: version skew between login and fetch) -----

test("a recorded profile browser round-trips", (t) => {
	const profile = tempHome(t);
	const exe = path.join(profile, "fake-chrome");
	writeFileSync(exe, "");
	recordProfileBrowser(profile, exe);
	assert.equal(profileBrowser(profile), exe);
});

test("profileBrowser is null with no marker, a bad marker, or a vanished binary", (t) => {
	const profile = tempHome(t);
	assert.equal(profileBrowser(profile), null);
	assert.equal(profileBrowser(undefined), null);
	writeFileSync(path.join(profile, PROFILE_BROWSER_FILE), "not json");
	assert.equal(profileBrowser(profile), null);
	recordProfileBrowser(profile, path.join(profile, "gone"));
	assert.equal(profileBrowser(profile), null);
});

test("fetch resolution uses the profile's recorded browser before the headless shell", (t) => {
	const profile = tempHome(t);
	const exe = path.join(profile, "fake-chrome");
	writeFileSync(exe, "");
	recordProfileBrowser(profile, exe);
	const saved = process.env.TRAWL_EXECUTABLE_PATH;
	delete process.env.TRAWL_EXECUTABLE_PATH;
	t.after(() => {
		if (saved !== undefined) process.env.TRAWL_EXECUTABLE_PATH = saved;
	});
	assert.equal(resolveExecutablePath(undefined, { profileDir: profile }), exe);
	// An explicit path still wins.
	const other = path.join(profile, "other-chrome");
	writeFileSync(other, "");
	assert.equal(resolveExecutablePath(other, { profileDir: profile }), other);
});
