// The on-disk state trawl keeps between invocations: where it lives, how a
// file is named, how it is replaced atomically, and the per-file
// interprocess lock that serializes a read → modify → write.
//
// Shared by per-origin pacing (src/pacing.mjs) and per-origin cooldowns
// (src/cooldown.mjs). Each feature keeps its own subdirectory and its own
// lock files, so neither ever rewrites the other's fields and no caller ever
// needs to hold two locks at once.
//
// Nothing fetched is ever written here: no URLs, credentials, cookies, or
// page content. Files are named by a digest of the canonical origin.
//
// Browser-free, and every side effect (clock, sleep, liveness check) is
// injectable so the callers stay testable deterministically.

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	linkSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

// A lock file whose owner record cannot be parsed (a crash between create and
// write) is presumed abandoned once it is this old.
const UNREADABLE_LOCK_GRACE_MS = 5000;

const LOCK_POLL_MS = 25;

// `$TRAWL_STATE_DIR`, else `${XDG_CACHE_HOME:-~/.cache}/trawl`. A relative
// XDG_CACHE_HOME is ignored, as the XDG spec requires.
export function defaultStateDir(env = process.env, home = homedir()) {
	if (env.TRAWL_STATE_DIR) return env.TRAWL_STATE_DIR;
	const xdg = env.XDG_CACHE_HOME;
	const cache = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
	return path.join(cache, "trawl");
}

// The state key: scheme + host + effective port, never a path. Returns null
// for anything that is not http(s), which bypasses the state dir entirely.
export function stateOrigin(url) {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return u.origin;
	} catch {
		return null;
	}
}

export function originDigest(origin) {
	return createHash("sha256").update(origin).digest("hex").slice(0, 32);
}

export const uniqueToken = (pid = process.pid) =>
	`${pid}-${randomBytes(8).toString("hex")}`;

// Replace `file` with `data` (JSON-encoded) in one rename, so a reader sees
// the old content or the new, never a torn mix. Throws on failure, after
// removing its temporary file.
export function writeJsonAtomic(file, data) {
	const tmp = `${file}.${uniqueToken()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data));
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

// Raised by a lock's `acquire()` when another holder outlasted the budget.
export class LockTimeoutError extends Error {
	constructor(lockPath, timeoutMs) {
		super(`gave up after ${timeoutMs}ms waiting for lock ${lockPath}`);
		this.name = "LockTimeoutError";
		this.lockPath = lockPath;
		this.timeoutMs = timeoutMs;
	}
}

function parseOwner(raw) {
	try {
		const o = JSON.parse(raw);
		if (
			o &&
			typeof o.token === "string" &&
			Number.isInteger(o.pid) &&
			typeof o.host === "string" &&
			typeof o.createdAt === "number" &&
			Number.isFinite(o.createdAt)
		) {
			return o;
		}
	} catch {
		// fall through
	}
	return null;
}

export function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists, it just isn't ours to signal.
		return err?.code === "EPERM";
	}
}

export const realSleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

// An exclusive, interprocess lock on `lockPath` (created with O_EXCL). The
// directory must already exist. `acquire()` resolves to a release function,
// throws LockTimeoutError once `timeoutMs` has passed waiting for another
// holder, and rethrows any other I/O error for the caller to classify.
//
// A lock is evicted as stale when its owner is a dead PID on this host, or
// when it is older than `staleMs` (a live PID that old has been reused; on
// another host only age can decide).
export function createFileLock({
	lockPath,
	timeoutMs,
	staleMs,
	now = Date.now,
	sleep = realSleep,
	isAlive = defaultIsAlive,
	pid = process.pid,
	host = hostname(),
}) {
	const token = () => uniqueToken(pid);

	function isStale(owner, mtimeMs) {
		const t = now();
		if (!owner) return t - mtimeMs > UNREADABLE_LOCK_GRACE_MS;
		const age = t - owner.createdAt;
		const ancient = age > staleMs || age < -staleMs;
		if (owner.host === host) {
			if (!isAlive(owner.pid)) return true;
			// Alive, but a lock this old outlives any real hold — the PID has
			// been reused by an unrelated process.
			return ancient;
		}
		// Another host's PIDs mean nothing here; only age can decide.
		return ancient;
	}

	// Returns true when the caller should retry acquisition immediately.
	function tryEvictStale() {
		let raw;
		let mtimeMs;
		try {
			mtimeMs = statSync(lockPath).mtimeMs;
			raw = readFileSync(lockPath, "utf8");
		} catch (err) {
			return err?.code === "ENOENT";
		}
		const owner = parseOwner(raw);
		if (!isStale(owner, mtimeMs)) return false;

		// Rename is atomic, so only one evicter wins a given file. Then check
		// we moved the lock we judged stale, not a fresh one created between
		// our read and the rename; if we did grab a fresh one, put it back
		// without clobbering (link fails if the name is taken again).
		const tomb = `${lockPath}.stale-${token()}`;
		try {
			renameSync(lockPath, tomb);
		} catch {
			return true;
		}
		let moved = null;
		try {
			moved = parseOwner(readFileSync(tomb, "utf8"));
		} catch {
			moved = null;
		}
		const same = owner ? moved?.token === owner.token : moved === null;
		if (!same) {
			try {
				linkSync(tomb, lockPath);
			} catch {
				// Someone already holds the name again; nothing to restore.
			}
		}
		try {
			unlinkSync(tomb);
		} catch {
			// best effort
		}
		return same;
	}

	function release(mine) {
		try {
			const owner = parseOwner(readFileSync(lockPath, "utf8"));
			// Only remove our own lock — if it was (wrongly) evicted and someone
			// else holds the name now, leave theirs alone.
			if (owner?.token === mine) unlinkSync(lockPath);
		} catch {
			// Already gone; nothing to release.
		}
	}

	async function acquire() {
		const mine = token();
		const started = now();
		for (;;) {
			let fd;
			try {
				fd = openSync(lockPath, "wx");
			} catch (err) {
				if (err?.code !== "EEXIST") throw err;
			}
			if (fd !== undefined) {
				try {
					writeSync(
						fd,
						JSON.stringify({ token: mine, pid, host, createdAt: now() }),
					);
					closeSync(fd);
				} catch (err) {
					try {
						closeSync(fd);
					} catch {}
					try {
						unlinkSync(lockPath);
					} catch {}
					throw err;
				}
				return () => release(mine);
			}
			if (tryEvictStale()) continue;
			if (now() - started >= timeoutMs) {
				throw new LockTimeoutError(lockPath, timeoutMs);
			}
			await sleep(LOCK_POLL_MS);
		}
	}

	return { acquire, lockPath };
}
