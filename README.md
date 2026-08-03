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
npm install -g trawl-cli
npx --yes playwright install chromium --only-shell   # one-time browser fetch
```

`trawl` depends on `playwright-core`, not the full `playwright` package, so
installing it does not download a browser. It will use, in order: an
explicit `--executable-path`, `$TRAWL_EXECUTABLE_PATH`, a cached
`chrome-headless-shell`, then a system Chrome/Chromium.

## Usage

```
trawl <url> [options]

  -f, --format <fmt>       text | html | links | title      (default: text)
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
  -S, --show-status        Print HTTP status + final URL to stderr
```

```sh
trawl https://example.com/spa                      # rendered text
trawl https://example.com -f links                 # href<TAB>text, one per line
trawl https://example.com -s '#main' -f html       # one subtree, as HTML
trawl https://example.com -w '.loaded' --settle 500
trawl https://example.com --har trace.har          # + the full network trace
trawl https://example.com --screenshot page.png --full-page   # text + a PNG
```

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

Exit codes: `0` success, `22` page returned 4xx/5xx (as `curl --fail`), `1`
usage or runtime error.

### As a library

```js
import { render } from "trawl-cli";

const { body, status } = await render("https://example.com", { format: "text" });
```

`render()` consults `robots.txt` for `http(s)` URLs before it navigates, and
throws if the path is disallowed — the same default the CLI has. Pass
`{ ignoreRobots: true }` to skip it. Non-`http(s)` URLs (`file://`, for
instance) are never checked. It also sends the default trawl `User-Agent`
unless you pass your own `userAgent`.

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

Early. v0.1.0 does one thing: render a URL and extract text/HTML/links.
HAR capture, Markdown output, and an MCP server are the next milestones —
see the [issues](https://github.com/rjwalters/trawl/issues).

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
