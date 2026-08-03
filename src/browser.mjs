// Locate a usable Chromium binary without depending on the full `playwright`
// package. We prefer the cached `chrome-headless-shell` that
// `playwright install chromium --only-shell` drops into the standard
// ms-playwright cache, then fall back to a full Chrome/Chromium install.

import { existsSync, readdirSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import path from "node:path";

export function cacheRoot() {
	const home = homedir();
	switch (platform()) {
		case "darwin":
			return path.join(home, "Library/Caches/ms-playwright");
		case "win32":
			return path.join(process.env.LOCALAPPDATA ?? home, "ms-playwright");
		default:
			return path.join(home, ".cache/ms-playwright");
	}
}

function archDirCandidates() {
	const a = arch();
	switch (platform()) {
		case "darwin":
			return a === "arm64" ? ["mac-arm64"] : ["mac-x64", "mac"];
		case "win32":
			return ["win64", "win32"];
		default:
			return a === "arm64" ? ["linux-arm64"] : ["linux"];
	}
}

// Cached headless-shell builds are named `chromium_headless_shell-<rev>`;
// several can coexist, so take the highest revision.
function findCachedShell() {
	const root = cacheRoot();
	if (!existsSync(root)) return null;

	const bin =
		platform() === "win32"
			? "chrome-headless-shell.exe"
			: "chrome-headless-shell";
	const builds = readdirSync(root)
		.filter((d) => d.startsWith("chromium_headless_shell-"))
		.sort((a, b) => {
			const rev = (s) => Number(s.split("-").pop()) || 0;
			return rev(b) - rev(a);
		});

	for (const build of builds) {
		for (const archDir of archDirCandidates()) {
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

function findSystemChrome() {
	return (SYSTEM_CHROME[platform()] ?? []).find((p) => existsSync(p)) ?? null;
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

export function resolveExecutablePath(explicit) {
	const chosen =
		explicit ??
		process.env.TRAWL_EXECUTABLE_PATH ??
		findCachedShell() ??
		findSystemChrome();
	if (!chosen) throw new NoBrowserError();
	if (!existsSync(chosen)) {
		throw new Error(`Chromium binary not found at: ${chosen}`);
	}
	return chosen;
}
