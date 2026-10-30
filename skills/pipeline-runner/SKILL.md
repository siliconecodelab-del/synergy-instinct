---
name: pipeline-runner
description: Run the full SOP -> ICM -> tracer -> AgentRun DSL pipeline automatically with persisted state. Use when the owner says "automate everything for X", "run the full pipeline for X", "run now", "run on a schedule", "resume pipeline", or "pipeline status". Handles auto-advance, persisted pipeline records, mode toggle (auto/guided), and scheduling. Do NOT make the owner type per-stage prompts.
---

# Pipeline Runner (auto-advance with persisted state)

You are the owner's pipeline runner. You execute the full pipeline (SOP -> ICM -> tracer -> DSL)
automatically, persisting state at every stage, and surface only two prompts:
"Run now? (yes/no)" and "Run on a schedule? (yes/no)".

## Pipeline record (backend persistence)

Every pipeline has a record at `/data/Company-brain/pipelines/<id>.json`:

```json
{
  "id": "pipe_<short>",
  "sop": "gtm-playbook/gmail-inbox-triage",
  "mode": "auto",
  "stages": {
    "sop":    { "status": "done", "path": "gtm-playbook/gmail-inbox-triage.md" },
    "icm":    { "status": "done", "root": "gtm-playbook/gmail-inbox-triage/" },
    "trace":  { "status": "passed", "checks": 4, "html": "workspace/traces/.../trace.html" },
    "dsl":    { "status": "created", "name": "gmail-triage" }
  },
  "lastPrompt": "run_now",
  "lastRun": null,
  "schedule": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Rules:
- Create the record when the pipeline starts (after the SOP is drafted or when the owner
  says "automate everything").
- Update the record after every stage. Never lose state.
- On a new chat session, check `/data/Company-brain/pipelines/` for incomplete records and
  offer to resume from the last successful stage.

## Auto-advance protocol (default mode)

Run stages back-to-back. After each stage, update the record and print one progress line:

- "Building ICM... (1/3)"
- "Tracing... (2/3)"
- "Creating workflow... (3/3)"

Do NOT ask per-stage confirmations in auto mode. Only stop early if a stage fails.

### Failure handling

If a stage fails:
- Mark that stage `failed` with a one-line reason in the record.
- Skip subsequent stages.
- Tell the owner: "Pipeline stopped at <stage>: <reason>. Retry? (yes/no)"
- On "yes", resume from the failed stage (not from scratch).

### Tracer failure (special case)

If the tracer fails:
- "Route check failed: <failing checks>. Fix and retry? (yes/no)"
- On "yes", re-run only the tracer (and re-create DSL if it then passes).

## Mode toggle

- Default: `auto`.
- Owner can say "switch to guided mode" -> set `mode: "guided"` in the record and memory.
  In guided mode, use the old per-stage confirmations from `pipeline-guide`.
- Owner can say "switch to auto mode" -> set `mode: "auto"`.

## Final prompts

After all stages complete:

1. "Pipeline ready: <sop-title> (<N> stages, tracer <X>/4). Run now? (yes/no)"
   - On "yes": execute the DSL workflow once. Report result compactly.
   - On "no": "Saved. Run later with 'run <name>'."
2. After a successful run: "Run on a schedule? (yes/no)"
   - On "yes": create a scheduler job (default cron `0 9 * * *`) bound to the pipeline id.
     Store `{ cron, jobId }` in the record's `schedule` field.
     Confirm: "Scheduled daily at 09:00. Manage with 'unschedule <name>'."
   - On "no": "On-demand only. Schedule later with 'schedule <name>'."
3. On "skip" at any auto-advance point: stop and summarize what was completed.

## Status command

"status" or "what's in my brain":
- List pipeline records.
- For each: "<title>: <stage-status summary>, last run <time or never>, schedule <cron or none>".

## Resume after crash / new session

On first message in a new session:
1. Read `/data/Company-brain/pipelines/*.json`.
2. If any record has an incomplete stage, offer: "Pipeline '<title>' is mid-flight at <stage>. Resume? (yes/no)".
3. If yes, resume from the last successful stage.

## Do not

- Do not ask per-stage confirmations in auto mode.
- Do not lose state; always write the record after each stage.
- Do not auto-run the workflow without an explicit "yes" to "Run now?".
- Do not schedule without an explicit "yes" to "Run on a schedule?".