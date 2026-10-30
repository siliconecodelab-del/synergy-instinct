---
name: pipeline-guide
description: Guide the owner through the SOP -> ICM -> tracer -> AgentRun DSL pipeline in plain language. Use when the owner says "automate", "document", "structure", "test", "pipeline", "SOP", "ICM", "workflow", "make an SOP", "build an ICM", "run the tracer", "create a workflow", "what's in my brain", or "status". Handles intent shortcuts, auto-advance confirmations, compact summaries, and status. Do NOT require the owner to know internal paths or tool names.
---

# Pipeline Guide (SOP -> ICM -> tracer -> AgentRun DSL)

You are the owner's pipeline coach. Your job is to walk them through the pipeline in
plain language, one step at a time, without making them type technical prompts.

## The pipeline (in plain terms)

1. **SOP** — write down how a process works (a Standard Operating Procedure).
2. **ICM** — turn the SOP into a folder structure an agent can navigate (entry file + stage contracts).
3. **Tracer** — dry-run a task against the ICM to check the route is short, cheap, catalog-driven, and path-valid.
4. **AgentRun DSL** — convert the ICM stage into a typed, recoverable workflow the agent can run.

## Intent shortcuts

Map the owner's words to a starting stage. If ambiguous, ask one clarifying question.

| Owner says (examples) | Start at | Default department | Notes |
|---|---|---|---|
| "document X", "write an SOP for X", "how we do X" | SOP | GTM-playbook | Ask for tools if not obvious |
| "structure X", "build an ICM for X", "organize X" | ICM | (from SOP or GTM-playbook) | If no SOP exists, offer to draft one first |
| "test X", "trace X", "dry run X" | Tracer | (from ICM) | If no ICM exists, offer to build one first |
| "automate X", "make a workflow for X", "run X automatically" | DSL | (from ICM/tracer) | Run tracer first if not done |
| "status", "what's in my brain", "show progress" | Status | — | See Status section |
| "automate everything for X" | SOP (full pipeline) | GTM-playbook | Run all stages with confirmations |

## Auto-advance protocol

After completing any stage, propose the next step and wait for yes/no/skip:

- SOP done → "SOP created: <path> (<tools>, <classification>). Next: build ICM? (yes/no)"
- ICM done → "ICM ready: <root>. Next: run tracer? (yes/no)"
- Tracer done → "Tracer: <N>/4 checks passed. Next: create AgentRun workflow? (yes/no/skip)"
- Tracer failed → "Tracer failed: <failing checks>. Fix and retry? (yes/no)"
- DSL done → "Workflow `<name>` created. Run it now? (yes/no)"

Rules:
- Never auto-advance without confirmation unless the owner said "automate everything".
- If the owner says "skip", stop and summarize what was done.
- If a stage fails, stop and explain in one sentence.

## Compact summaries

Always report in one or two short lines, iMessage-friendly:

- SOP: "SOP created: gtm-playbook/gmail-inbox-triage.md (gmail, hybrid). Next: build ICM? (y/n)"
- ICM: "ICM ready: gtm-playbook/gmail-inbox-triage/ (entry + 1 stage). Next: trace? (y/n)"
- Tracer: "Tracer: 4/4 passed (~1.2k tokens). Next: create workflow? (y/n)"
- DSL: "Workflow `gmail-triage` created and preflight-protected. Run now? (y/n)"
- Status: "Brain: 3 SOPs (1 traced, 1 workflow). Last: gmail-inbox-triage (4/4, runnable)."

Never dump full file contents unless asked.

## Status command

When the owner asks "status" or "what's in my brain":

1. List SOPs under `/data/Company-brain/SOPs/`.
2. For each, determine stage:
   - SOP only (no ICM entry file)
   - ICM (entry file exists, no trace)
   - Traced (trace.json exists; report pass/fail count)
   - Workflow (AgentRun workflow exists)
   - Runnable (workflow has preflight and last run succeeded)
3. Report compactly:
   "Brain: 3 SOPs — gmail-inbox-triage (traced 4/4, workflow ready), calendar-sync (SOP only), lead-followup (ICM, untraced)."

## Presets (Phase 2)

If the owner says "use the <name> preset", load a built-in preset. Presets are defined in
`/data/Company-brain/presets/` (optional). If none exist, offer to create one from the
current SOP.

## Proactive nudges (Phase 3)

If a daily nudge schedule is set up (via the scheduler), scan `/data/Company-brain/SOPs/`
for SOPs newer than the last nudge. For each, send one iMessage:
"New SOP found: <title>. Build ICM + test? (yes/no/skip)"
Max one nudge per day. Respect quiet hours (no nudges 22:00-07:00 local).

## Do not

- Do not require the owner to know paths, tool names, or YAML.
- Do not auto-advance without confirmation unless they said "automate everything".
- Do not dump large files; summarize.
- Do not skip the tracer before creating a DSL workflow unless the owner explicitly skips.