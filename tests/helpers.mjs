// Shared scaffolding for the tests in this directory.
//
// `npm test` globs `tests/*.test.mjs`, so this module is imported rather than
// collected as a test file — the same arrangement as `tests/selfsigned.mjs`.
//
// Helpers that used to be copy-pasted per test file live here instead, so the
// rules CLAUDE.md calls load-bearing (the browser skip guard, and running the
// CLI through its bin symlink) are each stated once. Where the old copies had
// drifted, the stronger variant won: `runBin` always gets both a timeout and
// a per-call env merge, and `assertNoValue` always checks every encoding.
//
// Anything that writes to the filesystem takes its mkdtemp prefix from the
// caller, so temp-dir names stay per-test-file and remain debuggable.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutablePath } from "../src/browser.mjs";

// --- the browser skip guard -------------------------------------------------

// Tests that need a browser skip cleanly when none is installed, so
// `npm test` is always runnable (CLAUDE.md: "a green local run does not
// always mean the render path was exercised"). CI installs Chromium to keep
// them meaningful.
let detected = true;
try {
	resolveExecutablePath();
} catch {
	detected = false;
}

/** True when a Chromium binary resolves on this host. */
export const haveBrowser = detected;

/** `node --test` options object: pass as a test's second argument. */
export const browserOpts = {
	skip: haveBrowser ? false : "no Chromium binary installed",
};

// --- temp files and fixtures ------------------------------------------------

/** A fresh temp directory named after `prefix`. */
export function tempDir(prefix) {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A path to `name` inside a fresh temp directory. Nothing is written. */
export function tmpFile(name, prefix) {
	return path.join(tempDir(prefix), name);
}

/** Writes `html` into a fresh temp directory and returns its file:// URL. */
export function fixtureUrl(html, name, prefix) {
	const file = tmpFile(name, prefix);
	writeFileSync(file, html);
	return pathToFileURL(file).href;
}

/** Writes `text` to `dir/name` and returns the path. */
export function writeSource(dir, name, text) {
	const file = path.join(dir, name);
	writeFileSync(file, text);
	return file;
}

/** A Netscape cookie file body from rows of tab-separated fields. */
export function netscape(lines) {
	return `# Netscape HTTP Cookie File\n${lines.map((l) => l.join("\t")).join("\n")}\n`;
}

// --- running the CLI the way a PATH install does ----------------------------

export const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/**
 * A `trawl` symlink to src/cli.mjs in a temp directory of its own.
 *
 * CLAUDE.md makes this path load-bearing: a bin symlink plus its exec bit is
 * how npm installs the `bin`, and is the shape that hid two shipped bugs that
 * `node src/cli.mjs` could not see.
 */
export function binLink(prefix = "trawl-bin-") {
	const dir = tempDir(prefix);
	const link = path.join(dir, "trawl");
	symlinkSync(CLI_PATH, link);
	return { dir, link, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Executes the bin symlink *directly* — shebang plus exec bit, the way a PATH
 * lookup runs an npm-installed `trawl` — rather than `node src/cli.mjs`.
 *
 * `env` is merged over `process.env`, and the 60s timeout means a hung
 * `trawl` fails this one test instead of hanging the whole `node --test` run.
 */
export function runBin(link, args, env) {
	return new Promise((resolve) => {
		execFile(
			link,
			args,
			{ env: { ...process.env, ...env }, timeout: 60000 },
			(err, stdout, stderr) => {
				resolve({ code: err?.code ?? 0, stdout, stderr });
			},
		);
	});
}

/** `binLink()` + `runBin()` + cleanup, for callers that need no other use of the link. */
export async function runViaBin(args, env, prefix) {
	const { link, cleanup } = binLink(prefix);
	try {
		return await runBin(link, args, env);
	} finally {
		cleanup();
	}
}

// --- credential-leak assertions ---------------------------------------------

// A value with every character JSON or URL encoding rewrites, so an echo in
// any encoding differs from the raw value and a plain `includes` would miss it.
export const AWKWARD = 'aw"KW\\rd/V4l+u3=Zq-77Xk';

/**
 * Asserts no haystack carries `value` in any form an error could encode it
 * in — raw, URI-encoded, JSON, `escape()`d, its first 8 characters, or any
 * 6+ character run of it.
 *
 * This exists to prove credential values never leak into error text, so the
 * list is the union of every variant the per-file copies used to check.
 */
export function assertNoValue(haystacks, value = AWKWARD) {
	const forms = [
		value,
		encodeURIComponent(value),
		JSON.stringify(value),
		escape(value),
		value.slice(0, 8),
	];
	for (let i = 0; i + 6 <= value.length; i++) forms.push(value.slice(i, i + 6));
	for (const h of haystacks) {
		for (const f of forms) {
			assert.ok(!h.includes(f), `leaked ${JSON.stringify(f)} in ${JSON.stringify(h)}`);
		}
	}
}

/** Everywhere an error can carry text, as strings. */
export function errorText(err) {
	return [String(err?.message), String(err?.stack), String(err?.cause ?? ""), JSON.stringify(err)];
}

// --- observing cross-run pacing ---------------------------------------------

// Spacing is asserted on recorded starts rather than on arrival gaps: a fresh
// Node process's first fetch() takes 100-200ms (more under load) to reach the
// server, so arrival gaps between a cold and a warm request can be shorter
// than the interval the gate correctly enforced. Any tolerance on arrival
// gaps would be a guess about that latency.
//
// Instead the server snapshots the state file as each request arrives. The
// gate writes `lastRequestAt` before sending, and the next request cannot
// record until the interval has passed, so the snapshot is exactly that
// request's recorded start (as long as it arrives within one interval of
// being sent). Spacing is then asserted on recorded starts with no tolerance,
// plus the causal check that each request arrived no earlier than its
// recorded start.

/**
 * The recorded start of the last gated request, or null if none yet. One
 * origin per test, so the pacing dir holds at most one state file (`.tmp`
 * files are in-flight writes, renamed atomically into place).
 */
export function recordedStart(stateDir) {
	const dir = path.join(stateDir, "pacing");
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	if (files.length !== 1) return null;
	try {
		return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")).lastRequestAt ?? null;
	} catch {
		return null;
	}
}

/**
 * Serves fixed bodies per path, logging when each path was hit and — given
 * `stateDir` — the recorded start of the request that hit it. Anything
 * unlisted is a 404.
 */
export async function serveLogged(routes, { stateDir } = {}) {
	const hits = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		hits.push({
			path: url.pathname,
			at: Date.now(),
			recorded: stateDir ? recordedStart(stateDir) : null,
		});
		const body = routes[url.pathname];
		if (body === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const type = url.pathname.endsWith(".txt") ? "text/plain" : "text/html";
		res.writeHead(200, { "content-type": type });
		res.end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/**
 * Every consecutive pair of gated requests started at least `minGapMs` apart
 * (by recorded start, exact), and none reached the server before it was
 * recorded. See the section comment above for why not arrival gaps.
 */
export function assertSpaced(hits, minGapMs) {
	for (const h of hits) {
		assert.equal(typeof h.recorded, "number", `${h.path} arrived with no recorded start`);
		assert.ok(h.at >= h.recorded, `${h.path} arrived before its recorded start`);
	}
	for (let i = 1; i < hits.length; i++) {
		const gap = hits[i].recorded - hits[i - 1].recorded;
		assert.ok(
			gap >= minGapMs,
			`${hits[i - 1].path} -> ${hits[i].path} started only ${gap}ms apart ` +
				`(want >= ${minGapMs})` +
				(gap === 0 ? "; the earlier request arrived after the later one was recorded" : ""),
		);
	}
}
