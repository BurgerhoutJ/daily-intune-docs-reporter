# Intune Docs Daily Reporter

Daily GitHub Actions report for Microsoft Intune / endpoint management
documentation updates, in a strict 24-hour window.

The workflow runs once a day at 06:00 UTC, collects updates from
`MicrosoftDocs/memdocs` (Intune, Configuration Manager, Windows Autopilot),
and posts a formatted GitHub issue so GitHub notifications can email you
updates. The report window is an exact, non-overlapping calendar day
(midnight to midnight, in the configured timezone), so a late-firing or
re-run job always reports the same content instead of duplicating it. When
the daily issue already exists, the workflow adds a refresh comment with the
latest report so a re-run email isn't empty.

Modeled after [BakkerJan/entra-docs-daily-reporter-example](https://github.com/BakkerJan/entra-docs-daily-reporter-example).

## Just Want the Daily Email?

You don't need to fork or run anything if you're watching this exact repo.
Click **Watch** at the top of this page → **Custom** → check **Issues** →
**Apply**, and you'll get the daily report emails without also getting
notified about PRs, releases, or anything else that lands in this repo.
No Actions minutes, no secrets, no setup.

The tradeoff: you're relying on this repo staying up, and on its current
schedule/timezone/tracked sources. Fork it (below) for an independent copy
or different settings.

## 1-Minute Quick Start (Run Your Own Copy)

1. Fork or clone this repository.
2. In GitHub, open **Settings** → **General** → **Features** and make sure
   **Issues** is enabled for the repository.
3. Open **Actions** and run **Intune Docs Daily Reporter** with
   **Run workflow**.
4. Open the created issue titled `Daily Intune Docs PR Report - YYYY-MM-DD`.
5. If you forked into your own account, you're done - GitHub automatically
   watches repos you own, and that's what delivers the email, not the
   per-issue **Subscribe** button (a new issue is created every day, so
   subscribing to just one never covers the next day's). If you're running
   this under an org or shared account, click **Watch** → **Custom** →
   check **Issues** → **Apply**.
6. You now receive daily updates through GitHub notification email.

## What You Get

- Strict 24-hour report window (no multi-day section in the issue body)
- Data source: `MicrosoftDocs/memdocs` - `intune/`, `configmgr/`, and
  `autopilot/` folders (Intune, Configuration Manager, and Windows Autopilot
  documentation)
- Categories derived automatically from each doc's folder path (Device
  Configuration, Device Security, Apps, Endpoint Security, Enrollment,
  Autopilot, Configuration Manager, and more) - no fixed category list to
  maintain
- A lean, non-tabular digest instead of a Markdown table: each item is a
  linked title (Microsoft Learn page, or the GitHub source if not yet on
  Learn) plus one meta line with the local timestamp, how it was published,
  and the source PR
- Uploaded artifacts: `html` (a full data table, for anyone who wants one),
  `md` (the digest - this becomes the issue body), `json` (machine-readable
  metadata, including the exact window bounds)

## Repo Structure

- `.github/workflows/intune-docs-daily-reporter.yml` - Schedule and
  publishing workflow
- `tools/intune-docs-reporter/report.mjs` - Report generator
- `tools/intune-docs-reporter/README.md` - Extended configuration guide
- `docs/intune-docs-daily-reporter-publish.md` - Copy/paste blog section

## Manual Test

```bash
gh workflow run "Intune Docs Daily Reporter" --repo <owner>/<repo>
gh run list --workflow "intune-docs-daily-reporter.yml" --repo <owner>/<repo> --limit 1
```

## Customize

- Report window size: `LOOKBACK_HOURS` (default `24`)
- Timezone used for the report window, timestamps, and issue titles:
  `TZ_REPORT` (default `Europe/Amsterdam`), set in the workflow's `env:` block
- Tracked repos/folders: edit the `PUBLISH_SOURCES` list at the top of
  `tools/intune-docs-reporter/report.mjs`

## Notes

- No SMTP provider is required.
- Delivery is via GitHub notifications, so account notification settings apply.
- Notifications work at the **repository** level, not per-issue: this
  workflow creates a new issue every day, so clicking Subscribe on one issue
  only ever covers that one day. What actually delivers the recurring email
  is your repo-level Watch setting (owners watch their own repos by
  default). To stop the emails, use the **Watch** dropdown on the repo →
  **Ignore**, or **Custom** and uncheck **Issues** - GitHub's API doesn't
  expose that level of control, only the web UI does.

## Troubleshooting

### `Unhandled error: HttpError: Issues has been disabled in this repository.`

The workflow publishes the report by creating or updating a GitHub issue and
comments on existing daily issues with the latest report to force a fresh
notification email. If repository issues are disabled, the run fails at the
publish step.

Fix:

1. Open **Settings** → **General** → **Features**
2. Enable **Issues**
3. Re-run the workflow

This is currently a **manual** repository setting; it changes
repository-level settings, so it isn't something this workflow can reliably
automate with the default `GITHUB_TOKEN`.

### Rate limiting / empty reports

Unauthenticated GitHub Search API calls are capped at 10 requests/minute and
60/hour. Running under GitHub Actions with the built-in `secrets.GITHUB_TOKEN`
(already wired up in the workflow) uses the much higher authenticated limits,
so this should only bite during local testing without a token set.
