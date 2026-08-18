# Daily Intune & Entra Docs Reporter

Want a daily heads-up when Microsoft changes Intune, Windows Autopilot, or
Microsoft Entra documentation - without babysitting an RSS reader?

This repo runs a small GitHub Actions workflow once a day that:

1. Checks the git diffs on Microsoft's "What's new" markdown source files
   for Intune, Windows Autopilot, and Microsoft Entra, in the last strict
   24-hour window (midnight to midnight, no overlap, no duplicates on rerun).
2. Extracts newly added headings and links each item to the commit diff on
   GitHub, so you can see exactly what changed.
3. Publishes a digest as a GitHub issue titled `Daily Intune & Entra Report -
   YYYY-MM-DD`, so you get it as a normal GitHub notification email.

**Just want the email?** Click **Watch** on this repo → **Custom** → check
**Issues** → **Apply**. No fork, no Actions minutes, no secrets.

**Want your own copy or different settings?** Fork the repo, then see the
main [README](../README.md) for the 1-minute quick start.
