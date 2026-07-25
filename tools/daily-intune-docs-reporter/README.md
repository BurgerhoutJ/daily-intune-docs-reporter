# daily-intune-docs-reporter

`report.mjs` collects documentation PRs merged into `MicrosoftDocs/memdocs`
(Intune, Configuration Manager, Windows Autopilot) within a strict window,
then writes `report.md` / `report.html` / `report.json` and, optionally,
publishes `report.md` as a daily GitHub issue.

## Requirements

- Node.js 18+ (uses native `fetch`; no dependencies to install)
- A `GITHUB_TOKEN` with:
  - public read access, for querying `MicrosoftDocs/memdocs` (an unauthenticated
    token works but is rate-limited to 60 requests/hour on search - use an
    authenticated token in practice)
  - `issues: write` on the *target* repo, only if you pass `--publish`

## Run locally

```bash
export GITHUB_TOKEN=ghp_xxx
node report.mjs                # generate out/report.{md,html,json} only
node report.mjs --publish       # also create/refresh the daily issue
```

`--publish` requires `GITHUB_REPOSITORY` to be set to `owner/repo` (GitHub
Actions sets this automatically; set it yourself for local testing).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LOOKBACK_HOURS` | `24` | Size of the report window in hours |
| `TZ_REPORT` | `Europe/Amsterdam` | Timezone for window boundaries, timestamps, and issue titles |
| `OUTPUT_DIR` | `./out` | Where artifacts are written |
| `GITHUB_TOKEN` | - | Auth token for the GitHub REST/Search API |
| `GITHUB_REPOSITORY` | - | `owner/repo` to publish the issue into (only needed with `--publish`) |

## Tracked sources

Edit the `PUBLISH_SOURCES` array at the top of `report.mjs`:

```js
const PUBLISH_SOURCES = [
  {
    repo: 'MicrosoftDocs/memdocs',
    pathPrefix: 'intune/',
    learnBase: 'https://learn.microsoft.com/en-us/mem/intune/',
    label: 'Intune',
  },
  // add/remove entries to track other folders or repos
];
```

- `repo` - the GitHub repo to query for merged PRs.
- `pathPrefix` - only files under this folder are included; also used to
  derive the relative path for the Learn URL.
- `learnBase` - prepended to the relative path (minus `.md`/`index`) to build
  the Microsoft Learn link. Newly **added** files often aren't live on Learn
  yet at publish time, so those link to the GitHub source instead and are
  flagged "not yet on Learn".
- `label` - used as (part of) the report category. The rest of the category
  is derived automatically from the first folder segment under `pathPrefix`
  (e.g. `intune/device-configuration/...` → "Intune — Device Configuration"),
  so there's no fixed category list to maintain.

Multiple entries can point at the same `repo` - merged PRs for that repo are
only fetched once and then matched against every `pathPrefix` that applies.

## How window strictness works

The window is always the most recently completed midnight-to-midnight day in
`TZ_REPORT`, sized to `LOOKBACK_HOURS`. Because this is computed from the
current date rather than "now minus N hours", a late-firing or manually
re-run job on the same calendar day reproduces the exact same window - so
publishing again refreshes the same issue instead of drifting or duplicating.

## Notes on doc titles

For up to 60 changed files per run, the script fetches the raw file at the
merge commit and reads the `title:` front-matter field for a proper title;
beyond that cap (or if front matter is missing/unreadable) it falls back to a
humanized version of the filename. The cap exists to keep API usage
reasonable on days with unusually large content pushes.
