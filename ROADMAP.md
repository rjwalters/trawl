# trawl roadmap

`trawl` fetches client-rendered web pages from the command line, as a library
and as a read-only MCP server, and behaves politely by default while doing it.

Status as of 2026-11-14, `main` @ `ad07538`.

This file is the hand-written direction. `WORK_PLAN.md` is the generated view
of the tracker's label state and `WORK_LOG.md` the generated record of what
merged; neither is edited by hand.

## Where it stands

Released: **0.4.0** (tag `v0.4.0`, `CHANGELOG.md`). `[Unreleased]` holds two
entries awaiting a 0.5.0 cut: the MCP load controls and the `robots.txt`
`*`/`$` matching described below. Everything in the table is on `main` and
covered by `npm test`, which CI runs on Node 22 and Node 24
(`.github/workflows/ci.yml`, Ubuntu).

| Area | State | Evidence |
| --- | --- | --- |
| Rendering: text, HTML, links, title, Markdown; `--selector`, `--wait-for`, screenshots | done | `src/render.mjs`, `tests/render.test.mjs` |
| `networkidle` timeout retried once with `domcontentloaded` | done | `src/render.mjs`, README "Pages that never go idle" |
| Click steps (`--click`, `--then-wait`) on the CLI and library | done | #56, `tests/click.test.mjs` |
| HAR capture, `--har-omit-content`, `--har-redact` | done | #84 / PR #85, `tests/har-redact.test.mjs` |
| `robots.txt` check before every `http(s)` fetch; unreachable means disallow | done | #37, `src/robots.mjs` |
| `robots.txt` rule paths honour `*` and a trailing `$` (RFC 9309 §2.2.3) | done | #109 / PR #114, `tests/robots.test.mjs` |
| Per-origin pacing across runs, `Crawl-delay` honored | done | #38, `src/pacing.mjs` |
| Per-origin cooldown after 429/503 (exit code 4) | done | #39 / PR #61, `src/cooldown.mjs` |
| Auth-wall detection, `--profile`, `trawl login` (headed, finishes on window close) | done | #22, #24, #95, #96 / PR #98 |
| Cookie import from HAR, `cookies.txt` or copy-as-cURL; `--cookies` for one fetch | done | #36, #76 to #79 / PRs #81, #82, #83, #86 |
| Cookies sent on the `robots.txt` request, header-safe and kept out of errors | done | #87, #89, #91, #93 / PRs #88, #90, #92, #94 |
| MCP server: `fetch_page`, `fetch_links`, output budget | done | `src/mcp.mjs`, `tests/mcp.test.mjs` |
| MCP load controls: `wait_until`, `settle_ms`, `timeout_ms` on both tools | done | #110 / PR #117, `tests/mcp.test.mjs` |
| README usage block and MCP tool table pinned to `--help` and the tool schema | done | #74 / PR #80, `tests/readme.test.mjs` |
| Shared test helpers (browser skip guard, `runBin`, `assertNoValue`) | done | #115 / PR #121, `tests/helpers.mjs` |

The tracker holds six open issues and one other open pull request. #106 is the
Champion's hold digest (zero holds), not work. The rest is live work: #111 and
#112 are the two remaining Now items below, #116 and #122 are test-reliability
defects, and #120 is a Hermit simplification proposal awaiting a Champion
decision. PR #119 is approved (`loom:pr`) and waiting to merge.

## Now

Each of these fits one pull request, and each has an issue filed.

1. **Make the cookie helpers importable** (#111, PR #119 approved and awaiting
   merge). The README's library section tells callers to prepare
   `{ cookies: [...] }` with `parseCookies`, `filterCookies` and
   `browserWouldReject` "in `src/cookies.mjs`", but `package.json` `exports`
   exposes only `.` (`src/render.mjs`), which imports `addCookiesFailure` and
   `cookieHeaderFor` without re-exporting the three the README names — so an
   installed package cannot import them.
   Done when: the three functions (and `CookieParseError`) are importable from
   the published entry points, a test imports them through the package name
   rather than a relative path, and the README shows the import line.
   Blocked by: nothing; the work is done and merging #119 closes it.

2. **Bring the README Status section up to date** (#112, currently
   `loom:blocked`). `README.md:577-582` still describes "the first milestone
   set" and omits clicking, sign-in, cookies, pacing and cooldowns; "see the
   issues for what's next" points the reader at a tracker that no longer
   matches it.
   Done when: the section names the current capability set in a few lines and
   links this file. Blocked by: this file landing on `main` — that is what the
   issue is waiting for, so the hold clears on merge rather than needing a
   decision.

3. **Make the `runBin` cookie-fetch tests skip instead of fail when Chromium
   is only in the real `HOME`** (#116, `loom:issue`). Three tests in
   `tests/cookies-fetch.test.mjs` override `HOME` to a temp dir so a fetch's
   `$HOME` footprint can be measured, but Playwright resolves its browser
   cache relative to `HOME`, so the subprocess finds nothing while the shared
   skip guard — which resolves in the ambient environment — says "run".
   Done when: the guard and the subprocess agree on the same `HOME`, so a host
   with Chromium only in `~/.cache/ms-playwright` skips cleanly rather than
   failing on exit code 1. Blocked by: nothing.

4. **Report a `runBin` timeout as a failure, not exit code 0** (#122,
   `loom:triage`). `tests/helpers.mjs` resolves `{ code: err?.code ?? 0 }`,
   but when `execFile` kills the child on its own 60s timeout Node reports
   `err.code === null` with `err.signal === "SIGTERM"` — so a hang is
   indistinguishable from a clean run with empty output.
   Done when: a killed child reports a non-zero code (or the signal) and a
   test pins that, so a hang fails loudly. Blocked by: curation only — the
   issue still needs `loom:curated` before dispatch.

## Next

- **Release 0.5.0.** Unblocked once #119 has merged; items 2 to 4 above are
  documentation and test hygiene and need not gate the cut. Done when
  `CHANGELOG.md` has a dated `[0.5.0]` entry, `package.json` matches (it still
  reads `0.4.0`), and the tag exists. The two `[Unreleased]` entries are
  already written, and the `robots.txt` one already states that more paths are
  refused than before — that note must survive into the release entry.
  Publishing to npm is a maintainer step.
- **Decide #120** (remove the `pacingOrigin`/`cooldownOrigin` aliases for
  `stateOrigin`). A Hermit proposal, so it needs a Champion decision before it
  is work. Done when the issue is promoted or closed with a rationale.

## Later

Direction, each with the question to answer first.

- **Check `robots.txt` before the browser starts on the `--profile` path.**
  Today a refused run still creates the profile directory and, with `--har`,
  an empty HAR (README, Etiquette). Question: can the profile's cookies for
  `<origin>/robots.txt` be read without launching the browser that owns the
  jar?
- **Stop a redirect into a cooling-down origin.** The cooldown check looks
  only at the origin asked for (README, Etiquette). Question: can the
  navigation's redirect chain be checked before the request leaves, without
  also intercepting subresources?
- **Partitioned cookies under a parent domain on the `robots.txt` request.**
  They are left out although the browser would send them (README,
  Etiquette). Question: is there a site where this changes the verdict?
- **Paging long MCP results.** `src/mcp.mjs` truncates at a character budget
  and says pagination is not in v1. Question: do agents hit the budget on
  pages where `selector` and `fetch_links` do not help?
- **CI beyond Ubuntu.** `trawl login` had a macOS-only hang (#96) and
  `src/browser.mjs` has Windows paths, but CI runs on Ubuntu only. Question:
  which of the browser-resolution and login tests can run headless on those
  runners?
- **Percent-encoding normalisation in `robots.txt` matching** (RFC 9309
  §2.2.2). Both sides are compared exactly as given, so `/a/~file` and
  `/a/%7Efile` are different paths. Question: does any real `robots.txt`
  depend on the normalised reading?

## Blocked and waiting

Nothing is parked on an upstream release. Two items wait on something other
than an available pair of hands, and one tracker entry is not work at all:

- **#112** waits on this file reaching `main`, which is the whole of its
  blocker — no decision needed.
- **#120** waits on a Champion decision, as every proposal does.
- **#106** is not work: it is the Champion's merge-risk hold digest, currently
  recording zero holds.

Everything else in the tracker is dispatchable: #116 is `loom:issue`, #111 has
an approved PR awaiting merge, and #122 needs curation rather than a decision.

## Not planned

- Proxy rotation, fingerprint spoofing, CAPTCHA solving (README, Etiquette).
- Detecting or auto-retrying past anti-bot interstitials; the documented
  `--wait-until domcontentloaded --settle` recipe is the answer.
- Click, type, navigate, cookies or profiles on the MCP server: it stays
  read-only by design (`src/mcp.mjs` header, README "As an MCP server").
- A hosted service or account: this is the local option (README "Why not X?").
