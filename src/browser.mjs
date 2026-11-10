// Locate a usable Chromium binary without depending on the full `playwright`
// package. We prefer the cached `chrome-headless-shell` that
// `playwright install chromium --only-shell` drops into the standard
// ms-playwright cache, then fall back to a full Chrome/Chromium install.

import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import path from "node:path";

// `env` lets tests inject platform/arch/home/LOCALAPPDATA; callers pass
// nothing and get the real host values.
export function cacheRoot(env = {}) {
	const home = env.home ?? homedir();
	switch (env.platform ?? platform()) {
		case "darwin":
			return path.join(home, "Library/Caches/ms-playwright");
		case "win32":
			return path.join(
				env.localAppData ?? process.env.LOCALAPPDATA ?? home,
				"ms-playwright",
			);
		default:
			return path.join(home, ".cache/ms-playwright");
	}
}

// Playwright's Chrome-for-Testing headless shell lives in
// `chrome-headless-shell-<archDir>`. Current names come first; older
// Playwright releases used `linux` for x64 Linux, kept for old caches.
function archDirCandidates(env = {}) {
	const a = env.arch ?? arch();
	switch (env.platform ?? platform()) {
		case "darwin":
			return a === "arm64" ? ["mac-arm64"] : ["mac-x64", "mac"];
		case "win32":
			return ["win64", "win32"];
		default:
			return a === "arm64" ? ["linux-arm64"] : ["linux64", "linux"];
	}
}

// Cached headless-shell builds are named `chromium_headless_shell-<rev>`;
// several can coexist, so take the highest revision.
export function findCachedShell(env = {}) {
	const root = cacheRoot(env);
	if (!existsSync(root)) return null;

	const bin =
		(env.platform ?? platform()) === "win32"
			? "chrome-headless-shell.exe"
			: "chrome-headless-shell";
	const builds = readdirSync(root)
		.filter((d) => d.startsWith("chromium_headless_shell-"))
		.sort((a, b) => {
			const rev = (s) => Number(s.split("-").pop()) || 0;
			return rev(b) - rev(a);
		});

	for (const build of builds) {
		for (const archDir of archDirCandidates(env)) {
			const candidate = path.join(
				root,
				build,
				`chrome-headless-shell-${archDir}`,
				bin,
			);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

const SYSTEM_CHROME = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	],
};

// `env.platform` / `env.exists` let tests fake the host; callers pass nothing.
export function findSystemChrome(env = {}) {
	const exists = env.exists ?? existsSync;
	return (SYSTEM_CHROME[env.platform ?? platform()] ?? []).find((p) => exists(p)) ?? null;
}

// Playwright's full (headed) Chromium lives in `chromium-<rev>/<dir>/<bin>`.
// Current layouts come first; older Playwright releases used the plain
// `chrome-mac` / `chrome-linux` / `chrome-win` dirs and a `Chromium.app`.
function fullChromiumCandidates(env = {}) {
	const a = env.arch ?? arch();
	const cft = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
	const legacy = "Chromium.app/Contents/MacOS/Chromium";
	switch (env.platform ?? platform()) {
		case "darwin": {
			const dirs = a === "arm64" ? ["chrome-mac-arm64", "chrome-mac"] : ["chrome-mac-x64", "chrome-mac"];
			return dirs.flatMap((d) => [path.join(d, cft), path.join(d, legacy)]);
		}
		case "win32":
			return ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"];
		default:
			return a === "arm64"
				? ["chrome-linux-arm64/chrome", "chrome-linux/chrome"]
				: ["chrome-linux64/chrome", "chrome-linux/chrome"];
	}
}

// The highest-revision cached full Chromium (`playwright install chromium`
// without --only-shell), or null.
export function findCachedFullChromium(env = {}) {
	const root = cacheRoot(env);
	if (!existsSync(root)) return null;
	const builds = readdirSync(root)
		.filter((d) => /^chromium-\d+$/.test(d))
		.sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
	for (const build of builds) {
		for (const rel of fullChromiumCandidates(env)) {
			const candidate = path.join(root, build, rel);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

// chrome-headless-shell cannot draw a window, whatever `headless` says.
export function isHeadlessShell(executablePath) {
	return /chrome-headless-shell/i.test(path.basename(executablePath));
}

export class NoHeadedBrowserError extends Error {
	constructor() {
		super(
			[
				"trawl login needs a browser that can open a window, and none was found.",
				"(The chrome-headless-shell that fetches use cannot show one.)",
				"",
				"Install Google Chrome, or Playwright's full Chromium:",
				"  npx --yes playwright install chromium",
				"",
				"Or point trawl at one:",
				"  trawl login --executable-path /path/to/chrome <url>",
			].join("\n"),
		);
		this.name = "NoHeadedBrowserError";
	}
}

// The browser for `trawl login`: never the headless shell. A system Chrome
// is preferred over Playwright's Chrome for Testing build because it is
// signed, so macOS Gatekeeper does not prompt on launch (#95). `explicit` is
// --executable-path, else $TRAWL_EXECUTABLE_PATH (the caller resolves both).
export function resolveHeadedExecutablePath(explicit, env = {}) {
	const exists = env.exists ?? existsSync;
	const chosen = explicit ?? findSystemChrome(env) ?? findCachedFullChromium(env);
	if (!chosen) throw new NoHeadedBrowserError();
	if (isHeadlessShell(chosen)) {
		throw new Error(
			`${chosen} is chrome-headless-shell, which cannot open a window for trawl login. ` +
				"Pass a full Chrome or Chromium with --executable-path.",
		);
	}
	if (!exists(chosen)) throw new Error(`Chromium binary not found at: ${chosen}`);
	return chosen;
}

export class NoBrowserError extends Error {
	constructor() {
		super(
			[
				`No Chromium binary found (looked in ${cacheRoot()} and the usual system paths).`,
				"",
				"Install one with:",
				"  npx --yes playwright install chromium --only-shell",
				"",
				"Or point trawl at an existing binary:",
				"  trawl --executable-path /path/to/chrome <url>",
				"  TRAWL_EXECUTABLE_PATH=/path/to/chrome trawl <url>",
			].join("\n"),
		);
		this.name = "NoBrowserError";
	}
}

// `trawl login` records the browser that wrote a profile, because a profile
// written by one Chromium version cannot always be opened by another: the
// cached headless shell (older) crashes on a profile a newer system Chrome
// wrote ("Failed to read prefs in Local State"). Fetches and cookie imports
// that use the profile then launch the same browser, headless.
export const PROFILE_BROWSER_FILE = ".trawl-browser";

// Holds only the browser path and when it was recorded, no user data; 0600
// like the rest of a profile's private state.
export function recordProfileBrowser(
	profileDir,
	executablePath,
	fs = { writeFileSync, chmodSync },
) {
	const marker = path.join(profileDir, PROFILE_BROWSER_FILE);
	fs.writeFileSync(
		marker,
		`${JSON.stringify({ executablePath, recordedAt: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
	// `mode` only applies when the file is created; tighten a pre-existing one.
	fs.chmodSync(marker, 0o600);
}

// Binary names a recorded browser may have: the Chrome/Chromium builds this
// module itself resolves. This guards against accidents (a stray or stale
// marker), not attackers: any executable can be named `chrome`, so a profile
// directory is trusted input, like $TRAWL_EXECUTABLE_PATH.
const CHROMIUM_BINARY =
	/^(google[ -]chrome([ -](stable|beta|dev|canary|for testing))?|chrom(e|ium)(-browser)?|chrome-headless-shell)(\.exe)?$/i;

// A marker holds one path and a timestamp; anything bigger is not ours.
const MAX_MARKER_BYTES = 4096;

// The real path trawl may launch for a recorded `p`, or null. `p` must be an
// absolute path without NUL or line breaks; symlinks are resolved first, and
// the *resolved* file must be an executable regular file named like a
// Chrome/Chromium binary, so a link named `chrome` to /bin/sh is refused.
// Callers launch the returned resolved path, never `p` itself.
export function launchableBrowser(
	p,
	fs = { realpathSync, statSync, accessSync },
	plat = platform(),
) {
	if (typeof p !== "string" || !path.isAbsolute(p) || /[\0\r\n]/.test(p)) return null;
	try {
		const real = fs.realpathSync(p);
		if (!CHROMIUM_BINARY.test(path.basename(real))) return null;
		if (!fs.statSync(real).isFile()) return null;
		// Windows has no execute bit; a regular file is as far as we can check.
		if (plat !== "win32") fs.accessSync(real, constants.X_OK);
		return real;
	} catch {
		return null;
	}
}

export function isLaunchableBrowser(p, fs, plat) {
	return launchableBrowser(p, fs, plat) !== null;
}

// The browser recorded for `profileDir` (resolved real path), or null when
// there is no usable marker: none, a directory, unreadable, oversized,
// malformed, or a path launchableBrowser refuses. Every null falls back to
// the default resolution unchanged.
export function profileBrowser(
	profileDir,
	fs = { readFileSync, statSync, realpathSync, accessSync },
) {
	if (!profileDir) return null;
	let executablePath;
	try {
		const marker = path.join(profileDir, PROFILE_BROWSER_FILE);
		const st = fs.statSync(marker);
		if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
		({ executablePath } = JSON.parse(fs.readFileSync(marker, "utf8")));
	} catch {
		return null;
	}
	return launchableBrowser(executablePath, fs);
}

// `profileDir`, when given, lets a profile's recorded browser (see
// PROFILE_BROWSER_FILE) win over the default headless shell. An explicit
// path or $TRAWL_EXECUTABLE_PATH still wins over both.
export function resolveExecutablePath(explicit, { profileDir } = {}) {
	const chosen =
		explicit ??
		process.env.TRAWL_EXECUTABLE_PATH ??
		profileBrowser(profileDir) ??
		findCachedShell() ??
		findSystemChrome();
	if (!chosen) throw new NoBrowserError();
	if (!existsSync(chosen)) {
		throw new Error(`Chromium binary not found at: ${chosen}`);
	}
	return chosen;
}
