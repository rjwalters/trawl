# Work Log

Chronological record of merged PRs and closed issues, newest first.
Maintained by the Loom Guide role; entries are appended automatically.

### 2026-11-14

- **PR #121**: test: share the browser guard, runBin and assertNoValue via tests/helpers.mjs
- **PR #117**: feat: accept wait_until, settle_ms and timeout_ms on the MCP tools
- **PR #114**: feat: honour `*` wildcard and `$` end anchor in robots.txt rule paths
- **Issue #118** (closed): Deduplicate the haveBrowser test guard into one helper, and make it actually check launchability
- **Issue #115** (closed): Consolidate duplicated test helpers into tests/helpers.mjs (7 copies of the browser skip guard, 5 of runBin, 3 drifted assertNoValue)
- **Issue #110** (closed): MCP: accept wait_until, settle_ms and timeout_ms on fetch_page and fetch_links
- **Issue #109** (closed): robots.txt: support `*` and `$` in Allow/Disallow paths (RFC 9309 section 2.2.3)

### 2026-11-12

- **PR #105**: Bump Repo Skills 0.26.0 -> 0.26.1

### 2026-11-10

- **PR #104**: chore: repo hygiene — README har-redact note, Repo Skills 0.26.0, Loom 0.19.1285
- **PR #103**: chore: release 0.4.0
- **Issue #100** (closed): login: warn when the profile's browser marker will be ignored (group/other-writable)
- **PR #102**: fix(login): warn when the profile's browser marker will be ignored
- **Issue #97** (closed): Robots redirect hint appears on a Disallow verdict and suggests fetching the other origin
- **PR #101**: fix(robots): keep the cross-origin redirect hint off rule denials
- **PR #99**: fix(login): marker follow-ups from the #98 review
- **Issue #95** (closed): trawl login launches chrome-headless-shell, so no window ever appears (and it says one did)
- **Issue #96** (closed): trawl login never finishes on macOS when the user closes the window
- **PR #98**: fix(login): open a headed browser and finish when the window closes
- **Issue #93** (closed): Profile robots request sends partitioned cookies; README/CHANGELOG still describe the context.request design
- **PR #94**: fix(robots): keep partitioned cookies off the --profile robots request; README/CHANGELOG match main
- **Issue #89** (closed): --profile robots.txt check is refused when the profile holds a cookie above U+00FF (ERR_INVALID_CHAR)
- **PR #90**: fix(robots): send robots.txt cookies as UTF-8 bytes via Node fetch on --profile
- **Issue #91** (closed): Robots Cookie header: library cookies with ';' in a value or '=' in a name reach robots.txt mis-split
- **PR #92**: fix(cookies): omit ; and name = cookies from the robots.txt Cookie header
- **Issue #36** (closed): Import browser cookies (HAR / cookies.txt / cURL) into a profile, with auth-cookie stripping by default
- **Issue #87** (closed): Robots Cookie header: invalid header values break --cookies fetches and leak cookie content in the error
- **PR #88**: fix(robots): keep the robots.txt Cookie header fetch-safe and out of errors
- **Issue #84** (closed): Optional redaction of cookie headers in --har output (--cookies and --profile)
- **PR #85**: feat(har): add opt-in --har-redact for cookie and credential values
- **Issue #79** (closed): Cookie import 4/4: send imported cookies on the robots.txt request
- **PR #86**: feat(robots): send the fetch's cookies on the robots.txt request
- **Issue #78** (closed): Cookie import 3/4: --cookies <file> on fetch
- **PR #83**: feat(cli): add trawl <url> --cookies <file> for a one-off fetch
- **Issue #77** (closed): Cookie import 2/4: trawl cookies import --profile
- **PR #82**: feat(cli): add trawl cookies import --profile
- **Issue #76** (closed): Cookie import 1/4: src/cookies.mjs parsers, filters and auth-cookie deny list
- **PR #81**: feat: add cookies module with HAR/Netscape/cURL parsers, filters and redacting summary
- **Issue #74** (closed): Add a test that the README usage block and MCP tool table match the CLI and MCP schema
- **PR #80**: test: pin README usage block and MCP tool table to --help and TOOLS

### 2026-11-07

- **PR #75**: Bump Repo Skills 0.25.7 -> 0.25.10

### 2026-11-05

- **Issue #71** (closed): Make package.json engines match the Node versions CI tests (drop EOL Node 20)
- **PR #73**: chore: require Node 22 or newer in engines
- **Issue #70** (closed): Add direct unit tests for src/state.mjs createFileLock eviction rules
- **PR #72**: test: add direct unit tests for state.mjs lock, atomic write and origin keys

### 2026-11-04

- **PR #69**: chore: update Loom 0.19.1262 → 0.19.1263 and Repo Skills 0.25.5 → 0.25.7
- **Issue #67** (closed): Align .github/dependabot.yml with org dependency policy (cooldown, labels, schedule)
- **PR #68**: chore(deps): align dependabot.yml with org dependency policy
- **PR #66**: docs: list -h/--help and -v/--version in the README usage block
- **PR #65**: chore: update Loom 0.18.0 → 0.19.1262 and Repo Skills 0.7.0 → 0.25.5
- **PR #63**: chore: date the 0.3.0 changelog for release
- **Issue #58** (closed): Pacing timing tests are flaky on loaded CI runners
- **PR #62**: test: assert pacing on recorded stamps, not start() times
- **Issue #40** (closed): Champion: Merge-Risk Hold Digest
- **Issue #39** (closed): Record a per-origin cooldown after 429/503 and refuse requests until it expires
- **PR #61**: Record a per-origin cooldown after 429/503 and refuse requests until it expires
- **PR #53**: chore(deps): Bump fast-uri from 3.1.7 to 3.1.9
- **Issue #43** (closed): tests/robots.test.mjs contains literal NUL/SOH bytes, so git treats it as binary
- **PR #60**: test(robots): escape raw NUL/SOH bytes in the garbage-input test
- **PR #45**: chore(deps): Bump the minor-and-patch group across 1 directory with 2 updates
- **PR #47**: chore(deps): Bump proxy-addr from 2.0.7 to 2.0.8
- **PR #48**: chore(deps): Bump hono from 4.13.7 to 4.13.16
- **PR #49**: chore(deps): Bump @modelcontextprotocol/sdk from 1.30.1 to 1.32.0
- **PR #52**: chore(deps): Bump ip-address from 10.7.2 to 10.7.4
- **PR #54**: chore(deps): Bump body-parser from 2.3.0 to 2.4.0
- **PR #55**: chore(deps): Bump zod from 4.4.3 to 4.6.7
- **PR #59**: chore(deps): Bump @hono/node-server from 2.0.12 to 2.1.6
- **Issue #56** (closed): Add a click step (--click <css>) to press buttons before extraction
- **PR #57**: Add --click steps to press elements before extraction

### 2026-10-23

- **Issue #50** (closed): Pin workflow Node runtime to October security releases
- **PR #51**: fix(security): pin patched Node workflow runtimes
