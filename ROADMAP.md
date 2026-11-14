# trawl roadmap

`trawl` fetches client-rendered web pages from the command line, as a library
and as a read-only MCP server, and behaves politely by default while doing it.

Status as of 2026-11-13, `main` @ `a940713`.

This file is the hand-written direction. `WORK_PLAN.md` is the generated view
of the tracker's label state and `WORK_LOG.md` the generated record of what
merged; neither is edited by hand.

## Where it stands

Released: **0.4.0** (tag `v0.4.0`, `CHANGELOG.md`; `[Unreleased]` is empty).
Everything below is on `main` and covered by `npm test`, which CI runs on
Node 22 and Node 24 (`.github/workflows/ci.yml`, Ubuntu).

| Area | State | Evidence |
| --- | --- | --- |
| Rendering: text, HTML, links, title, Markdown; `--selector`, `--wait-for`, screenshots | done | `src/render.mjs`, `tests/render.test.mjs` |
| `networkidle` timeout retried once with `domcontentloaded` | done | `src/render.mjs`, README "Pages that never go idle" |
| Click steps (`--click`, `--then-wait`) on the CLI and library | done | #56, `tests/click.test.mjs` |
| HAR capture, `--har-omit-content`, `--har-redact` | done | #84 / PR #85, `tests/har-redact.test.mjs` |
| `robots.txt` check before every `http(s)` fetch; unreachable means disallow | done, prefix matching only | #37, `src/robots.mjs` |
| Per-origin pacing across runs, `Crawl-delay` honored | done | #38, `src/pacing.mjs` |
| Per-origin cooldown after 429/503 (exit code 4) | done | #39 / PR #61, `src/cooldown.mjs` |
| Auth-wall detection, `--profile`, `trawl login` (headed, finishes on window close) | done | #22, #24, #95, #96 / PR #98 |
| Cookie import from HAR, `cookies.txt` or copy-as-cURL; `--cookies` for one fetch | done | #36, #76 to #79 / PRs #81, #82, #83, #86 |
| Cookies sent on the `robots.txt` request, header-safe and kept out of errors | done | #87, #89, #91, #93 / PRs #88, #90, #92, #94 |
| MCP server: `fetch_page`, `fetch_links`, output budget | done, one wait control only | `src/mcp.mjs`, `tests/mcp.test.mjs` |
| README usage block and MCP tool table pinned to `--help` and the tool schema | done | #74 / PR #80, `tests/readme.test.mjs` |

The tracker holds no open work item today. The one open issue, #106, is the
Champion's hold digest (zero holds), not work. There are no open pull requests.

## Now

Each of these can start today and fits one pull request. None has an issue yet.

1. **`robots.txt` wildcard and end-anchor matching.** `matchRule` in
   `src/robots.mjs` compares by literal prefix, so a rule such as
   `Disallow: /*.pdf$` or `Disallow: /private/*/drafts` never matches and the
   path is fetched. RFC 9309 section 2.2.3 lists `*` and `$` among the special
   characters a crawler must support.
   Done when: `matchRule` treats `*` as any run of characters and a trailing
   `$` as end of path; the longest-match and `Allow`-wins-ties rules still
   hold; `tests/robots.test.mjs` covers both; and the README Etiquette
   sentence "Wildcard (`*`) and end-anchor (`$`) patterns are not supported"
   is replaced. Blocked by: nothing. Note: the module header calls this out of
   scope on purpose, so this reverses an earlier choice.

2. **Load controls on the MCP tools.** `fetch_page` takes only `url`,
   `format`, `selector` and `wait_for`; `fetch_links` only `url` and
   `selector`. An agent cannot pass the README's own recipe for pages that
   never go idle (`--wait-until domcontentloaded --settle <ms>`), so every
   such page waits out the default timeout before the retry.
   Done when: both tools accept optional `wait_until`, `settle_ms` and
   `timeout_ms`, validated and mapped in `renderOptionsFor`; the README MCP
   table lists them and `tests/readme.test.mjs` passes; `tests/mcp.test.mjs`
   covers the mapping and the rejections. The surface stays read-only: no
   click, no cookies, no profile. Blocked by: nothing.

3. **Make the cookie helpers importable.** The README's library section tells
   callers to prepare `{ cookies: [...] }` with `parseCookies`, `filterCookies`
   and `browserWouldReject` "in `src/cookies.mjs`", but `package.json`
   `exports` exposes only `.` (`src/render.mjs`), which does not re-export
   them, so an installed package cannot import them.
   Done when: the three functions (and `CookieParseError`) are importable from
   the published entry points, a test imports them through the package name
   rather than a relative path, and the README shows the import line.
   Blocked by: nothing.

4. **Bring the README Status section up to date.** It still describes "the
   first milestone set" and omits clicking, sign-in, cookies, pacing and
   cooldowns; "see the issues for what's next" points at an empty tracker.
   Done when: the section names the current capability set in a few lines and
   links this file. Blocked by: nothing.

## Next

- **Release 0.5.0.** Unblocked once items 1 to 3 have merged. Done when
  `CHANGELOG.md` has a dated `[0.5.0]` entry, `package.json` matches, and the
  tag exists. Item 1 changes which paths are refused, so the entry must say
  so. Publishing to npm is a maintainer step.
- **Pin the denial message for pattern rules.** Unblocked by item 1. A denial
  names the rule line that matched; done when a test pins that message for a
  `*` rule and a `$` rule and the README Etiquette section shows one example.

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

## Blocked and waiting

Nothing is parked on a decision or an upstream release. Equally, **nothing is
dispatchable from the tracker today**: the four Now items need issues filed
before any of them can be picked up.

## Not planned

- Proxy rotation, fingerprint spoofing, CAPTCHA solving (README, Etiquette).
- Detecting or auto-retrying past anti-bot interstitials; the documented
  `--wait-until domcontentloaded --settle` recipe is the answer.
- Click, type, navigate, cookies or profiles on the MCP server: it stays
  read-only by design (`src/mcp.mjs` header, README "As an MCP server").
- A hosted service or account: this is the local option (README "Why not X?").
