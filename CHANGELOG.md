# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cross-run request pacing.** Requests to an origin are now spaced across
  separate `trawl` invocations (and concurrent ones), not just within one run:
  before the `robots.txt` request, the page navigation, and the
  `networkidle`-fallback navigation, `trawl` waits until
  `max(--min-interval, Crawl-delay)` has elapsed since the last request any
  `trawl` process made to that origin. The minimum defaults to 1000 ms
  (`--min-interval <ms>`, 0–60000; library `minIntervalMs`); `--no-pacing`
  (library `pacing: false`) opts out and keeps the old in-run `Crawl-delay`
  sleep. State lives in `$TRAWL_STATE_DIR`, else
  `${XDG_CACHE_HOME:-~/.cache}/trawl` (library `pacingStateDir`), guarded by a
  per-origin lock with stale-lock recovery; an unusable state directory warns
  and falls back to in-run pacing. A plain `trawl <url>` now waits up to 1s
  between its `robots.txt` request and the page request (browser startup
  usually absorbs most of it). (#38)

### Changed

- **Behavior change:** an unreachable `robots.txt` is now a full disallow, per
  RFC 9309 §2.3.1.4, instead of failing open. A 5xx response (including at the
  end of a redirect chain), a network error, a timeout, or a body that fails
  mid-read refuses the run before any browser launches, with an error naming
  `robots.txt`, the cause (`returned HTTP 503 (server error)`, `network error:
  ENOTFOUND`, `timed out after 10000ms`, …) and `--ignore-robots` — not a
  made-up `Disallow` rule. 4xx responses, 404/410/429 included, still mean "no
  restrictions". Network errors and timeouts deny too, deliberately: the RFC
  calls them unreachable, and an allow-on-error check is skipped by exactly the
  outages and interstitials it exists for. The cost is that a transient DNS
  blip or a slow `robots.txt` now fails the run where it used to proceed;
  retry, or pass `--ignore-robots` (which skips the request entirely). The
  `robots.txt` request carries no browser-profile cookies, so a site that 503s
  cookie-less clients blocks `trawl` until you pass `--ignore-robots`. Library
  `render()` callers get the same rejection. (#37)
- The `robots.txt` request is built from the page's origin, so credentials in
  a `user:pass@host` URL are never sent to (or reported for) `robots.txt`;
  Node's `fetch` would otherwise reject such a URL, which is now a denial. (#37)

## [0.3.0] - 2026-09-30

`trawl` now finds the browser that Playwright's own installer downloads on x64
Linux, and `trawl login` no longer needs a profile path chosen up front.

### Added

- `trawl login <origin>` defaults to a shared `~/.trawl/profile` (created on
  first use, announced on stderr) when neither `--profile` nor
  `$TRAWL_PROFILE_DIR` is set. Explicit values still win. Plain `trawl <url>`
  fetches stay ephemeral. (#25)
- `--help` and the README document `--wait-until domcontentloaded --settle
  15000` as the workaround for anti-bot interstitials that hold `networkidle`
  open. (#25)

### Fixed

- On x64 Linux, the cached `chrome-headless-shell` lookup missed the binary
  that `npx playwright install chromium --only-shell` installs: current
  Playwright names that directory `chrome-headless-shell-linux64`, and only
  `-linux` was searched, so `trawl` threw `NoBrowserError` right after
  following its own install advice. `linux64` is now checked first, with the
  legacy name kept as a fallback. (#33)

## [0.2.0] - 2026-08-14

Auth-gated pages now fail loudly instead of masquerading as content, and a
persistent-profile login path lets a human hand trawl an authenticated
session once instead of dead-ending an agent every run.

### Added

- Login-wall detection: when a rendered page looks like an auth gate — tiny
  extracted text with sign-in vocabulary, a form with a password field, or a
  final URL on a known login path/provider — `render()` throws
  `AuthWallError` and the CLI exits with code `3` plus a hint pointing at
  `trawl login`. `--no-auth-check` opts out. (#22)
- `--profile <dir>` / `$TRAWL_PROFILE_DIR` renders through a persistent
  browser context, so cookies and localStorage survive across runs. (#22)
- `trawl login <origin>` opens a headed browser against the profile
  directory so a user can sign in once; later runs with the same profile
  reuse the session. (#22)
- Navigation-timeout fallback: when the default `--wait-until networkidle`
  never fires (sites holding sockets open), the render retries once with
  `domcontentloaded` + a settle grace period and reports the downgrade. (#22)

### Fixed

- `package-lock.json` still carried the unscoped package name; synced with
  `@rjwalters/trawl`. (#21)

## [0.1.0] - 2026-08-03

First release. `trawl` renders a page in headless Chromium and prints what a
human would actually see, so a client-rendered app comes back as content
instead of an empty `<div id="root">`.

### Added

- Core rendering with `-f/--format text|html|links|title` (`text` default),
  `-s/--selector` to extract a single subtree, `-w/--wait-for` to block on a
  selector, `--settle`, `--wait-until`, and `--timeout`.
- `--har <file>` records the full network trace as a HAR 1.2 archive, flushed
  when the browser context closes so a run that fails mid-navigation still
  leaves a valid trace behind. `--har-omit-content` keeps requests and timings
  but drops response bodies. (#1)
- `trawl mcp` serves `fetch_page` and `fetch_links` over stdio
  [MCP](https://modelcontextprotocol.io), so an MCP-speaking agent gets the
  same rendering the CLI does. Neither tool clicks, types, or navigates a
  session. Results over 100,000 characters are truncated with a notice;
  `TRAWL_MCP_MAX_CHARS` changes the budget. (#2)
- `-f markdown` (alias `md`) runs Mozilla Readability against the rendered page
  to drop nav/footer chrome, then converts to Markdown. `--no-readability`
  converts the page as-is for docs sites and single-column apps that Readability
  over-trims. (#3)
- `robots.txt` is consulted before every `http(s)` fetch, with `User-agent`
  group selection, longest-prefix matching, and `Allow` breaking ties.
  `Crawl-delay` is honored and capped at 60s. Unreachable `robots.txt` fails
  open — this is politeness, not a security boundary. `--ignore-robots`
  overrides. Applies to the `render()` library entry point too. (#4)
- `--screenshot <file>` writes a PNG alongside the normal stdout output rather
  than replacing it, with `--full-page` for the whole scroll height and
  `--viewport <WxH>` to set the render size. (#5)
- `-o/--output`, `-A/--user-agent`, `--executable-path`, and `-S/--show-status`.
- Usable as a library: `import { render } from "@rjwalters/trawl"`.

### Fixed

- `trawl` silently did nothing when invoked through its installed `bin`
  symlink. The entry-point guard compared `argv[1]` against a `cli.mjs`
  filename suffix, which a symlinked launcher never matches, so the CLI loaded
  and exited without running. Now resolved by real path. (#12, #14)
- `src/cli.mjs` was committed non-executable. A registry install masks this —
  npm chmods `bin` targets at install time — but `npm link` symlinks into the
  working tree, so the bin inherited mode `100644` and died with `permission
  denied` before Node started. (#16)

### Notes

- Depends on `playwright-core`, not full `playwright`, so installing does not
  download a browser. Resolution order: `--executable-path`,
  `$TRAWL_EXECUTABLE_PATH`, a cached `chrome-headless-shell`, then a system
  Chrome/Chromium.
- Exit codes follow `curl --fail`: `0` success, `22` on a 4xx/5xx page
  response, `1` for usage or runtime errors.
- Published as `@rjwalters/trawl`. The unscoped `trawl` was already taken, and
  npm's typosquatting guard rejects `trawl-cli` as too close to `trash-cli`.
  The installed command is `trawl` either way — the scope affects the package
  name, not the binary.

[0.2.0]: https://github.com/rjwalters/trawl/releases/tag/v0.2.0
[0.1.0]: https://github.com/rjwalters/trawl/releases/tag/v0.1.0
