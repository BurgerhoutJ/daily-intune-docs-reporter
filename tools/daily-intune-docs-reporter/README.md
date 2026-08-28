# daily-intune-docs-reporter

`report.mjs` checks the git diffs on Microsoft's "What's new" markdown
source files for Intune, Windows Autopilot, and Microsoft Entra via the
GitHub API, extracts newly added headings, then writes `report.md` /
`report.html` / `report.json` and, optionally, publishes `report.md` as a
daily GitHub issue.

## Requirements

- Node.js 18+ (uses native `fetch`; no dependencies to install)
- A `GITHUB_TOKEN` environment variable is required in the script runtime
  to read commits on the source repos and to publish issues.
- In GitHub Actions, the built-in `github.token` is the preferred option
  because the workflow grants the required `issues: write` and `contents: write`
  permissions.

## Run locally

```bash
GITHUB_TOKEN=ghp_xxx node report.mjs                   # generate out/report.{md,html,json} only
GITHUB_TOKEN=ghp_xxx node report.mjs --publish         # also create/refresh the daily issue
```

`--publish` requires `GITHUB_REPOSITORY` to be set to `owner/repo` (GitHub
Actions sets this automatically; set it yourself for local testing).

## GitHub Actions token setup

```yaml
env:
  GITHUB_TOKEN: ${{ github.token }}
  GITHUB_REPOSITORY: ${{ github.repository }}
```

This is the recommended setup for Actions. If you do use a PAT instead, it
must have Issues read/write permission on the target repository.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LOOKBACK_HOURS` | `24` | Size of the report window in hours |
| `TZ_REPORT` | `Europe/Amsterdam` | Timezone for window boundaries, timestamps, and issue titles |
| `OUTPUT_DIR` | `./out` | Where artifacts are written |
| `GITHUB_TOKEN` | - | Auth token for the GitHub API (reads source repos + publishes issues) |
| `GITHUB_REPOSITORY` | - | `owner/repo` to publish the issue into (only needed with `--publish`) |

## How it works

Instead of scraping rendered HTML pages, this tool uses the GitHub Commits
API to find commits that modified the source markdown files within the
report window, then parses the unified diff (patch) to extract added
headings. This means:

- You see exactly what was added (not the full page contents)
- Each item links to the specific commit diff on GitHub
- No HTML parsing or date-string matching required
- Works reliably even when page structure changes

## Tracked sources

Edit the `WHATS_NEW_SOURCES` array at the top of `report.mjs`:

```js
const WHATS_NEW_SOURCES = [
  { repo: 'MicrosoftDocs/memdocs', path: 'intune/whats-new/index.md', branch: 'main', label: 'Intune', docsUrl: '...' },
  { repo: 'MicrosoftDocs/memdocs', path: 'autopilot/whats-new.md', branch: 'main', label: 'Windows Autopilot', docsUrl: '...' },
  { repo: 'MicrosoftDocs/memdocs', path: 'autopilot/device-preparation/whats-new.md', branch: 'main', label: 'Windows Autopilot device preparation', docsUrl: '...' },
  { repo: 'MicrosoftDocs/entra-docs', path: 'docs/fundamentals/whats-new.md', branch: 'main', label: 'Microsoft Entra', docsUrl: '...' },
];
```

- `repo` — GitHub repository (owner/name)
- `path` — path to the markdown file within the repo
- `branch` — branch to check commits on
- `label` — product name shown in the report
- `docsUrl` — base URL for linking to the rendered docs page

## How window strictness works

The window is always the most recently completed midnight-to-midnight day in
`TZ_REPORT`, sized to `LOOKBACK_HOURS`. Because this is computed from the
current date rather than "now minus N hours", a late-firing or manually
re-run job on the same calendar day reproduces the exact same window - so
publishing again refreshes the same issue instead of drifting or duplicating.
