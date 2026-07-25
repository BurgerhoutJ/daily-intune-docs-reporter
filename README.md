# Daily Intune Docs Reporter

Hey there,

As an Intune consultant, I need to know when Microsoft changes something in
the Intune or Windows Autopilot documentation - ideally before a customer
asks me about it. I got tired of babysitting an RSS reader for that, so I
built this instead. Now I just get an email once a day.

Here's what it does: once a day, at 06:00 UTC, a GitHub Actions workflow
collects everything merged into `MicrosoftDocs/memdocs` (Intune, Windows
Autopilot) and posts it as a formatted GitHub issue, so GitHub's own
notification emails handle delivery for me.

A few things I made sure of along the way:

- The report window is an exact, non-overlapping calendar day (midnight to
  midnight, in my timezone). So if a run fires late, or I re-run it by hand,
  it reports the exact same content instead of duplicating anything.
- If the daily issue already exists, the workflow adds a refresh comment
  with the latest report, so a re-run doesn't just send an empty email.

Modeled after [BakkerJan/entra-docs-daily-reporter-example](https://github.com/BakkerJan/entra-docs-daily-reporter-example) - same idea, just aimed at Intune instead of Entra.

## Just Want the Daily Email?

You don't have to fork or run anything if you're fine watching my copy of
this repo. Click **Watch** at the top of this page → **Custom** → check
**Issues** → **Apply**, and you'll get the daily report emails without also
getting notified about every PR or release that lands here. No Actions
minutes, no secrets, nothing to set up.

💡
The tradeoff: you're relying on me keeping this repo running, on my
schedule/timezone, and on the sources I've chosen to track. If that doesn't
work for you, fork it and run your own copy - see below.

## 1-Minute Quick Start (Run Your Own Copy)

1. Fork or clone this repository.
2. In GitHub, open **Settings** → **General** → **Features** and make sure
   **Issues** is enabled for the repository.
3. Open **Actions** and run **Daily Intune Docs Reporter** with
   **Run workflow**.
4. Open the created issue titled `Daily Intune Docs PR Report - YYYY-MM-DD`.
5. If you forked into your own account, you're already done - GitHub
   automatically watches repos you own, and that's what actually delivers
   the email, not the per-issue **Subscribe** button (a new issue is
   created every day, so subscribing to just one never covers the next
   day's). Running this under an org or shared account instead? Click
   **Watch** → **Custom** → check **Issues** → **Apply**.
6. You now receive daily updates through GitHub notification email.

## What You Get

- A strict 24-hour report window - no multi-day section cluttering the
  issue body
- Data source: `MicrosoftDocs/memdocs` - the `intune/` and `autopilot/`
  folders (Intune and Windows Autopilot documentation)
- Categories derived automatically from each doc's folder path (Device
  Configuration, Device Security, Apps, Endpoint Security, Enrollment,
  Autopilot, and more) - I didn't want a fixed category list to maintain by
  hand every time Microsoft reorganizes docs
- A lean, non-tabular digest instead of a Markdown table: each item is a
  linked title (Microsoft Learn page, or the GitHub source if it's not yet
  live on Learn) plus one meta line with the local timestamp, how it was
  published, and the source PR
- Uploaded artifacts every run: `html` (a full data table, if you want one),
  `md` (the digest - this becomes the issue body), and `json`
  (machine-readable metadata, including the exact window bounds)

## Repo Structure

- `.github/workflows/daily-intune-docs-reporter.yml` - schedule and
  publishing workflow
- `tools/daily-intune-docs-reporter/report.mjs` - the report generator
- `tools/daily-intune-docs-reporter/README.md` - extended configuration guide
- `docs/daily-intune-docs-reporter-publish.md` - copy/paste blog section

## Manual Test

```bash
gh workflow run "Daily Intune Docs Reporter" --repo <owner>/<repo>
gh run list --workflow "daily-intune-docs-reporter.yml" --repo <owner>/<repo> --limit 1
```

## Customize

- Report window size: `LOOKBACK_HOURS` (default `24`)
- Timezone used for the report window, timestamps, and issue titles:
  `TZ_REPORT` (default `Europe/Amsterdam`, since that's where I live), set
  in the workflow's `env:` block
- Tracked repos/folders: edit the `PUBLISH_SOURCES` list at the top of
  `tools/daily-intune-docs-reporter/report.mjs`

## Notes

- No SMTP provider required.
- Delivery is via GitHub notifications, so your account notification
  settings apply.
- Notifications work at the **repository** level, not per-issue: this
  workflow creates a new issue every day, so clicking Subscribe on one issue
  only ever covers that one day. What actually delivers the recurring email
  is your repo-level Watch setting (owners watch their own repos by
  default). To stop the emails, use the **Watch** dropdown on the repo →
  **Ignore**, or **Custom** and uncheck **Issues** - GitHub's API doesn't
  expose that level of control, only the web UI does.

## Troubleshooting

### `Unhandled error: HttpError: Issues has been disabled in this repository.`

The workflow publishes the report by creating or updating a GitHub issue,
and it comments on existing daily issues with the latest report to force a
fresh notification email. If repository issues are disabled, the run fails
at the publish step.

Fix:

1. Open **Settings** → **General** → **Features**
2. Enable **Issues**
3. Re-run the workflow

This is currently a **manual** repository setting; it changes
repository-level settings, so it's not something this workflow can
reliably automate with the default `GITHUB_TOKEN`.

### Rate limiting / empty reports

Unauthenticated GitHub Search API calls are capped at 10 requests/minute and
60/hour. Running under GitHub Actions with the built-in `secrets.GITHUB_TOKEN`
(already wired up in the workflow) uses the much higher authenticated
limits, so this should only bite you during local testing without a token
set.
