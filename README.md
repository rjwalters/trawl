# trawl

**curl for the JavaScript web.**

`curl` gives you the HTML the server sent. For a client-rendered app that's
an empty `<div id="root">`. `trawl` renders the page in headless Chromium
first, then prints what a human would actually see.

```console
$ curl -s 'https://qwen.ai/blog?id=qwen3.8' | wc -w
1

$ trawl 'https://qwen.ai/blog?id=qwen3.8' | wc -w
5068
```

## Install

Requires Node 22 or newer.

```sh
npm install -g @rjwalters/trawl
npx --yes playwright install chromium --only-shell   # one-time browser fetch
```

`trawl` depends on `playwright-core`, not the full `playwright` package, so
installing it does not download a browser. It will use, in order: an
explicit `--executable-path`, `$TRAWL_EXECUTABLE_PATH`, a cached
`chrome-headless-shell`, then a system Chrome/Chromium.

## Usage

```
trawl <url> [options]
trawl login <origin>       Open a headed browser to sign in; saves the
                            session to --profile <dir> / $TRAWL_PROFILE_DIR
                            (defaults to ~/.trawl/profile)
trawl cookies import <file> --profile <dir>
                            Copy cookies from a HAR, a Netscape cookies.txt
                            or a copy-as-cURL command into a profile (below)
trawl mcp                  Serve fetch_page/fetch_links over MCP (stdio)

  -f, --format <fmt>       text | html | links | title | markdown (md)
                                                               (default: text)
      --no-readability     Skip article extraction for -f markdown
  -s, --selector <css>     Extract only this element
  -w, --wait-for <css>     Block until this selector appears
      --click <css>        Click the first match after load, before
                            extracting. Repeatable; runs in the order given.
                            Each waits until visible (up to --timeout), then
                            --settle (at least 250ms). Fails (exit 1) if it
                            never appears, or if a click would load another
                            page.
      --then-wait <css>    After the preceding --click, block until this
                            selector appears
      --settle <ms>        Extra pause after load                (default: 0)
      --wait-until <ev>    load | domcontentloaded | networkidle
                                                        (default: networkidle)
      --timeout <ms>       Navigation/selector timeout       (default: 30000)
  -o, --output <file>      Write to a file instead of stdout
  -A, --user-agent <ua>    Override the User-Agent
      --har <file>         Write a HAR 1.2 network trace to this file.
                            It records cookie headers, values included, for
                            any fetch that sends cookies (--cookies or
                            --profile)
      --har-omit-content   Record HAR metadata only, no response bodies
                            (cookie headers and values are still recorded)
      --executable-path <p>  Chromium binary to use
      --screenshot <file>  Also write a PNG screenshot to this path
      --full-page          Screenshot the whole scroll height
      --viewport <WxH>     Viewport size, e.g. 1280x800     (default: 1280x2000)
      --ignore-robots      Skip the robots.txt check (not --min-interval)
      --min-interval <ms>  Minimum gap between requests to one origin,
                            across separate runs; Crawl-delay still wins if
                            larger. 0 drops the floor only. Max 60000.
                                                             (default: 1000)
      --no-pacing          Don't pace requests across runs (Crawl-delay is
                            still honored within a run). Pacing state lives
                            in $TRAWL_STATE_DIR, else
                            ${XDG_CACHE_HOME:-~/.cache}/trawl
      --ignore-cooldown    Fetch even if the origin is cooling down after a
                            429/503 (see exit code 4). Bypasses the refusal
                            only: robots.txt and pacing still apply, and a
                            new 429/503 is still recorded.
      --profile <dir>      Persistent browser profile (cookies/localStorage
                            survive across runs); also $TRAWL_PROFILE_DIR.
                            Populate one with "trawl login" (which defaults
                            this to ~/.trawl/profile, shared across every
                            origin, if you don't pass --profile/
                            $TRAWL_PROFILE_DIR there either). A plain fetch
                            stays isolated (no persistence) unless you pass
                            --profile/$TRAWL_PROFILE_DIR here too.
      --cookies <file>     Send the cookies from a HAR, a Netscape
                            cookies.txt or a copy-as-cURL command with this
                            one fetch; no profile or cookie store is written
                            (but --har records them). Filtered as cookies
                            import is (below: same defaults, and --domain,
                            --allow, --include-auth work here too). Prints
                            names/domains/expiry to stderr under -S, or when
                            any were dropped; never values. Not with
                            --profile/$TRAWL_PROFILE_DIR: use cookies import
                            to keep them. The robots.txt request carries
                            the ones that match it.
      --no-auth-check      Skip login-wall detection (see "Auth walls" below)
  -S, --show-status        Print HTTP status + final URL to stderr
  -h, --help               Show this help
  -v, --version            Show version

Cookie import (trawl cookies import <file>):
                            Writes the file's cookies into --profile <dir>
                            (or $TRAWL_PROFILE_DIR; required, no default) for
                            a later "trawl <url> --profile <dir>". Prints
                            names, domains and expiry only, never values.
                            Session cookies are kept for 7 days. Expired
                            cookies are dropped, and so are sign-in
                            cookies (best-effort list: AUTH_COOKIES in
                            src/cookies.mjs). Cookies the browser would
                            refuse are skipped by name. If none are left,
                            nothing is written and the exit code is 1.
                            Delete the source file afterwards.
                            These three filters also apply to --cookies:
      --domain <host>      Only cookies that would be sent to this host
      --allow <names>      Only these cookie names (comma-separated)
      --include-auth       Keep sign-in cookies too
```

```sh
trawl https://example.com/spa                      # rendered text
trawl https://example.com -f links                 # href<TAB>text, one per line
trawl https://example.com -s '#main' -f html       # one subtree, as HTML
trawl https://example.com -f md                    # article, as Markdown
trawl https://example.com -w '.loaded' --settle 500
trawl https://example.com --click '#show-details' --then-wait '#details' -s '#details'
trawl https://example.com --har trace.har          # + the full network trace
trawl https://example.com --screenshot page.png --full-page   # text + a PNG
trawl login https://example.com --profile ~/.trawl/example    # sign in once
trawl https://example.com --profile ~/.trawl/example           # reuse the session
trawl cookies import cookies.txt --profile ~/.trawl/example    # or bring cookies
trawl https://example.com --cookies cookies.txt                # or just this once
```

### Clicking before extraction

Some content only exists after a person presses something: a "show more", an
expandable details panel, a transcript pane. `--click <css>` presses it.
After the page loads (and any `--wait-for` / `--settle`), each `--click` waits
for the first element matching its selector to become visible, clicks it,
then pauses for `--settle` (at least 250 ms after each click). Repeat the flag to click several things; they run
in the order given. Extraction (`-s`, `-f`) then reads the page as usual:

```sh
trawl https://example.com/video --click 'button.show-transcript' \
      --then-wait '#transcript' -s '#transcript'
```

`--then-wait <css>` belongs to the `--click` right before it, and blocks until
that selector is visible — for a panel that loads its contents after the
click. Pair them by writing them next to each other; a `--then-wait` with no
`--click` before it, or two for one click, is a usage error.

A selector that never shows up within `--timeout` fails the run with exit
code 1 and names the step (`click step 2 of 3 ("#more"): no visible,
clickable element matched within 30000ms`) rather than handing back a page
that silently lacks what you asked for.

A click only presses an element already on the page. One that would load a
different page — a link, a form submit, a popup or `target=_blank` link, a
script that sets `location` a moment later — is stopped before the request
goes out and fails the run, so a `trawl` run still fetches exactly one page,
and every request it makes stays [paced](#etiquette). Fetch that other URL
directly instead. Once a click has happened the guard stays on for the whole
run, through extraction and `--screenshot`, so a navigation can never swap
in the other page however late it starts; the 250 ms pause after each click
is there so a click handler's short-timer navigation is caught and reported
against the step that caused it. Scripts on the page can still make their
own background requests in response to a click, as they would for a person.

### Markdown

`-f markdown` (alias `md`) runs Mozilla Readability against the rendered page
to drop nav/footer chrome, then converts what's left to Markdown, so headings,
lists, links, and fenced code all survive. Readability is tuned for articles
and can eat the content on docs sites and single-column apps — pass
`--no-readability` to convert the page as-is, or use `-f text`, which is never
filtered.

### Pages that never go idle

The default `--wait-until networkidle` waits for the page to stop making
network requests — but a SPA that holds a websocket, SSE stream, or
long-poll open (common on chat/dashboard apps) never goes idle, so the
default times out even though the page rendered ages ago. On a
`networkidle` timeout specifically, `trawl` retries once with
`domcontentloaded` instead of failing outright, and says so on stderr:

```
trawl: networkidle timed out; retried with domcontentloaded. Pass
       --wait-until domcontentloaded --settle <ms> to skip the wait next time.
```

If you already know a site does this, skip straight to it:
`--wait-until domcontentloaded --settle 2000` (or whatever grace period the
page needs to finish painting).

The same recipe also works around **anti-bot interstitials** — a "checking
your browser" / "this website uses a security service" page that some sites
(HathiTrust's full-view search among them) serve behind a socket that never
goes idle, so the default `networkidle` wait hangs on the interstitial
itself rather than the real page. `trawl` does not detect or auto-retry past
these (they vary too much by vendor to do reliably); pass
`--wait-until domcontentloaded --settle 15000` (give the interstitial's own
JS challenge time to resolve and redirect) to get through it.

### HAR capture

`--har <file>` records every request the page made — URLs, methods, status
codes, headers, timings and response bodies — as a HAR 1.2 archive, written
alongside the normal stdout output. Drop the file into Chrome DevTools'
Network panel (or Firefox, Charles, Fiddler) to inspect it, or parse it as
JSON to reverse-engineer the API a SPA is talking to.

Response bodies are embedded in the file, so it is self-contained and
portable. That also makes it large, and means it saves whatever the page
loaded — `--har-omit-content` keeps the requests and timings but drops the
bodies.

The trace also records cookies, values included: each request's `Cookie`
header and parsed cookies, and each response's `Set-Cookie`. So for any
fetch that sends cookies — with `--cookies` or from a `--profile` — the HAR
file holds those cookie values in plain text, sign-in cookies too, and
`--har-omit-content` does not remove them. Treat such a HAR like the cookie
file itself. `--cookies` together with `--har` prints a warning saying so.
The `robots.txt` request is not in the HAR on either path: with `--cookies`
it is made outside the browser, and with `--profile` it goes through the
browser context's own request client, which Playwright's HAR recorder does
not capture.

The trace is flushed when the browser context closes, so a run that fails
mid-navigation (timeout, DNS failure, connection refused) still leaves a
valid HAR behind — usually the run you most wanted to see.

### Screenshots

`--screenshot` composes with the normal output rather than replacing it: one
page load yields both the text on stdout and the PNG on disk. `--full-page`
captures the whole scroll height instead of just the viewport, and
`--viewport <WxH>` sets the window size the page is rendered at.

Exit codes: `0` success, `22` page returned 4xx/5xx (as `curl --fail`), `3`
page appears to be behind a login wall (see "Auth walls" below), `4` the
origin is cooling down after a 429/503 and nothing was requested (see
[Etiquette](#etiquette); `--ignore-cooldown` overrides), `1` usage or runtime
error.

### Auth walls & signed-in sessions

A client-rendered page that requires sign-in usually still returns `200 OK`
and *some* body — just not the content you asked for. Rather than hand that
back indistinguishably from a real page, `trawl` checks the rendered result
for the shape of a login wall and, if it matches, fails with **exit code 3**
and a one-line explanation on stderr instead of printing the login page as if
it were the answer:

```console
$ trawl https://example.com/gated
trawl: page appears to be behind a login wall (matched: tiny text (66 chars)
       contains "sign in"). This page needs an authenticated browser
       session — ask your user to sign in with `trawl login <origin>
       --profile <dir>`, then retry with --profile <dir> (or pass
       --no-auth-check if this isn't actually a login wall).
```

The check is heuristic and deliberately biased toward false positives —
missing a real login wall (and quietly returning its HTML as "content") is
worse than occasionally flagging a genuinely tiny page. It looks at three
signals: the *extracted* text is short (under ~200 characters) and contains
sign-in vocabulary ("sign in", "log in", "authenticate", …); the rendered
page has a `<form>` with a password field; or the final URL matches a known
login path (`/login`, `/signin`, `/oauth2/…`) or auth provider
(`accounts.google.com`, and similar). Pass `--no-auth-check` /
`{ authCheck: false }` for a page you know isn't actually gated.

To give `trawl` a session to reuse, hand it a **persistent browser profile**
with `--profile <dir>` (or `$TRAWL_PROFILE_DIR`) — cookies and `localStorage`
written under that directory survive across separate `trawl` invocations,
the same way a real browser profile does. Populate one interactively with
`trawl login`, which opens a *headed* browser at the given origin and waits
for you to sign in (close the window, or press Enter in the terminal, when
you're done):

```sh
trawl login https://example.com --profile ~/.trawl/example
trawl https://example.com --profile ~/.trawl/example   # now sees the session
```

If you don't pass `--profile`/`$TRAWL_PROFILE_DIR` to `trawl login`, it
defaults to a single shared directory, `~/.trawl/profile` (created on first
use), so you don't have to invent a path before you know what it's for —
the tradeoff is that every origin logged into this way shares one cookie
jar, same as a real browser's default profile. A plain `trawl <url>` fetch,
by contrast, stays isolated (no persistence) unless you pass
`--profile <dir>` yourself — pass the same `~/.trawl/profile` path to reuse
the default session, or a dedicated directory to isolate one site's session.

`trawl login` needs a real, headed-capable Chrome/Chromium —
`chrome-headless-shell` (the default cached binary) cannot open a window, so
point `--executable-path` at a system browser if that's all you have
installed.

#### Importing cookies from another browser

When signing in through `trawl login` isn't practical, `trawl cookies import`
copies cookies you exported elsewhere into a profile. It reads a **HAR** (your
browser's devtools "Save all as HAR", or `trawl --har`), a **Netscape
`cookies.txt`** (from a cookie-export extension, or `curl -c`), or a
**copy-as-cURL** command, and works out which from the content:

```sh
trawl cookies import ~/Downloads/cookies.txt --profile ~/.trawl/example \
      --domain example.com
trawl https://example.com --profile ~/.trawl/example   # presents them
```

It prints each imported cookie's name, domain and expiry, never its value,
and reports what it dropped:

- **Expired cookies** are dropped.
- **Session cookies** (no expiry of their own, which is every cookie a HAR
  request or a cURL command carries) are stored with a 7-day expiry, because
  a browser profile only keeps cookies that have one.
- **Sign-in cookies are dropped by default.** Session and account cookies
  (Google's `SID` family, `PHPSESSID`, GitHub's `user_session`, and so on)
  are the ones that act as your login, so `trawl` leaves them behind unless
  you pass `--include-auth`. The list (`AUTH_COOKIES` in `src/cookies.mjs`) is
  **best-effort**: a site can call its session cookie anything, so treat
  "not dropped" as "not recognised", not as "safe".
- **Cookies the browser would refuse** (a `;` or control character in the
  name or value, over 4096 bytes, a `__Host-`/`__Secure-` cookie that breaks
  its prefix rules, and so on) are skipped and listed by name. Chromium
  rejects the whole batch over a single bad cookie, so letting one through
  would import nothing at all.
- `--domain <host>` keeps only cookies that would be sent to that host, and
  `--allow a,b` only the cookies with those exact names.

`--profile` (or `$TRAWL_PROFILE_DIR`) is required; there is no default. The
cookies go through Chromium into the profile's own encrypted store, never into
a plaintext file, and a profile directory `trawl` creates is made `0700` (an
existing one keeps its mode). Nothing is written until the file has parsed and
at least one cookie is left after filtering; otherwise the command exits 1,
says which filter removed them, and the profile is untouched. If the browser
then fails to start or refuses the write, nothing is imported; the error says
so but never repeats the browser's own message, which can quote a cookie.

**Delete the source file once the import is done.** It still holds every
cookie it was exported with, sign-in cookies included, in plain text; `trawl`
reminds you after each import.

When a HAR or cURL source records the browser it came from, `trawl` warns if
that is not `trawl` itself: it identifies itself honestly as `trawl/<version>`,
and some sites bind cookies to the client that received them, so a session
may not carry over.

#### Cookies for a single fetch

To use exported cookies for one fetch without keeping them anywhere, pass the
file to `--cookies`. It takes the same three formats and applies the same
filters as `trawl cookies import` (expired and sign-in cookies dropped unless
`--include-auth`, cookies the browser would refuse skipped by name,
`--domain` and `--allow` to narrow it), with two differences:

```sh
trawl https://example.com/account --cookies ~/Downloads/cookies.txt \
      --domain example.com
```

- **No cookie store is written.** The cookies go into the fetch's throwaway
  browser context and are gone when it closes; no profile, temp file or
  cookie store is written. So session cookies stay session cookies here:
  there is no 7-day expiry, because there is no store for them to survive
  in. The one exception is a file you ask for: `--har` records the cookies
  it sends, values included, and `--har-omit-content` does not change that
  (see [HAR capture](#har-capture)). `--cookies` with `--har` warns on
  stderr, naming the HAR file but no value.
- **Not together with a profile.** `--cookies` with `--profile` (or with
  `$TRAWL_PROFILE_DIR` set) is an error, since the profile would keep the
  cookies; use `trawl cookies import` for that, or unset the variable for
  the run.

It stays quiet unless something needs saying: the names, domains and expiry
of the cookies used (never their values) go to stderr under `-S`, or
whenever a cookie was dropped or skipped, so a sign-in cookie that was left
behind never goes unnoticed. A file that cannot be read or parsed, or that
leaves no cookie to use, exits 1 before any request is made, robots.txt
included, and before a browser starts. If the browser refuses the cookies,
the error says so without repeating the browser's message. `--domain`,
`--allow` and `--include-auth` without `--cookies` are an error.

The `robots.txt` request carries the cookies that match it, so a site whose
`robots.txt` itself answers a 5xx to a cookie-less client (which trawl treats
as a full disallow) no longer needs `--ignore-robots`. "Match" is what a
browser would send to `<origin>/robots.txt`: a host-only cookie only for its
exact host, a `.example.com` cookie for that domain and its subdomains, a
path of `/` or `/robots.txt`, a `Secure` cookie only over `https`, nothing
expired. If none match, the request has no `Cookie` header at all. A redirect
to another origin does not carry the header along.

`--cookies` is a CLI flag only: the MCP server's tools take no cookies.

### As a library

```js
import { render } from "@rjwalters/trawl";

const { body, status } = await render("https://example.com", { format: "text" });
```

`render()` consults `robots.txt` for `http(s)` URLs before it navigates, and
throws if the path is disallowed or `robots.txt` is unreachable (5xx, network
error, timeout) — the same default the CLI has. Pass
`{ ignoreRobots: true }` to skip it. Non-`http(s)` URLs (`file://`, for
instance) are never checked. It also sends the default trawl `User-Agent`
unless you pass your own `userAgent`.

`render()` also rejects with an `AuthWallError` (`err.name ===
"AuthWallError"`, `err.reasons` is the list of matched signals) when the
rendered page looks like a login wall — pass `{ authCheck: false }` to skip
the check. Pass `{ profileDir: "<dir>" }` to render through a persistent
browser profile instead of a fresh one each call, the library equivalent of
`--profile`.

`{ cookies: [...] }` is the library side of `--cookies`: Playwright cookie
objects (`name`, `value`, `domain`, `path`, `expires`, `httpOnly`, `secure`),
already parsed and filtered (`parseCookies`, `filterCookies` and
`browserWouldReject` in `src/cookies.mjs` do that), added to the context
before the page loads and passed through unchanged. With `profileDir` as well
they are written into that profile. If the browser refuses them, `render()`
rejects with a fixed message that never quotes the browser's error.

`render()` accepts the same click steps as `{ click: [...] }`: each entry is
a CSS selector string, or `{ selector, waitFor }` for the `--then-wait` form.
A step that cannot run rejects with a `ClickError` (`err.name ===
"ClickError"`, with `err.step` counted from 1, `err.selector` and
`err.waitFor`).

```js
const { body } = await render("https://example.com/video", {
  click: ["button.show-transcript", { selector: "#more", waitFor: "#line-40" }],
  selector: "#transcript",
});
```

`render()` paces its `http(s)` requests across calls and processes the same
way the CLI does (see [Etiquette](#etiquette)): `{ minIntervalMs }` sets the
per-origin floor (default 1000, 0–60000), `{ pacing: false }` turns
cross-run pacing off, and `{ stateDir }` overrides where the state is
kept (default `$TRAWL_STATE_DIR`, else `${XDG_CACHE_HOME:-~/.cache}/trawl`;
the older `{ pacingStateDir }` still moves the pacing state alone). A request
to an origin that is cooling down after a 429/503 rejects with a
`CooldownError` (exported; `code: "TRAWL_COOLDOWN"`, with `origin`, `until`
in epoch ms, and `remainingMs`) before any network or browser work;
`{ ignoreCooldown: true }` overrides it for that call.

### As an MCP server

`trawl mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server, so
any agent that speaks MCP gets the same rendering the CLI does instead of the
empty shell a plain `WebFetch` sees.

```json
{
  "mcpServers": {
    "trawl": { "command": "trawl", "args": ["mcp"] }
  }
}
```

Two tools, and nothing that clicks, types, or navigates a session. That is
deliberate: the CLI and library offer `--click` for a selector a person chose,
while the MCP server stays read-only so an agent reading a page cannot be
talked into pressing things on it.

| Tool | Arguments |
| --- | --- |
| `fetch_page` | `url`, `format?` (`text`\|`html`\|`links`\|`title`\|`markdown`), `selector?`, `wait_for?` |
| `fetch_links` | `url`, `selector?` |

`fetch_links` exists separately so an agent can crawl without pulling whole
page bodies into its context. Results longer than 100,000 characters are
truncated with a notice saying so; set `TRAWL_MCP_MAX_CHARS` to change the
budget. A failed fetch comes back as a tool error — the server keeps serving.
Tool calls are paced per origin with the default 1000 ms floor, shared with
any CLI runs through the same state directory (`$TRAWL_STATE_DIR`).

## Why not X?

- **`curl` / `wget`** — no JavaScript engine, so SPAs come back empty.
- **[domcurl](https://github.com/PaulKinlan/domcurl)** — the same good idea,
  and the direct inspiration for this one. Last published to npm in 2022.
- **[Browsh](https://www.brow.sh)** — renders beautifully, but it's an
  interactive terminal *browser*, not a pipe-friendly fetcher.
- **Firecrawl and friends** — hosted APIs. Good ones; this is the local,
  no-account, no-egress option.
- **Writing 40 lines of Playwright yourself** — what everyone does today,
  including us, repeatedly. That's the itch.

## Status

Early, but the first milestone set has landed: text/HTML/links/title/Markdown
extraction, HAR capture, screenshots, `robots.txt` enforcement, and an MCP
server. See the [issues](https://github.com/rjwalters/trawl/issues) for what's
next.

## Etiquette

`trawl` is a browser you drive from a script, and it behaves like one by
default rather than asking you to promise you will.

- **`robots.txt` is checked before every `http(s)` fetch.** A disallowed
  path fails with the rule that blocked it, naming `--ignore-robots`, and no
  page navigation happens. Matching is the classic baseline: `User-agent`
  group selection (a group naming `trawl` beats `*`), longest matching path
  prefix wins, and `Allow` breaks a tie with `Disallow`. Wildcard (`*`) and
  end-anchor (`$`) patterns are not supported.
- **An unreachable `robots.txt` blocks the run** (RFC 9309 §2.3.1.4). A 5xx,
  a network error (DNS failure, refused connection), a timeout (10s), or a
  response body that fails mid-read is treated as a full disallow, and the
  error says which — e.g. `robots.txt is unreachable: …/robots.txt returned
  HTTP 503 (server error)` — rather than naming a rule. A 4xx (404, 410, 429,
  …) means there is no `robots.txt` to obey, so the path is allowed.
  Redirects are followed and the final response decides. The `robots.txt`
  request sends trawl's `User-Agent`, and the cookies a fetch would present:
  with `--cookies`, the ones that match `<origin>/robots.txt` (see
  [Cookies for a single fetch](#cookies-for-a-single-fetch)); with
  `--profile`, it goes through that profile's browser context, so the
  profile's cookies go with it by the browser's own rules, and a
  `Set-Cookie` on the `robots.txt` response is kept in the profile as any
  response's would be. On that path the browser starts before the
  `robots.txt` check. A plain fetch sends no cookies, so a site that serves
  an interstitial to cookie-less clients can still block it here.
- **`--ignore-robots` overrides it**, because there are legitimate reasons:
  your own staging site, a page you are authenticated to, a `robots.txt`
  that blocks all bots but permits the human reading the same URL, or one
  that is down. It skips the `robots.txt` request entirely.
- **Requests are paced per origin, across runs.** A shell loop of separate
  `trawl` calls is spaced out, not just the requests inside one call. Before
  each request it makes to an origin, `trawl` waits until
  `max(--min-interval, Crawl-delay)` has passed since the last request *any*
  `trawl` process made to that origin (scheme + host + port; paths don't
  matter, and different origins never wait on each other). The minimum
  defaults to **1000 ms**; `--min-interval 0` drops the floor but still
  honors `Crawl-delay`, which is capped at 60s so a `Crawl-delay: 86400`
  can't hang the tool. The last-known `Crawl-delay` is remembered, so the
  next run's `robots.txt` request is paced before the policy is re-read.
  - *What is paced:* the `robots.txt` request, the page navigation, and the
    `domcontentloaded` retry after a `networkidle` timeout. Not paced: the
    page's own subresources (scripts, images, XHR), redirects the browser
    follows, and `trawl login`.
  - *Where state lives:* `$TRAWL_STATE_DIR`, else
    `${XDG_CACHE_HOME:-~/.cache}/trawl/pacing/` — one small JSON file per
    origin (named by a hash of the origin) holding only the last request
    time and `Crawl-delay`. No URLs, cookies, credentials, or page content.
    A missing or corrupt file just means "no prior request".
  - *Concurrency:* a per-origin lock file serializes concurrent `trawl`
    processes, so parallel runs against one site queue up rather than
    stampede. A lock left by a crashed process is recovered automatically;
    if another run holds the lock for more than 120s, `trawl` fails with a
    pacing error rather than sending an unpaced request.
  - *If the state directory is unusable* (read-only, not a directory),
    `trawl` warns on stderr and keeps rendering, pacing only within the
    run — spacing across separate processes is not guaranteed then.
  - *Opting out:* `--no-pacing` (library: `pacing: false`) turns cross-run
    pacing off; `Crawl-delay` is then still honored as a pause between the
    `robots.txt` request and the page request within the one run.
    `--ignore-robots` skips `robots.txt` and its `Crawl-delay`, but not the
    `--min-interval` floor.
- **A 429 or 503 puts the origin on a cooldown, across runs.** When the page
  navigation itself answers `429 Too Many Requests` or `503 Service
  Unavailable`, `trawl` still returns that page (exit `22`), and records
  that the origin asked to be left alone. Until the cooldown ends, every
  later `trawl` call to that origin fails fast with **exit code 4** and a
  message naming the origin, the UTC expiry, and the time left — before the
  `robots.txt` request, before any browser starts, with nothing on stdout.
  - *How long:* the response's `Retry-After`, as delta-seconds or an
    HTTP-date, honored as sent (even beyond an hour); `0` or a past date
    means no wait. Without a usable `Retry-After`, 60 s doubling per
    consecutive 429/503 from that origin — 60 s, 2 min, 4 min, … — capped
    at 1 h. The failure streak outlives the cooldown, so a site that keeps
    failing keeps backing off; a 2xx page response, or 24 h with no
    failure, resets it. Other statuses and network errors leave it alone.
  - *What counts:* only top-level page navigation responses (including the
    `domcontentloaded` retry after a `networkidle` timeout, which is itself
    skipped when the first attempt just put the origin on a cooldown).
    Subresources, iframes, the `robots.txt` request (see above), and
    `trawl login` never record a cooldown. A 429/503 at the end of a
    redirect is recorded against the origin that sent it; the check before
    a run looks only at the origin you asked for, so a redirect into a
    cooling-down origin is not stopped in advance.
  - *Where state lives:* beside the pacing state, in
    `${XDG_CACHE_HOME:-~/.cache}/trawl/cooldown/` (or `$TRAWL_STATE_DIR`,
    library `stateDir`) — one JSON file per origin, named by a hash of it,
    holding only the expiry, the failure count, the last failure's time and
    status, and a revision counter. Updates take a short per-origin lock, so
    concurrent runs never shorten each other's cooldown, and an older run's
    success cannot erase a newer run's failure. Requests already in flight
    when another run records a cooldown are not recalled. A missing or
    corrupt file means "no cooldown"; an unusable directory, or a lock busy
    for more than 5s, warns on stderr and keeps cooldowns for the current
    run only.
  - *Overriding it:* `--ignore-cooldown` (library: `ignoreCooldown: true`)
    sends the request anyway for that one call. It does not delete the
    record, a new 429/503 is still recorded, and `robots.txt` and pacing
    still apply; `--ignore-robots` and `--no-pacing` do not skip the
    cooldown either. To forget every cooldown, delete the `cooldown/`
    directory.
- **It identifies itself**: the default `User-Agent` is
  `trawl/<version> (+https://github.com/rjwalters/trawl)`, so an operator
  reading their logs can see what hit them and block it if they want.
  `-A`/`--user-agent` still overrides it.

Beyond that: don't point it at a site faster than you'd click, and respect
Terms of Service. It ships no proxy rotation, no fingerprint spoofing, and
no CAPTCHA solving, and it won't.

## License

MIT © 2026 Robb Walters
