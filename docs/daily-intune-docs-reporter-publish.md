# Daily Intune Docs Reporter

Want a daily heads-up when Microsoft changes Intune or Windows Autopilot
documentation - without babysitting an RSS reader?

This repo runs a small GitHub Actions workflow once a day that:

1. Looks at everything merged into `MicrosoftDocs/memdocs` in the last strict
   24-hour window (midnight to midnight, no overlap, no duplicates on rerun).
2. Groups the changed docs by area (Device Configuration, Endpoint Security,
   Apps, Autopilot, and more) automatically, based on folder structure -
   nothing to maintain by hand.
3. Publishes a digest as a GitHub issue titled `Daily Intune Docs PR Report -
   YYYY-MM-DD`, so you get it as a normal GitHub notification email.

**Just want the email?** Click **Watch** on this repo → **Custom** → check
**Issues** → **Apply**. No fork, no Actions minutes, no secrets.

**Want your own copy or different settings?** Fork the repo, then see the
main [README](../README.md) for the 1-minute quick start.
