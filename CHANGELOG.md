# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`--har-redact`.** Opt-in redaction of `--har` output: replaces the values
  of `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization`
  headers and of every `cookies[]` entry with `[redacted]`, keeping names.
  Fails closed (deletes the HAR and exits non-zero if it cannot redact).
  Output without the flag is unchanged.
- **`trawl cookies import <file> --profile <dir>`.** Copies cookies from a
  HAR, a Netscape `cookies.txt` or a copy-as-cURL command into a persistent
  profile, so a later `trawl <url> --profile <dir>` presents them. Prints
  names, domains and expiry only, never values. Session cookies are stored
  with a 7-day expiry (a profile keeps no others). Expired cookies are dropped,
  and so are sign-in cookies (a best-effort list) unless `--include-auth`;
  `--domain <host>` and `--allow a,b` narrow the import further. Cookies the
  browser would refuse are skipped by name, since one would fail the whole
  batch. Nothing is written until the file parses and at least one cookie
  survives filtering (otherwise exit 1, naming the filter that removed them;
  profile untouched); a profile directory it creates is `0700`. A browser
  error during the write is reported as a fixed message saying nothing was
  imported, never the browser's own text. Warns when a HAR or cURL source came from a different browser, and
  reminds you to delete the source file. `--profile` (or
  `$TRAWL_PROFILE_DIR`) is required. (#77)
- **`trawl <url> --cookies <file>`.** Sends the cookies from a HAR,
  `cookies.txt` or copy-as-cURL file with one fetch, without a profile, and
  writes no cookie store: no profile, no temp file, and session cookies stay
  session cookies (no 7-day expiry). `--har` still records the cookies it
  sends, values included (as it does for `--profile`, and
  `--har-omit-content` does not remove them), so `--cookies` with `--har`
  prints a warning naming the HAR file; `--help` and the README now say this
  for both. Same filtering as `trawl cookies import`
  (`--domain`, `--allow` and `--include-auth` now work on a fetch, but only
  next to `--cookies`; without it each is an error). Prints names, domains
  and expiry to stderr under `-S`, or when a cookie was dropped or skipped;
  never values. A bad file, or one with no usable cookie left, exits 1 before
  any request (robots.txt included) or browser launch. Rejected together with
  `--profile` or `$TRAWL_PROFILE_DIR`, since a profile would keep the
  cookies. The MCP server is unchanged. Library: `render(url, { cookies })`. (#78)

### Changed

- **The robots.txt request now carries the fetch's cookies.** A site whose
  robots.txt answers 503 to cookie-less clients no longer needs
  `--ignore-robots` once its cookies are supplied. trawl still makes the
  request itself with Node's `fetch` (trawl's `User-Agent`, its own 10s
  timeout, the 4xx/5xx rules, pacing and the cooldown check; `--ignore-robots`
  still skips it), now with a `Cookie` header:
  - With `--cookies`: the cookies that match `<origin>/robots.txt`
    (host-only vs `.domain`, path, `Secure` only over https, not expired).
  - With `--profile`: the cookies the profile's jar holds for
    `<origin>/robots.txt`, by the browser's own rules, so a `Secure` cookie
    goes to `http://localhost` and `http://127.0.0.1` as it does on the page
    request. A partitioned (CHIPS) cookie goes only when it is in that site's
    own top-level partition (same scheme and host); one set by a frame
    embedded in another site is never sent. On this path the browser starts
    before the robots.txt check, so a refused run still leaves the profile
    directory and, with `--har`, an empty HAR.
  - No cookie matches: no `Cookie` header at all. A fetch with neither flag
    is unchanged.

  On both paths a redirect to another origin drops the header (a same-origin
  redirect keeps it), and a refusal after such a redirect says the cookies
  did not follow it; a `Set-Cookie` on the robots.txt response is ignored;
  and the request is not recorded by `--har`. The header always holds a value
  Node's fetch accepts: a cookie with a control character (CR, LF, NUL, tab,
  ...) or `;` in its name or value, or `=` in its name, is left out (the
  request goes on with the rest, or no header), and non-ASCII is sent as the
  UTF-8 bytes Chromium sends on the page request. When the request carried
  cookies, a failure is described only by an allowlisted error code
  (`ECONNREFUSED`, `UND_ERR_SOCKET`, `ENOTFOUND`, ...) or the fixed
  `request failed`, never the error's text, which can quote the header. The
  "sends no browser-profile cookies" note in the unreachable-robots.txt error
  is left out when cookies were sent, and on `--profile` says instead that no
  cookie from the profile matched. (#79, #87, #89, #91, #93)
- **Minimum Node is now 22.** `engines.node` moves from `>=20` to `>=22`,
  matching the versions CI tests (22 and 24) now that Node 20 is end-of-life.

### Fixed

- **`trawl login` opens a window again.** It used the fetch resolver, which
  prefers the cached `chrome-headless-shell`, so no window ever appeared
  while trawl said one had. Login now resolves a headed browser:
  `--executable-path` / `$TRAWL_EXECUTABLE_PATH`, then a system Chrome or
  Chromium, then Playwright's full Chromium. It never uses the headless shell,
  and fails with install instructions when nothing headed exists. Login
  records that browser in the profile (`.trawl-browser`, 0600, path and
  timestamp only), and fetches and cookie imports with that profile launch
  it headless, as a precaution against version skew (login usually runs a
  system Chrome newer than the cached headless shell, and Chromium doesn't
  promise an older build reads a newer build's profile). This changes which browser `--profile` fetches use for a
  login-written profile. A recorded path is used only if it is absolute and,
  after following symlinks, an executable regular file named like a
  Chrome/Chromium binary, and on macOS/Linux only if the marker and its
  profile directory are owned by the current user and not writable by group
  or others; trawl launches the resolved file. Any other marker
  is ignored and the browser is chosen exactly as before. An explicit path or
  `$TRAWL_EXECUTABLE_PATH` still wins. `trawl login` now creates new profile
  directories `0700`, as `cookies import` already did. A profile directory
  is trusted input (README). (#95)
- **`trawl login` finishes when the window closes on macOS.** Closing a
  window there leaves the browser app running, so login waited forever. It
  now also finishes when the last page closes, and reuses the initial blank
  tab rather than opening a second. (#96)
- **Cookie pre-check matches Chromium on four more rules.** The check that
  sets aside cookies the browser would refuse (so one cannot sink the whole
  batch) now also catches `__Http-` cookies that are not both `Secure` and
  `HttpOnly`, `__Host-Http-` cookies that are not `HttpOnly`, a bare IPv6
  domain such as `::1` (the bracketed `[::1]` is accepted), and a nameless
  cookie whose value starts with `__Host-`, `__Secure-` or `__Http-` (any
  case). Each was checked against the Chromium build playwright-core pins
  (156) and the one CI installs (158). A browser error whose `message` cannot even be read
  now still gets the fixed message. (#78)

## [0.3.0] - 2026-11-03

`trawl` can now press buttons before it reads a page (`--click`), backs off an
origin that answers 429/503, and paces requests to one origin across runs. It
also finds the browser that Playwright's own installer downloads on x64 Linux,
and `trawl login` no longer needs a profile path chosen up front.

### Added

- **Click steps.** `--click <css>` (repeatable, run in the order given)
  presses the first visible match after the page loads and before
  extraction, so content behind a "show more", a details panel or a
  transcript pane can be read with `-s/--selector`. `--then-wait <css>` after
  a `--click` blocks until that selector appears. Each click waits for its
  element up to `--timeout`, then `--settle` (at least 250 ms); a selector
  that never appears fails the run (exit 1) naming the step. Once a click has
  happened, any navigation to another page for the rest of the run (a link,
  a form submit, a popup or `target=_blank` link, a delayed `location`
  change) is stopped before the request leaves, and fails the run, so one
  run still fetches one page. Library: `render(url, { click: ["#a", {
  selector: "#b", waitFor: "#c" }] })`, rejecting with a `ClickError`. The
  MCP server stays click-free on purpose. (#56)
- **Per-origin cooldown after 429/503.** When a page navigation answers
  `429` or `503`, `trawl` still returns the page (exit 22) and records a
  cooldown for the origin: until its `Retry-After` (delta-seconds or
  HTTP-date), else 60 s doubling per consecutive failure, capped at 1 h.
  Until it ends, a later call to that origin is refused before `robots.txt`
  or any browser launch, with **exit code 4**, empty stdout and a message
  naming the origin, UTC expiry and time left; library `render()` rejects
  with an exported `CooldownError`. A 2xx page or 24 h without a failure
  resets the backoff. Only top-level navigation responses count, never
  subresources, iframes or `robots.txt`; a `networkidle`-fallback retry into
  a fresh cooldown is skipped. `--ignore-cooldown` (library
  `ignoreCooldown: true`) overrides the refusal for one call but still
  records new failures. State lives beside the pacing state under
  `cooldown/`, with a per-origin lock so concurrent runs never shorten a
  cooldown or let an older success erase a newer failure; an unusable state
  directory warns and keeps cooldowns in-run only. The new library option
  `stateDir` sets the directory for both (`pacingStateDir` still works).
  (#39)
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

- `trawl login <origin>` defaults to a shared `~/.trawl/profile` (created on
  first use, announced on stderr) when neither `--profile` nor
  `$TRAWL_PROFILE_DIR` is set. Explicit values still win. Plain `trawl <url>`
  fetches stay ephemeral. (#25)
- `--help` and the README document `--wait-until domcontentloaded --settle
  15000` as the workaround for anti-bot interstitials that hold `networkidle`
  open. (#25)

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

[Unreleased]: https://github.com/rjwalters/trawl/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/rjwalters/trawl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rjwalters/trawl/releases/tag/v0.2.0
[0.1.0]: https://github.com/rjwalters/trawl/releases/tag/v0.1.0
