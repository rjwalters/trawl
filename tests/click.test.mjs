// Click steps (--click / render({ click })). The parsing and validation tests
// run anywhere; the end-to-end ones need Chromium and skip cleanly without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveExecutablePath } from "../src/browser.mjs";
import { parseArgs } from "../src/cli.mjs";
import { ClickError, normalizeClickSteps, render } from "../src/render.mjs";

let haveBrowser = true;
try {
	resolveExecutablePath();
} catch {
	haveBrowser = false;
}
const opts = { skip: haveBrowser ? false : "no Chromium binary installed" };

// Never touch the real ~/.cache/trawl pacing state.
process.env.TRAWL_STATE_DIR = mkdtempSync(join(tmpdir(), "trawl-state-"));

const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// Content that exists only after a click. "#open" reveals a panel; "#more",
// which only exists inside that panel, appends a second line after a short
// delay — so the two clicks only work in this order, and the second one's
// result only shows up if its wait is honoured.
const PAGE = `<!doctype html>
<title>Click fixture</title>
<main>
  <button id="open">Show transcript</button>
  <a id="away" href="/other">Elsewhere</a>
  <a id="tab" href="/other" target="_blank">New tab</a>
  <button id="popup" onclick="window.open('/other')">Popup</button>
  <button id="delayed">Later</button>
  <button id="soon">Soon</button>
  <button id="late">Late</button>
  <section id="panel" hidden></section>
</main>
<script>
  const panel = document.getElementById("panel");
  document.getElementById("delayed").addEventListener("click", () => {
    setTimeout(() => { location.href = "/other"; }, 150);
  });
  document.getElementById("late").addEventListener("click", () => {
    setTimeout(() => { location.href = "/other"; }, 400);
  });
  document.getElementById("soon").addEventListener("click", () => {
    setTimeout(() => { location.href = "/other"; }, 10);
  });
  document.getElementById("open").addEventListener("click", () => {
    panel.hidden = false;
    panel.innerHTML =
      '<p id="line1">first line</p><button id="more">More</button>';
    document.getElementById("more").addEventListener("click", () => {
      setTimeout(() => {
        panel.insertAdjacentHTML("beforeend", '<p id="line2">second line</p>');
      }, 300);
    });
  });
</script>`;

async function serve() {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(req.url);
		if (req.url === "/robots.txt") {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/wall") {
			res.end("<title>Gated</title><body>Sign in</body>");
			return;
		}
		res.end(req.url === "/other" ? "<title>Other</title><p>other page</p>" : PAGE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		hits,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

const fast = { minIntervalMs: 0 };

// An absence check has to wait: a request the browser let out could still be
// in flight when render() settles. Poll the server log for a bounded window
// and fail the moment `path` shows up.
async function assertNeverRequested(s, path, windowMs = 400) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		assert.ok(!s.hits.includes(path), `server saw ${s.hits.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(!s.hits.includes(path), `server saw ${s.hits.join(", ")}`);
}

// --- parsing ---------------------------------------------------------------

test("--click repeats in order and --then-wait pairs with the click before it", () => {
	const args = parseArgs([
		"u",
		"--click",
		"#a",
		"--then-wait",
		"#a-done",
		"--click=#b",
		"-s",
		"#out",
	]);
	assert.deepEqual(args.clicks, [
		{ selector: "#a", waitFor: "#a-done" },
		{ selector: "#b" },
	]);
	assert.equal(args["--selector"], "#out");
	assert.deepEqual(args._, ["u"]);
});

test("--then-wait without a preceding --click is a usage error", () => {
	assert.throws(() => parseArgs(["u", "--then-wait", "#x"]), /must follow a --click/);
});

test("two --then-wait for one --click is a usage error", () => {
	assert.throws(
		() => parseArgs(["u", "--click", "#a", "--then-wait", "#x", "--then-wait", "#y"]),
		/given twice/,
	);
});

test("normalizeClickSteps accepts strings and objects, rejects junk", () => {
	assert.deepEqual(normalizeClickSteps(undefined), []);
	assert.deepEqual(normalizeClickSteps("#a"), [{ selector: "#a" }]);
	assert.deepEqual(normalizeClickSteps(["#a", { selector: "#b", waitFor: "#c" }]), [
		{ selector: "#a" },
		{ selector: "#b", waitFor: "#c" },
	]);
	assert.throws(() => normalizeClickSteps([""]), /click step 1: selector/);
	assert.throws(() => normalizeClickSteps(["#a", 42]), /click step 2/);
	assert.throws(() => normalizeClickSteps([{ selector: "#a", waitFor: "" }]), /waitFor/);
});

test("render() rejects a malformed click list before any request", async () => {
	const s = await serve();
	try {
		await assert.rejects(render(s.url, { click: [""] }), /click step 1/);
		assert.deepEqual(s.hits, [], "no robots.txt or page request was made");
	} finally {
		await s.close();
	}
});

// --- library, end to end ---------------------------------------------------

test("render() runs two clicks in order and reads what they revealed", opts, async () => {
	const s = await serve();
	try {
		const { body } = await render(s.url, {
			...fast,
			selector: "#panel",
			click: ["#open", { selector: "#more", waitFor: "#line2" }],
		});
		assert.match(body, /^first line\s+More\s+second line$/);
	} finally {
		await s.close();
	}
});

test("render() without the click sees an empty panel", opts, async () => {
	const s = await serve();
	try {
		const { body } = await render(s.url, { ...fast, selector: "#panel" });
		assert.equal(body, "");
	} finally {
		await s.close();
	}
});

test("clicks in the wrong order fail on the step that cannot run", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, timeout: 1500, click: ["#more", "#open"] }),
			(err) => {
				assert.ok(err instanceof ClickError);
				assert.equal(err.step, 1);
				assert.equal(err.selector, "#more");
				assert.match(err.message, /click step 1 of 2 \("#more"\)/);
				assert.match(err.message, /within 1500ms/);
				return true;
			},
		);
	} finally {
		await s.close();
	}
});

test("a waitFor that never appears is a ClickError, not an empty result", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, {
				...fast,
				timeout: 1000,
				click: [{ selector: "#open", waitFor: "#never" }],
			}),
			(err) => err instanceof ClickError && /"#never" did not appear/.test(err.message),
		);
	} finally {
		await s.close();
	}
});

test("a click that would load another page is refused, and never requested", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, { ...fast, timeout: 2000, click: ["#away"] }),
			(err) => err instanceof ClickError && /tried to navigate to .*\/other/.test(err.message),
		);
		await assertNeverRequested(s, "/other");
	} finally {
		await s.close();
	}
});

// Each of these would load /other as a new top-level page. The assertion
// that matters is the server log: the request must never leave the browser.
// The popup and 10ms cases run at the default settle of 0, where the
// navigation reaches the browser after the click loop has ended — the guard
// has to last the whole run, not just the clicks.
for (const [name, click, extra] of [
	["a target=_blank link (settle 0)", "#tab", { settle: 0 }],
	["a window.open() popup (settle 0)", "#popup", { settle: 0 }],
	["a navigation 10ms after the click (default settle)", "#soon", {}],
	["a navigation 150ms after the click (settle 500)", "#delayed", { settle: 500 }],
]) {
	test(`${name} is refused, and never requested`, opts, async () => {
		const s = await serve();
		try {
			await assert.rejects(
				render(s.url, { ...fast, timeout: 2000, click: [click], ...extra }),
				(err) => {
					assert.ok(err instanceof ClickError, `got ${err}`);
					assert.equal(err.step, 1);
					assert.match(err.message, /tried to navigate to .*\/other/);
					return true;
				},
			);
			await assertNeverRequested(s, "/other");
		} finally {
			await s.close();
		}
	});
}

test("a late navigation is pinned to the step that set it off", opts, async () => {
	const s = await serve();
	try {
		await assert.rejects(
			render(s.url, {
				...fast,
				timeout: 2000,
				settle: 500,
				click: ["#delayed", "#open"],
			}),
			(err) => err instanceof ClickError && err.step === 1,
		);
		await assertNeverRequested(s, "/other");
	} finally {
		await s.close();
	}
});

// Past the per-click floor, the navigation may land during extraction, after
// the final check, or after render() returns. Whichever: the route is still
// on, so it never leaves the browser, and a resolved result is the original
// page, never the one the click was heading for.
test("a navigation late in the run never returns the other page", opts, async () => {
	const s = await serve();
	try {
		let result = null;
		try {
			result = await render(s.url, { ...fast, timeout: 2000, click: ["#late"], selector: "#open" });
		} catch (err) {
			assert.ok(err instanceof ClickError, `got ${err}`);
		}
		if (result) {
			assert.equal(result.body, "Show transcript");
			assert.equal(result.url, s.url);
		}
		await assertNeverRequested(s, "/other", 600);
	} finally {
		await s.close();
	}
});

// --- CLI, through a bin symlink (the shape a PATH install runs) -------------

function runBin(args) {
	const dir = mkdtempSync(join(tmpdir(), "trawl-bin-"));
	const link = join(dir, "trawl");
	symlinkSync(CLI_PATH, link);
	return new Promise((resolve) => {
		execFile(link, args, (err, stdout, stderr) => {
			rmSync(dir, { recursive: true, force: true });
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

test("trawl --click ... --then-wait ... -s reads the revealed panel", opts, async () => {
	const s = await serve();
	try {
		const { code, stdout, stderr } = await runBin([
			s.url,
			"--min-interval",
			"0",
			"--click",
			"#open",
			"--click",
			"#more",
			"--then-wait",
			"#line2",
			"-s",
			"#panel",
		]);
		assert.equal(code, 0, stderr);
		assert.match(stdout, /^first line\s+More\s+second line\n$/);
	} finally {
		await s.close();
	}
});

test("trawl --click on a selector that never appears exits 1 with a clear error", opts, async () => {
	const s = await serve();
	try {
		const { code, stdout, stderr } = await runBin([
			s.url,
			"--min-interval",
			"0",
			"--timeout",
			"1000",
			"--click",
			"#missing",
		]);
		assert.equal(code, 1);
		assert.equal(stdout, "");
		assert.match(stderr, /^trawl: click step 1 of 1 \("#missing"\): no visible, clickable element matched within 1000ms/);
	} finally {
		await s.close();
	}
});

test("trawl --then-wait with no --click exits 1 before any request", async () => {
	const s = await serve();
	try {
		const { code, stderr } = await runBin([s.url, "--then-wait", "#x"]);
		assert.equal(code, 1);
		assert.match(stderr, /--then-wait must follow a --click/);
		assert.deepEqual(s.hits, []);
	} finally {
		await s.close();
	}
});

test("trawl reports a login wall (exit 3) before trying the clicks", opts, async () => {
	const s = await serve();
	try {
		const wall = `${s.url}wall`;
		const gated = await runBin([wall, "--min-interval", "0", "--timeout", "1000", "--click", "#nope"]);
		assert.equal(gated.code, 3, gated.stderr);
		assert.match(gated.stderr, /login wall/);
		assert.doesNotMatch(gated.stderr, /click step/);

		const unchecked = await runBin([
			wall,
			"--min-interval",
			"0",
			"--timeout",
			"1000",
			"--no-auth-check",
			"--click",
			"#nope",
		]);
		assert.equal(unchecked.code, 1);
		assert.match(unchecked.stderr, /click step 1 of 1 \("#nope"\)/);
	} finally {
		await s.close();
	}
});
