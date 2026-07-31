# Daily Intune Docs Reporter

Hey there,

As an Intune consultant, I need to know when Microsoft changes something in
the Intune, Windows Autopilot, or Windows 365 documentation - ideally before
a customer asks me about it. I got tired of babysitting an RSS reader for
that, so I built this instead. Now I just get an email once a day.

Here's what it does: once a day, at 06:00 UTC, a GitHub Actions workflow
scrapes Microsoft's own "What's new" pages for Intune, Windows Autopilot,
and Windows 365, and posts anything new as a formatted GitHub issue, so
GitHub's own notification emails handle delivery for me.

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
- Three products tracked, each via Microsoft's own public "What's new"
  page rather than raw doc PRs - none of these product lines had a source
  that PR-search could reliably cover (Intune/Autopilot content doesn't map
  cleanly to feature-level announcements, and Windows 365's docs repo is
  private), so a "What's new" page turned out to be the more accurate
  signal across the board:
  - **Intune** - grouped by weekly release, then by area (Device
    Configuration, Device Security, App Management, and more)
  - **Windows Autopilot** - each item carries its own "Date added"/"Date
    updated", so this one's genuinely daily-precise
  - **Windows 365** (Enterprise, Business, Link, Agents) - grouped by the
    week Microsoft published it
- Because Intune and Windows 365 items are dated by "Week of ...", they
  only surface in the report on the day their week starts - in practice
  that's roughly-weekly, not daily, even though the job itself runs every
  day
- A lean, non-tabular digest instead of a Markdown table: each item is a
  linked title (straight to that item's anchor on the Learn page) plus one
  meta line with when it was added/updated/published
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
- Tracked "What's new" pages: edit the `WHATS_NEW_SOURCES` list at the top
  of `tools/daily-intune-docs-reporter/report.mjs`

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

### A source page fails to fetch

If one of the "What's new" pages is temporarily unreachable, the run logs
the failure and skips just that page rather than failing the whole report -
you'll see items from the other pages as usual, just missing that one
product for the day.
