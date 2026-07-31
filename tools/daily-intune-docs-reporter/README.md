# daily-intune-docs-reporter

`report.mjs` scrapes Microsoft's "What's new" pages for Intune, Windows
Autopilot, and Windows 365, collects everything published inside a strict
window, then writes `report.md` / `report.html` / `report.json` and,
optionally, publishes `report.md` as a daily GitHub issue.

## Requirements

- Node.js 18+ (uses native `fetch`; no dependencies to install)
- A `GITHUB_TOKEN` with `issues: write` on the *target* repo - only needed
  if you pass `--publish`. Reading the source pages needs no token at all.

## Run locally

```bash
node report.mjs                              # generate out/report.{md,html,json} only
GITHUB_TOKEN=ghp_xxx node report.mjs --publish   # also create/refresh the daily issue
```

`--publish` requires `GITHUB_REPOSITORY` to be set to `owner/repo` (GitHub
Actions sets this automatically; set it yourself for local testing).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LOOKBACK_HOURS` | `24` | Size of the report window in hours |
| `TZ_REPORT` | `Europe/Amsterdam` | Timezone for window boundaries, timestamps, and issue titles |
| `OUTPUT_DIR` | `./out` | Where artifacts are written |
| `GITHUB_TOKEN` | - | Auth token for the GitHub REST/Search API (only used by `--publish`) |
| `GITHUB_REPOSITORY` | - | `owner/repo` to publish the issue into (only needed with `--publish`) |

## Why scraping instead of PR search

The original version of this tool searched merged PRs in
`MicrosoftDocs/memdocs` for Intune and Autopilot changes. That approach
doesn't generalize to Windows 365 (its docs are authored in a private repo
with no public PR history), and even for Intune/Autopilot it was really
tracking *doc file* changes rather than *feature* announcements - lots of
noise (typo fixes, metadata updates) mixed in with the things worth
knowing about. Microsoft already curates a "What's new" page per product
that's a better signal, so this tool scrapes those instead.

## Tracked sources

Edit the `WHATS_NEW_SOURCES` array at the top of `report.mjs`:

```js
const WHATS_NEW_SOURCES = [
  { url: 'https://learn.microsoft.com/en-us/intune/whats-new/', label: 'Intune', parser: 'weekly-nested' },
  { url: 'https://learn.microsoft.com/en-us/autopilot/whats-new', label: 'Windows Autopilot', parser: 'dated' },
  { url: 'https://learn.microsoft.com/en-us/windows-365/enterprise/whats-new', label: 'Windows 365 — Enterprise', parser: 'weekly' },
  // add/remove entries for other "What's new" pages
];
```

- `url` - the Learn page to fetch (plain HTTP GET, no auth).
- `label` - used as (part of) the report category.
- `parser` - which of the three heading structures below to use for that
  page. Pages that don't fit one of these need a new parser function.

Each product's "What's new" page is shaped differently, so there's one
parser per shape rather than one generic PR-style config:

| `parser` | Structure | Used by | Date precision |
|---|---|---|---|
| `weekly` | `<h2>Week of ...</h2>` directly followed by `<h3>` items | Windows 365 | Weekly |
| `weekly-nested` | `<h2>Week of ...</h2>` / `<h3>category</h3>` / `<h4>item</h4>` | Intune | Weekly |
| `dated` | `<h2>item</h2>` followed by a `Date added: <em>...</em>` (and optionally `Date updated: <em>...</em>`) paragraph, no weekly grouping | Windows Autopilot | Exact day |

For `weekly`/`weekly-nested` pages, an item only shows up in the report on
the day its "Week of ..." section starts - so most days find nothing for
those products, and once a week (whenever Microsoft publishes) a batch
shows up. `dated` pages (currently just Autopilot) have real per-item
dates, so they behave like a normal daily feed: an item appears the day it
was added, and again if it's later revised ("Date updated" wins over "Date
added" when both fall in-window, so a later edit doesn't get mislabeled as
brand new).

A stray heading that doesn't match the expected date pattern (Microsoft's
own markup isn't perfectly consistent - e.g. an occasional category heading
at the wrong nesting level) is ignored rather than treated as a new week/
item boundary, so it doesn't drop or misplace real content that follows it;
worst case it inherits the previous section's category label.

## How window strictness works

The window is always the most recently completed midnight-to-midnight day in
`TZ_REPORT`, sized to `LOOKBACK_HOURS`. Because this is computed from the
current date rather than "now minus N hours", a late-firing or manually
re-run job on the same calendar day reproduces the exact same window - so
publishing again refreshes the same issue instead of drifting or duplicating.
