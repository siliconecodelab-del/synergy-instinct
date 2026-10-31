---
name: pipeline-nudge
description: Set up and run a daily proactive nudge that scans /data/Company-brain for new SOPs and offers to build ICMs and run tracers. Use when the owner asks for "daily nudges", "proactive reminders", "ping me about new SOPs", or "set up a nudge schedule". Also use when a scheduled nudge fires and you need to scan and report.
---

# Pipeline Nudge

## Setting up the nudge (owner request)

When the owner asks to enable nudges:

1. Use the scheduler tool to create a daily job at 09:00 local time:
   - cron: `0 9 * * *`
   - task: "Run pipeline-nudge scan"
2. Confirm: "Daily nudge set for 09:00. I'll scan for new SOPs and ping you. Quiet hours 22:00-07:00 respected."
3. Store the last-nudge timestamp in memory (key: `pipeline_nudge_last`).

## Running the nudge (scheduled or manual)

1. List SOPs: `find /data/Company-brain/SOPs -name '*.md' -newer <last_nudge_marker>` (or all if no marker).
2. For each new SOP not yet processed:
   - Send one iMessage: "New SOP found: <title>. Build ICM + test? (yes/no/skip)"
   - Max one nudge per day total; if multiple new SOPs, pick the newest and mention the count.
3. Update the last-nudge marker.

## Do not

- Do not nudge more than once per day.
- Do not nudge during quiet hours (22:00-07:00).
- Do not auto-build; always ask.