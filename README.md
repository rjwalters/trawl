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
trawl mcp                  Serve fetch_page/fetch_links over MCP (stdio)

  -f, --format <fmt>       text | html | links | title | markdown (md)
                                                               (default: text)
      --no-readability     Skip article extraction for -f markdown
  -s, --selector <css>     Extract only this element
  -w, --wait-for <css>     Block until this selector appears
      --settle <ms>        Extra pause after load                (default: 0)
      --wait-until <ev>    load | domcontentloaded | networkidle
                                                        (default: networkidle)
      --timeout <ms>       Navigation/selector timeout       (default: 30000)
  -o, --output <file>      Write to a file instead of stdout
  -A, --user-agent <ua>    Override the User-Agent
      --har <file>         Write a HAR 1.2 network trace to this file
      --har-omit-content   Record HAR metadata only, no response bodies
      --executable-path <p>  Chromium binary to use
      --screenshot <file>  Also write a PNG screenshot to this path
      --full-page          Screenshot the whole scroll height
      --viewport <WxH>     Viewport size, e.g. 1280x800     (default: 1280x2000)
      --ignore-robots      Skip the robots.txt check
      --profile <dir>      Persistent browser profile (cookies/localStorage
                            survive across runs); also $TRAWL_PROFILE_DIR
      --no-auth-check      Skip login-wall detection (see "Auth walls" below)
  -S, --show-status        Print HTTP status + final URL to stderr
```

```sh
trawl https://example.com/spa                      # rendered text
trawl https://example.com -f links                 # href<TAB>text, one per line
trawl https://example.com -s '#main' -f html       # one subtree, as HTML
trawl https://example.com -f md                    # article, as Markdown
trawl https://example.com -w '.loaded' --settle 500
trawl https://example.com --har trace.har          # + the full network trace
trawl https://example.com --screenshot page.png --full-page   # text + a PNG
trawl login https://example.com --profile ~/.trawl/example    # sign in once
trawl https://example.com --profile ~/.trawl/example           # reuse the session
```

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

The trace is flushed when the browser context closes, so a run that fails
mid-navigation (timeout, DNS failure, connection refused) still leaves a
valid HAR behind — usually the run you most wanted to see.

### Screenshots

`--screenshot` composes with the normal output rather than replacing it: one
page load yields both the text on stdout and the PNG on disk. `--full-page`
captures the whole scroll height instead of just the viewport, and
`--viewport <WxH>` sets the window size the page is rendered at.

Exit codes: `0` success, `22` page returned 4xx/5xx (as `curl --fail`), `3`
page appears to be behind a login wall (see "Auth walls" below), `1` usage or
runtime error.

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

`trawl login` needs a real, headed-capable Chrome/Chromium —
`chrome-headless-shell` (the default cached binary) cannot open a window, so
point `--executable-path` at a system browser if that's all you have
installed.

### As a library

```js
import { render } from "@rjwalters/trawl";

const { body, status } = await render("https://example.com", { format: "text" });
```

`render()` consults `robots.txt` for `http(s)` URLs before it navigates, and
throws if the path is disallowed — the same default the CLI has. Pass
`{ ignoreRobots: true }` to skip it. Non-`http(s)` URLs (`file://`, for
instance) are never checked. It also sends the default trawl `User-Agent`
unless you pass your own `userAgent`.

`render()` also rejects with an `AuthWallError` (`err.name ===
"AuthWallError"`, `err.reasons` is the list of matched signals) when the
rendered page looks like a login wall — pass `{ authCheck: false }` to skip
the check. Pass `{ profileDir: "<dir>" }` to render through a persistent
browser profile instead of a fresh one each call, the library equivalent of
`--profile`.

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

Two tools, and nothing that clicks, types, or navigates a session:

| Tool | Arguments |
| --- | --- |
| `fetch_page` | `url`, `format?` (`text`\|`html`\|`links`\|`title`\|`markdown`), `selector?`, `wait_for?` |
| `fetch_links` | `url`, `selector?` |

`fetch_links` exists separately so an agent can crawl without pulling whole
page bodies into its context. Results longer than 100,000 characters are
truncated with a notice saying so; set `TRAWL_MCP_MAX_CHARS` to change the
budget. A failed fetch comes back as a tool error — the server keeps serving.

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
  end-anchor (`$`) patterns are not supported. If `robots.txt` can't be
  fetched — network error, timeout, 404, any non-2xx — the path is treated
  as allowed; this is politeness, not a security boundary.
- **`--ignore-robots` overrides it**, because there are legitimate reasons:
  your own staging site, a page you are authenticated to, a `robots.txt`
  that blocks all bots but permits the human reading the same URL.
- **`Crawl-delay` is honored** as a pause between the `robots.txt` request
  and the page request. `trawl` fetches one page per run, so that is the
  only gap there is to space out. It is capped at 60s so a `Crawl-delay:
  86400` can't hang the tool.
- **It identifies itself**: the default `User-Agent` is
  `trawl/<version> (+https://github.com/rjwalters/trawl)`, so an operator
  reading their logs can see what hit them and block it if they want.
  `-A`/`--user-agent` still overrides it.

Beyond that: don't point it at a site faster than you'd click, and respect
Terms of Service. It ships no proxy rotation, no fingerprint spoofing, and
no CAPTCHA solving, and it won't.

## License

MIT © 2026 Robb Walters
