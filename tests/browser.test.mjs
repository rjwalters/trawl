// Cache-lookup tests for src/browser.mjs. Each test builds a fake
// ms-playwright cache in a temp dir and injects platform/arch/home, so no
// browser is needed and these always run.

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	findCachedFullChromium,
	findCachedShell,
	isHeadlessShell,
	isLaunchableBrowser,
	launchableBrowser,
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

// An executable file named like a Chrome binary, inside the test's temp dir.
function fakeBrowser(dir, name = "chrome", mode = 0o755) {
	const file = path.join(dir, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, "");
	chmodSync(file, mode);
	return realpathSync(file);
}

function withoutEnvPath(t) {
	const saved = process.env.TRAWL_EXECUTABLE_PATH;
	delete process.env.TRAWL_EXECUTABLE_PATH;
	t.after(() => {
		if (saved === undefined) delete process.env.TRAWL_EXECUTABLE_PATH;
		else process.env.TRAWL_EXECUTABLE_PATH = saved;
	});
}

// Resolution exactly as on main: no profile involved. Null when the host has
// no browser at all, so comparisons still hold on a bare CI runner.
function mainResolution() {
	try {
		return resolveExecutablePath();
	} catch {
		return null;
	}
}
function resolutionFor(profileDir) {
	try {
		return resolveExecutablePath(undefined, { profileDir });
	} catch {
		return null;
	}
}

test("a recorded profile browser round-trips", (t) => {
	const profile = tempHome(t);
	const exe = fakeBrowser(profile);
	recordProfileBrowser(profile, exe);
	assert.equal(profileBrowser(profile), exe);
});

test("isLaunchableBrowser accepts real Chrome/Chromium binary names", (t) => {
	const dir = tempHome(t);
	for (const name of [
		"Google Chrome",
		"Google Chrome for Testing",
		"Chromium",
		"chrome",
		"chromium-browser",
		"google-chrome-stable",
		"chrome-headless-shell",
	]) {
		assert.equal(isLaunchableBrowser(fakeBrowser(dir, name)), true, name);
	}
});

test("profileBrowser ignores every unusable marker", (t) => {
	const profile = tempHome(t);
	const record = (value) =>
		writeFileSync(path.join(profile, PROFILE_BROWSER_FILE), JSON.stringify({ executablePath: value }));

	assert.equal(profileBrowser(undefined), null, "no profileDir");
	assert.equal(profileBrowser(profile), null, "no marker");

	writeFileSync(path.join(profile, PROFILE_BROWSER_FILE), "not json");
	assert.equal(profileBrowser(profile), null, "malformed JSON");

	record(42);
	assert.equal(profileBrowser(profile), null, "not a string");

	record(path.join(profile, "chrome"));
	assert.equal(profileBrowser(profile), null, "stale: binary gone");

	fakeBrowser(profile);
	record("chrome");
	assert.equal(profileBrowser(profile), null, "relative path");

	const dirNamedChrome = path.join(profile, "sub", "chromium");
	mkdirSync(dirNamedChrome, { recursive: true });
	record(dirNamedChrome);
	assert.equal(profileBrowser(profile), null, "a directory");

	record(fakeBrowser(profile, "evil-script"));
	assert.equal(profileBrowser(profile), null, "foreign binary name");

	if (process.platform !== "win32") {
		record(fakeBrowser(profile, "chromium", 0o644));
		assert.equal(profileBrowser(profile), null, "not executable");
	}
});

test("fetch resolution prefers a valid recorded browser over the headless shell", (t) => {
	withoutEnvPath(t);
	const profile = tempHome(t);
	const exe = fakeBrowser(profile);
	recordProfileBrowser(profile, exe);
	assert.equal(resolveExecutablePath(undefined, { profileDir: profile }), exe);
});

test("explicit path and TRAWL_EXECUTABLE_PATH both beat the recorded browser", (t) => {
	withoutEnvPath(t);
	const profile = tempHome(t);
	recordProfileBrowser(profile, fakeBrowser(profile));
	const explicit = fakeBrowser(profile, "chromium");
	assert.equal(resolveExecutablePath(explicit, { profileDir: profile }), explicit);

	const fromEnv = fakeBrowser(profile, "chromium-browser");
	process.env.TRAWL_EXECUTABLE_PATH = fromEnv;
	assert.equal(resolveExecutablePath(undefined, { profileDir: profile }), fromEnv);
});

test("without a usable marker, resolution is exactly main's", (t) => {
	withoutEnvPath(t);
	const profile = tempHome(t);
	const expected = mainResolution();
	assert.equal(resolutionFor(undefined), expected, "no profileDir");
	assert.equal(resolutionFor(profile), expected, "profile without marker");
	recordProfileBrowser(profile, fakeBrowser(profile, "evil-script"));
	assert.equal(resolutionFor(profile), expected, "invalid marker");
});

test("a symlink named like Chrome is judged by its target, and the target is launched", (t) => {
	if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
	const dir = tempHome(t);
	const shell = path.join(dir, "sh");
	writeFileSync(shell, "");
	chmodSync(shell, 0o755);
	const evil = path.join(dir, "chrome");
	symlinkSync(shell, evil);
	assert.equal(launchableBrowser(evil), null, "chrome -> sh is refused");

	const real = fakeBrowser(dir, "bin/chromium");
	const link = path.join(dir, "chromium-link");
	symlinkSync(real, link);
	assert.equal(launchableBrowser(link), real, "only the target's name counts, not the link's");
	const named = path.join(dir, "links", "chrome");
	mkdirSync(path.dirname(named), { recursive: true });
	symlinkSync(real, named);
	assert.equal(launchableBrowser(named), real, "returns the resolved target");
});

test("macOS app-bundle paths with spaces are accepted", (t) => {
	const dir = tempHome(t);
	for (const rel of [
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"Chromium.app/Contents/MacOS/Chromium",
	]) {
		const exe = fakeBrowser(dir, rel);
		assert.equal(launchableBrowser(exe), exe, rel);
	}
});

test("paths with NUL or line breaks are refused", (t) => {
	const dir = tempHome(t);
	const exe = fakeBrowser(dir);
	assert.equal(launchableBrowser(`${exe}\0`), null);
	assert.equal(launchableBrowser(`${exe}\n/bin/sh`), null);
	assert.equal(launchableBrowser(`${dir}/chrome\r`), null);
});

test("marker file oddities fall back silently", (t) => {
	const profile = tempHome(t);
	const exe = fakeBrowser(profile);
	const marker = path.join(profile, PROFILE_BROWSER_FILE);

	mkdirSync(marker);
	assert.equal(profileBrowser(profile), null, "a directory named .trawl-browser");
	rmSync(marker, { recursive: true });

	writeFileSync(marker, JSON.stringify({ executablePath: exe, pad: "x".repeat(5000) }));
	assert.equal(profileBrowser(profile), null, "oversized marker");

	writeFileSync(marker, JSON.stringify({ executablePath: [exe] }));
	assert.equal(profileBrowser(profile), null, "wrong type");

	writeFileSync(marker, "null");
	assert.equal(profileBrowser(profile), null, "JSON null");

	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		recordProfileBrowser(profile, exe);
		chmodSync(marker, 0o000);
		assert.equal(profileBrowser(profile), null, "unreadable marker");
		chmodSync(marker, 0o600);
	}
});

test("the marker holds only the path and a timestamp, mode 0600", (t) => {
	const profile = tempHome(t);
	const exe = fakeBrowser(profile);
	const marker = path.join(profile, PROFILE_BROWSER_FILE);
	writeFileSync(marker, "{}");
	chmodSync(marker, 0o644);
	recordProfileBrowser(profile, exe);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(marker, "utf8"))).sort(), ["executablePath", "recordedAt"]);
	if (process.platform !== "win32") assert.equal(statSync(marker).mode & 0o777, 0o600);
});

test("the headless-shell rejection names $TRAWL_EXECUTABLE_PATH only when it is the source", () => {
	const shell = "/x/chrome-headless-shell-mac-arm64/chrome-headless-shell";
	const exists = () => true;
	assert.throws(
		() => resolveHeadedExecutablePath(shell, { exists, fromEnv: true }),
		/--executable-path, or unset or change \$TRAWL_EXECUTABLE_PATH, which points at it\./,
	);
	assert.throws(
		() => resolveHeadedExecutablePath(shell, { exists }),
		(err) => /--executable-path\.$/.test(err.message) && !/TRAWL_EXECUTABLE_PATH/.test(err.message),
	);
});

test("a marker not privately owned falls back silently to main's resolution", (t) => {
	if (process.platform === "win32") return t.skip("no POSIX ownership on Windows");
	withoutEnvPath(t);
	const profile = tempHome(t);
	chmodSync(profile, 0o700);
	const exe = fakeBrowser(profile);
	recordProfileBrowser(profile, exe);
	const marker = path.join(profile, PROFILE_BROWSER_FILE);
	const expected = mainResolution();
	assert.equal(profileBrowser(profile), exe, "private marker in a private dir is used");

	chmodSync(marker, 0o620);
	assert.equal(profileBrowser(profile), null, "group-writable marker");
	assert.equal(resolutionFor(profile), expected);
	chmodSync(marker, 0o602);
	assert.equal(profileBrowser(profile), null, "world-writable marker");
	chmodSync(marker, 0o600);

	chmodSync(profile, 0o770);
	assert.equal(profileBrowser(profile), null, "0600 marker in a group-writable profile dir");
	assert.equal(resolutionFor(profile), expected);
	chmodSync(profile, 0o700);

	const uid = process.getuid();
	assert.equal(profileBrowser(profile, undefined, { uid: uid + 1 }), null, "owned by another user");
	assert.equal(profileBrowser(profile, undefined, { uid: uid + 1, plat: "win32" }), exe, "no ownership check on win32");
});
