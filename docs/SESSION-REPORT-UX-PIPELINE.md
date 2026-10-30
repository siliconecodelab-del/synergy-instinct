# Session Report: iMessage UX Improvements for the SOP -> ICM -> AgentRun Pipeline

Date: 2026-10-30

This report documents the UX improvements implemented to reduce technical prompting on
iMessage and enable proactive, guided pipeline runs.

---

## Part 1 — What was implemented

### A. Phase 1: Intent shortcuts + auto-advance + compact summaries

**New skill: `skills/pipeline-guide/SKILL.md`**

Teaches the agent to:
- Recognize natural-language intents ("automate X", "document X", "status", "what's in my
  brain") and map them to pipeline stages (SOP / ICM / Tracer / DSL).
- Auto-advance after each stage with a yes/no confirmation:
  - SOP done -> "Next: build ICM? (yes/no)"
  - ICM done -> "Next: run tracer? (yes/no)"
  - Tracer done -> "Next: create AgentRun workflow? (yes/no/skip)"
  - Tracer failed -> "Fix and retry? (yes/no)"
  - DSL done -> "Run now? (yes/no)"
- Report compact, iMessage-friendly summaries (one or two lines).
- Handle a "status" command listing SOPs and their pipeline stage.
- Never require the owner to know paths or tool names.

**Prompt change: `packages/server/src/boot.ts`**
- When AgentRun is enabled, the prompt now tells the agent to use `pipeline-guide` for
  plain-language requests and to avoid making the owner type technical prompts.

### B. Phase 3: Proactive nudges (skill-level)

**New skill: `skills/pipeline-nudge/SKILL.md`**
- Owner can say "enable daily nudges" -> agent creates a scheduler job (cron `0 9 * * *`).
- When the nudge fires, the agent scans `/data/Company-brain/SOPs/` for new SOPs and sends
  one iMessage per day max: "New SOP found: <title>. Build ICM + test? (yes/no/skip)".
- Respects quiet hours (22:00-07:00) and max one nudge per day.

### C. Status command

Built into `pipeline-guide`: lists SOPs and their stage (SOP only / ICM / Traced N/4 /
Workflow / Runnable) in compact form.

---

## Part 2 — E2E testing guide

### Prerequisites

- Agent has `INSTINCT_AGENTRUN=1` (set for `usr_64ef1ba5a45ee067`).
- Skills are loaded (rebuilt agent image or local dev with skills dir).
- `/data/Company-brain` may be empty initially.

### Test 1: Intent shortcut — "document"

**iMessage:** "Document how we triage the Gmail inbox."

**Expected agent behavior:**
1. Recognizes intent "document" -> starts at SOP stage.
2. Asks at most one clarifying question if tools are unclear (e.g., "Tools: gmail?").
3. Drafts SOP to `/data/Company-brain/SOPs/gtm-playbook/gmail-inbox-triage.md`.
4. Replies compactly: "SOP created: gtm-playbook/gmail-inbox-triage.md (gmail, hybrid). Next: build ICM? (y/n)"

**Pass criteria:** SOP file exists; reply is 1-2 lines; next-step prompt present.

### Test 2: Auto-advance

**iMessage:** "yes" (to "Next: build ICM?")

**Expected:**
1. Agent builds ICM (entry file + stage contract).
2. Replies: "ICM ready: gtm-playbook/gmail-inbox-triage/ (entry + 1 stage). Next: trace? (y/n)"

**Pass criteria:** ICM files exist; compact reply; next prompt.

### Test 3: Tracer

**iMessage:** "yes" (to "Next: trace?")

**Expected:**
1. Agent runs `workflow_trace` (tree + reads + done).
2. Replies: "Tracer: 4/4 passed (~1.2k tokens). Next: create workflow? (y/n)" (or reports failures).

**Pass criteria:** trace.html exists; reply includes check count.

### Test 4: DSL creation + run

**iMessage:** "yes" (to "Next: create workflow?")

**Expected:**
1. Agent creates AgentRun workflow with preflight on the ICM root.
2. Replies: "Workflow `gmail-triage` created and preflight-protected. Run now? (y/n)"

**iMessage:** "yes"

**Expected:**
1. Workflow runs (pre-flight passes), steps execute.
2. Replies with completion summary or escalation reason.

### Test 5: Status command

**iMessage:** "status"

**Expected:**
"Brain: 1 SOP — gmail-inbox-triage (traced 4/4, workflow ready)."

### Test 6: Preset (Phase 2 — not yet implemented)

**iMessage:** "use the Gmail triage preset"

**Expected (future):** loads preset from `/data/Company-brain/presets/` or offers to create one.

### Test 7: Proactive nudge (Phase 3)

**Setup:** Create a new SOP file manually, then wait for the scheduled nudge (or trigger manually).

**iMessage (simulated):** "Run pipeline-nudge scan"

**Expected:**
"New SOP found: <title>. Build ICM + test? (yes/no/skip)"

**Pass criteria:** one nudge per day max; quiet hours respected.

---

## Part 3 — Caveats and gotchas

1. **Skills are prompt-driven, not code-enforced.** The agent follows the skill instructions,
   but compliance depends on the model. If the agent ignores the skill, the UX degrades to
   technical prompts. Mitigation: the prompt section in `boot.ts` reinforces the skill.

2. **Auto-advance requires confirmation.** The agent will not proceed without a yes/no
   unless the owner explicitly says "automate everything". This is intentional to prevent
   unintended pipeline runs.

3. **Compact summaries are guidelines.** The agent may occasionally produce longer output.
   The skill instructs conciseness but cannot hard-enforce token limits.

4. **Proactive nudges (Phase 3) are skill-level.** The scheduler job is created by the
   agent via the scheduler tool; if the agent doesn't create it, no nudges fire. The owner
   must explicitly request "enable daily nudges".

5. **Quiet hours are advisory.** The skill instructs the agent to respect them, but there
   is no hard enforcement in code.

6. **Status command depends on file existence.** If the agent can't read `/data/Company-brain`,
   status will be empty. The agent uses bash (which can access `/data`).

7. **Phase 2 (presets) is not implemented.** The skill mentions presets but the loading
   logic is not built. This is a future enhancement.

8. **The pipeline-guide skill is only available when skills are loaded.** In environments
   without the skills directory, the agent won't have these instructions.

---

## Part 4 — Files touched

```
skills/pipeline-guide/SKILL.md          (new)
skills/pipeline-nudge/SKILL.md          (new)
packages/server/src/boot.ts             (prompt section update)
docs/SESSION-REPORT-UX-PIPELINE.md      (this report)
```

## Part 5 — Next steps

- Phase 2: implement preset loading from `/data/Company-brain/presets/`.
- Phase 3 hardening: add code-level quiet-hour enforcement and nudge deduplication.
- Consider a `pipeline_status` tool for programmatic status (currently skill-driven).
- Add agent-side memory for preference storage (auto-advance vs. ask).