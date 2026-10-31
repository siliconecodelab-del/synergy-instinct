# Session Report: Pipeline Runner (Auto-Advance UX)

Date: 2026-10-30

This report documents the implementation of the `pipeline-runner` skill and supporting
prompt changes that abstract away intermediate pipeline stages from the iMessage UX.

---

## Part 1 — What was implemented

### A. New skill: `skills/pipeline-runner/SKILL.md`

A skill that runs the full SOP -> ICM -> tracer -> AgentRun DSL pipeline automatically
with persisted state. Key features:

- **Pipeline records** persisted at `/data/Company-brain/pipelines/<id>.json`, tracking
  every stage status, paths, trace results, DSL name, schedule, and timestamps.
- **Auto-advance (default mode):** stages run back-to-back; only two prompts surface:
  "Run now? (yes/no)" and "Run on a schedule? (yes/no)".
- **Guided mode (opt-in):** falls back to per-stage confirmations from `pipeline-guide`.
- **Mode toggle:** "switch to auto/guided mode" stored in memory.
- **Failure handling:** marks failed stage, skips subsequent, offers retry from failure point.
- **Tracer failure:** special-cased with "Fix and retry? (yes/no)".
- **Status command:** compact list of pipelines with stage status, last run, schedule.
- **Resume after crash:** detects incomplete records on new session and offers resume.
- **Scheduling:** creates a scheduler job and records `{ cron, jobId }` in the pipeline record.

### B. Updated skill: `skills/pipeline-guide/SKILL.md`

Added a cross-reference: auto mode is handled by `pipeline-runner`; `pipeline-guide`
is for guided/step-by-step mode.

### C. Prompt change: `packages/server/src/boot.ts`

When AgentRun is enabled, the prompt now mentions `pipeline-runner` for fully automatic
runs and its persisted-state + two-prompt UX.

---

## Part 2 — UX comparison

### Before (guided mode, still available)

```
SOP done -> "Next: build ICM? (yes/no)"
ICM done -> "Next: run tracer? (yes/no)"
Tracer done -> "Next: create AgentRun workflow? (yes/no/skip)"
Tracer failed -> "Fix and retry? (yes/no)"
DSL done -> "Run now? (yes/no)"
```

### After (auto mode, default)

```
SOP done -> "Building ICM... (1/3)" -> "Tracing... (2/3)" -> "Creating workflow... (3/3)"
         -> "Pipeline ready: <title> (<N> stages, tracer <X>/4). Run now? (yes/no)"
         -> (on yes) run executes -> "Run on a schedule? (yes/no)"
```

Intermediate stages are abstracted away; the user only sees progress lines and two
final prompts. All state is persisted in pipeline records.

---

## Part 3 — E2E testing guide

### Prerequisites

- Agent has `INSTINCT_AGENTRUN=1`.
- Skills are loaded (rebuilt agent image or local dev).
- `/data/Company-brain` exists (created on first SOP).

### Test 1: Full auto pipeline

**iMessage:** "Automate everything for Gmail inbox triage."

**Expected agent behavior:**
1. Recognizes "automate everything" -> auto mode, full pipeline.
2. Drafts SOP (stage 1): "Building ICM... (1/3)"
3. Builds ICM (stage 2): "Tracing... (2/3)"
4. Runs tracer (stage 3): "Creating workflow... (3/3)"
5. Creates DSL workflow (stage 4).
6. Replies: "Pipeline ready: gmail-inbox-triage (4 stages, tracer 4/4). Run now? (yes/no)"

**Pass criteria:** pipeline record exists at `/data/Company-brain/pipelines/pipe_*.json`;
all four stages show `done`/`passed`/`created`; compact reply with two prompts pending.

### Test 2: Run now

**iMessage:** "yes" (to "Run now?")

**Expected:**
1. Agent executes the DSL workflow (pre-flight passes).
2. Replies with completion summary or escalation reason.
3. Then asks: "Run on a schedule? (yes/no)"

**Pass criteria:** workflow run recorded in `/data/agentrun/runs/`; reply includes result
and schedule prompt.

### Test 3: Schedule

**iMessage:** "yes" (to "Run on a schedule?")

**Expected:**
1. Agent creates a scheduler job (cron `0 9 * * *`).
2. Updates pipeline record with `schedule: { cron, jobId }`.
3. Replies: "Scheduled daily at 09:00. Manage with 'unschedule <name>'."

**Pass criteria:** scheduler job exists; pipeline record has schedule field.

### Test 4: Status

**iMessage:** "status"

**Expected:**
"Brain: 1 pipeline — gmail-inbox-triage (traced 4/4, runnable, scheduled daily 09:00)."

### Test 5: Resume after crash

**Setup:** Delete the pipeline record mid-flight (simulate crash), then send a message.

**Expected:**
"Pipeline 'gmail-inbox-triage' is mid-flight at <stage>. Resume? (yes/no)"

**Pass criteria:** agent detects incomplete record and offers resume.

### Test 6: Failure handling

**Setup:** Create an ICM with a dead path (missing file reference).

**iMessage:** "Automate everything for <broken-sop>."

**Expected:**
1. Stages run until tracer.
2. Tracer fails (Paths check).
3. Agent stops: "Pipeline stopped at trace: Every path read exists. Fix and retry? (yes/no)"
4. Pipeline record shows `trace.status: "failed"`.

**Pass criteria:** no DSL created; record has failed stage; user sees one-line reason.

### Test 7: Guided mode toggle

**iMessage:** "switch to guided mode"

**Expected:** "Switched to guided mode. Per-stage confirmations enabled."

**Then:** "Automate everything for X" should now ask "Next: build ICM? (yes/no)" etc.

### Test 8: Skip

**iMessage:** "Automate everything for X" then "skip" at a stage.

**Expected:** pipeline stops; summary of completed stages; no further action.

---

## Part 4 — Caveats and gotchas

1. **Auto-advance is skill-driven, not code-enforced.** The agent follows the skill
   instructions, but compliance depends on the model. If the agent ignores auto-advance,
   it falls back to per-stage behavior. Mitigation: the `boot.ts` prompt reinforces the skill.

2. **"Run now?" always requires explicit yes.** Auto-running a workflow without
   confirmation is intentionally prohibited — workflows may trigger outbound actions.

3. **Scheduling is skill-level.** The scheduler job is created by the agent via the
   scheduler tool. If the agent doesn't create it, no schedule fires. There is no
   code-level enforcement of the cron or deduplication.

4. **Quiet hours are advisory.** The `pipeline-nudge` skill instructs the agent to
   respect 22:00-07:00, but there is no hard enforcement.

5. **Pipeline records are file-based.** They live on the agent's persistent volume
   (`/data`). If the volume is wiped, records are lost. They are not synced to the
   gateway or any external store.

6. **Resume depends on record existence.** If a record is corrupted or missing, the
   agent cannot resume and must start fresh.

7. **Guided mode toggle is memory-based.** If the agent's memory is cleared, the mode
   resets to auto (default).

8. **The tracer must pass before DSL creation.** In auto mode, a tracer failure stops
   the pipeline. The owner can skip with "skip", but the DSL won't be created.

9. **No code-level pipeline store.** Unlike AgentRun workflows (which have
   `WorkflowStore`), pipeline records are plain JSON files managed by the agent via
   file tools. A future improvement could add a `PipelineStore` in `packages/agentrun`.

---

## Part 5 — Files touched

```
skills/pipeline-runner/SKILL.md        (new)
skills/pipeline-guide/SKILL.md         (cross-reference update)
packages/server/src/boot.ts            (prompt section update)
docs/SESSION-REPORT-PIPELINE-RUNNER.md (this report)
```

## Part 6 — Next steps

- Implement a `PipelineStore` in `packages/agentrun` for code-level persistence.
- Add code-level quiet-hour enforcement and nudge deduplication.
- Implement preset loading (Phase 2) from `/data/Company-brain/presets/`.
- Add a `pipeline_status` tool for programmatic status (currently skill-driven).
- Store owner preference (auto vs. guided) in config, not just memory.