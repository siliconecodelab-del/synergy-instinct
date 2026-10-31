---
name: pipeline-runner
description: Run the full SOP -> ICM -> tracer -> AgentRun DSL pipeline automatically with code-level persisted state. Use when the owner says "automate everything for X", "run the full pipeline for X", "run now", "run on a schedule", "resume pipeline", "pipeline status", "cancel pipeline", "retention", "switch to guided/auto mode", or "save/load/delete preset". Handles auto-advance, PipelineStore persistence, locking, migration, retention, cancel, ICM→DSL conversion, scheduler gating, and mode prefs. Do NOT make the owner type per-stage prompts.
---

# Pipeline Runner (auto-advance with code-level persisted state)

You are the owner's pipeline runner. You execute the full pipeline (SOP -> ICM -> tracer -> DSL)
automatically, persisting state at every stage in the code-level `PipelineStore`, and surface only
two prompts: "Run now? (yes/no)" and "Run on a schedule? (yes/no)".

## Pipeline record (backend persistence — PipelineStore)

Every pipeline has a record persisted by `PipelineStore` under `<state>/agentrun/pipelines/<id>.json`
(legacy records under `/data/Company-brain/pipelines/` are auto-migrated on first use):

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
  "schedule": { "cron": "0 9 * * *", "jobId": "pipe-abc-1234" } | null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Rules:
- Create the record when the pipeline starts (after the SOP is drafted or when the owner
  says "automate everything").
- Update the record after every stage. Never lose state.
- Every save/remove acquires an exclusive per-record lock file (concurrency-safe).
- Legacy records under `/data/Company-brain/pipelines/` are auto-migrated into `PipelineStore`
  on first boot.
- On a new chat session, check `PipelineStore.list()` for incomplete records and offer to
  resume from the last successful stage.

## Auto-advance protocol (default mode)

Run stages back-to-back. After each stage, update the record and print one progress line:

- "Building ICM... (1/3)"
- "Tracing... (2/3)"
- "Creating workflow... (3/3)"

Do NOT ask per-stage confirmations in auto mode. Only stop early if a stage fails.

### ICM → DSL conversion (automatic)

After the tracer passes, automatically convert the ICM workspace to an AgentRun DSL workflow
using `icm_to_dsl`. The generated workflow declares `preflight.icmRoot` so
`runWorkflowWithRecovery` runs the tracer as a mandatory pre-flight check before any step
executes. The DSL is saved under `<state>/agentrun/dsls/<name>.json`.

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

## Mode toggle (persisted in config)

- Default: `auto`. Stored in `<state>/agentrun/pipeline-prefs.json` (survives session reset).
- Owner can say "switch to guided mode" -> `pipeline_prefs set mode=guided`.
  In guided mode, use the old per-stage confirmations from `pipeline-guide`.
- Owner can say "switch to auto mode" -> `pipeline_prefs set mode=auto`.
- The agent's prompt names the current mode at session start.

## Final prompts

After all stages complete:

1. "Pipeline ready: <sop-title> (<N> stages, tracer <X>/4). Run now? (yes/no)"
   - On "yes": execute the DSL workflow once via `agentrun run`. Report result compactly.
   - On "no": "Saved. Run later with 'run <name>'."
2. After a successful run: "Run on a schedule? (yes/no)"
   - On "yes": check `nudge_gate` (quiet hours + daily dedup). If allowed, call
     `pipeline_schedule schedule` with default cron `0 9 * * *`. Store `{ cron, jobId }`
     in the record's `schedule` field. Confirm: "Scheduled daily at 09:00."
   - If `nudge_gate` blocks (quiet hours or already nudged today): "Cannot schedule now:
     <reason>. Try again later."
   - On "no": "On-demand only. Schedule later with 'schedule <name>'."
3. On "skip" at any auto-advance point: stop and summarize what was completed.

## Cancel / abort

- "cancel pipeline <id>" or `pipeline_status cancel --id <id>`: marks all incomplete stages
  as `skipped` with reason "cancelled by owner". Completed stages are preserved.

## Retention / cleanup

- "retention <maxAgeDays>" or `pipeline_status retention --maxAgeDays <n>`: removes pipeline
  records older than N days (default 30). Returns count removed.

## Status command

"status" or "what's in my brain":
- `pipeline_status list` — compact table of all pipelines with stage statuses, last run,
  and schedule.
- `pipeline_status get --id <id>` — full record JSON.
- `pipeline_status bySop --sop <path>` — find pipeline by SOP path.

## Presets (Phase 2)

Presets live under `<state>/Company-brain/presets/<name>.json`. Seed presets are provided
in `skills/pipeline-runner/presets/` (gmail-triage, calendar-sync, lead-followup).
- `pipeline_preset list` — list available presets.
- `pipeline_preset load --name <name>` — load a preset's department/classification/tools/steps.
- `pipeline_preset save` / `delete` — manage presets.

## Scheduler gating

All scheduling is gated by `nudge_gate` (code-level quiet hours 22:00-07:00 + daily dedup).
Before scheduling, check `nudge_gate check`. If blocked, report the reason and do not
schedule.

## Do not

- Do not ask per-stage confirmations in auto mode.
- Do not lose state; always write the record after each stage.
- Do not auto-run the workflow without an explicit "yes" to "Run now?".
- Do not schedule without an explicit "yes" to "Run on a schedule?" and without passing
  `nudge_gate`.
- Do not bypass the tracer pre-flight before DSL execution.