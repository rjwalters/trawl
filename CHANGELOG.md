# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
