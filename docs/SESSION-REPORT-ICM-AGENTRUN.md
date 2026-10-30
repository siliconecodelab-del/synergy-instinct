# Session Report: ICM → AgentRun Pipeline and Supporting Work

Date: 2026-10-30

This report documents (1) the end-to-end pipeline from an SOP to an ICM workspace to an
AgentRun DSL workflow, and (2) everything implemented in this session, with examples and
verification steps.

---

## Part 1 — Pipeline: SOP → ICM → ICM run → AgentRun DSL → DSL run

### Stage 1: Create an SOP

**Goal:** produce an OKF-compliant SOP in the company brain.

**iMessage prompt (example):**
> "Draft an SOP for Gmail inbox triage under GTM-playbook. Steps: check unread, label urgent, reply to VIPs, archive noise. Required tools: gmail."

**What happens:**
- With `INSTINCT_AGENTRUN=1`, the agent invokes `generate_dynamic_sop` with
  `sop_title`, `target_department`, `execution_classification`, `core_objective`,
  `required_tools_or_skills`, `raw_procedural_steps`.
- The SOP is written to `/data/Company-brain/SOPs/gtm-playbook/gmail-inbox-triage.md`.
- `sop_check_required_tools` reports connection status for each required tool
  (e.g. `gmail: connected` or `not_connected` with an OAuth link).

**Verification:**
```bash
# on the agent (via bash) or via Maritime files API
cat /data/Company-brain/SOPs/gtm-playbook/gmail-inbox-triage.md
```

**Expected output (excerpt):**
```yaml
---
title: Gmail inbox triage
department: GTM-playbook
required_tools_status:
  gmail: connected
---
# ... steps ...
```

---

### Stage 2: Translate the SOP into an ICM workspace

**Goal:** turn the SOP into a folder-as-architecture (ICM) layout.

**iMessage prompt (example):**
> "Convert the Gmail inbox triage SOP into an ICM workspace under
> /data/Company-brain/SOPs/gtm-playbook/: create an entry file `AGENTS.md` that routes
> to `stages/triage.md`, and put the SOP steps into that stage contract. Make sure every
> path resolves."

**Expected layout:**
```
/data/Company-brain/SOPs/gtm-playbook/
  AGENTS.md          # L0 entry: routes "triage email" -> stages/triage.md
  stages/
    triage.md        # L2 contract: what to do, names inputs
  inputs/            # L4 material (optional)
```

**Verification:**
```bash
find /data/Company-brain/SOPs/gtm-playbook -type f
# AGENTS.md
# stages/triage.md
```

---

### Stage 3: Run the workflow defined by the ICM

**Goal:** validate the ICM with `workflow-tracer` and (optionally) execute it manually.

**iMessage prompt (example):**
> "Using the ICM workspace you just created, trace the route for 'triage email' with
> workflow-tracer."

**What happens:**
- The agent uses the `workflow_trace` tool (or the skill) to:
  1. `tree <root> -d <outDir>` — scan the folder.
  2. `read <path> -d <outDir> --layer L0/L1/L2/... --why "..."` — record each file opened.
  3. `done -d <outDir> --task "triage email"` — compute the four checks and write `trace.html`.
- The tracer never does the task; it only records the route.

**Expected verdicts (all four should pass for a well-built ICM):**
```
PASS Control point within entry + 2 reads - stage contract reached at read 3
PASS Contract plus inputs under 8,000 tokens - ~1,200 tokens across L2-L4
PASS Routed by the catalog, not by search - 0 scan(s), 0 dead end(s)
PASS Every path read exists - all resolved
```

**Verification:**
```bash
ls /data/.../trace.html   # or wherever the outDir is (recommendation: workspace/traces/)
```

---

### Stage 4: Translate the ICM into an AgentRun DSL workflow

**Goal:** convert the stage contract into a typed, recoverable workflow.

**iMessage prompt (example):**
> "Convert the ICM stage contract for Gmail triage into an AgentRun DSL workflow named
> `gmail-triage` with the same steps and inputs. Set a preflight on the ICM root so it
> cannot run unless the tracer passes."

**What happens:**
- The agent uses the `agentrun` tool to author a workflow with nodes matching the SOP
  steps (e.g. `read_inbox`, `label_urgent`, `reply_vip`, `archive_noise`).
- The workflow's `preflight.icmRoot` is set to the ICM root, and `preflight.task` to
  "triage email".
- Before any step runs, `runWorkflowWithRecovery` calls `runPreflight`, which checks
  `trace.json` for all four verdicts passing. If any fails, the run escalates with
  `reason: "preflight_failed"` and no step executes.

**Verification (conceptual):**
```json
{
  "status": "escalated",
  "escalation": { "reason": "preflight_failed", "checks": [ { "name": "Catalog", "pass": false, "note": "1 scan(s)" } ] }
}
```
or, on success:
```json
{ "status": "complete", "output": { ... } }
```

---

### Stage 5: Run the workflow defined by the DSL

**iMessage prompt (example):**
> "Run the AgentRun workflow `gmail-triage` for 'triage email'."

**What happens:**
- `runWorkflowWithRecovery` runs the pre-flight (must pass), then executes steps in
  order with recovery/checkpointing. Decisions are recorded under
  `/data/agentrun/decisions/` and run journals under `/data/agentrun/runs/`.

**Verification:**
```bash
ls /data/agentrun/runs/ /data/agentrun/decisions/
```

---

## Part 2 — Everything implemented in this session

### A. Gateway: connect/reprovision/reconnect propagation (code + deploy)

**Problem:** saving brain/Postiz on the connect page updated the store but did not push
the changes to the running agent container (no env sync, no container bounce).

**Changes:**
- `packages/gateway/src/server.ts` — `handleConnectUpdate`: brain push + Postiz account
  mint now run in a single background async that ends with `healPostizAccount` +
  `syncAgentEnv` (container stop → start), so `COMPOSIO_TOOLKITS` (with/without
  `custom_postiz`) and rotated keys actually reach the agent.
- `packages/gateway/src/server.ts` — `handleAdminReprovision`: re-pushes the company
  brain before syncing env.
- `packages/gateway/src/provision.ts` — ready-agent reconnect branch: re-pushes the
  company brain alongside Postiz/Oxygen heals and env sync.
- `packages/gateway/src/provision.ts` — `agentEnvFor`: injects `INSTINCT_AGENTRUN=1`
  by default for all current and future agents (unless overridden).
- `docs/CONNECT-REPROVISION-FLOW.md` + README link: detailed execution-flow docs.
- `deploy/Dockerfile.gateway`: added `packages/agentrun` to the deps stage.
- `pnpm-lock.yaml`: regenerated for frozen-lockfile builds.

**Deployed to VM (92.4.130.36):** gateway rebuilt and restarted; reprovisioned
`usr_64ef1ba5a45ee067` (`synced: 4`, `refreshed: true`); verified
`INSTINCT_AGENTRUN = 1` and `COMPOSIO_TOOLKITS` includes `custom_postiz`.

### B. Company-brain root separation (docs + prompt)

**Problem:** two "brain" roots (`/data/brain` mirror vs `/data/Company-brain` authored)
were undocumented and the agent didn't know about `/data/brain`.

**Changes:**
- `docs/EXECUTOR-BRAIN.md`: added "The two company-brain roots" section with a table,
  rules of thumb, and rationale for not merging.
- `packages/server/src/boot.ts`: when either root exists, inject a prompt section
  naming both roots and their write semantics (mirror vs. authored).

### C. workflow-tracer integration (skill + tool + pre-flight)

**Changes:**
- Vendored `skills/workflow-tracer/` (SKILL.md, `scripts/tracer.py`, assets, references).
- `packages/agentrun/src/workflow-tracer.ts`: `resolveTracerScript`, `runTracerCommand`,
  `readTraceResult`, `runPreflight`.
- `packages/agentrun/src/tool.ts`: added `workflowTraceTool` (wraps tracer subcommands).
- `packages/agentrun/src/types.ts`: added `PreflightSpec`, preflight fields on
  `AgentRunResult`.
- `packages/agentrun/src/runner.ts`: runs `runPreflight` before any step when
  `workflow.preflight` is set; escalates with `preflight_failed` on any failing check.
- `packages/server/src/boot.ts`: registers `workflowTraceTool` and advertises it +
  pre-flight in the AgentRun prompt section.
- `packages/agentrun/src/index.ts`: exports new module/types/tool.
- `packages/agentrun/test/workflow-tracer.test.ts`: 3 tests.
- `docs/SESSION-REPORT-ICM-AGENTRUN.md`: this report.

### D. Verification summary

| Package | Tests | Result |
|---|---|---|
| `@open-instinct/gateway` | 176 | pass |
| `@open-instinct/agentrun` | 39 | pass |
| `@open-instinct/server` | 117 | pass |

### E. Known limitations

- The pre-flight check verifies a **completed** trace exists (`trace.json` with all
  four verdicts passing). The actual cold walk must still be performed by the agent (or a
  cold subagent) using `workflow_trace` before running the workflow; the runner does not
  walk the workspace itself.
- The tracer requires Python 3.10+ on the agent image (present per the Maritime BYO
  contract).
- The two-roots prompt note ships with the next agent image rebuild (gateway image was
  rebuilt; agent image rebuild is deferred to the next code push).
- ICM → AgentRun DSL translation is not fully automated; it relies on agent reasoning
  guided by the skill.

### F. Key files touched

```
packages/gateway/src/server.ts
packages/gateway/src/provision.ts
packages/gateway/src/main.ts          (unchanged default, env var overrides)
packages/server/src/boot.ts
packages/agentrun/src/types.ts
packages/agentrun/src/runner.ts
packages/agentrun/src/workflow-tracer.ts
packages/agentrun/src/tool.ts
packages/agentrun/src/index.ts
packages/agentrun/test/workflow-tracer.test.ts
skills/workflow-tracer/...
docs/EXECUTOR-BRAIN.md
docs/CONNECT-REPROVISION-FLOW.md
docs/SESSION-REPORT-ICM-AGENTRUN.md
deploy/Dockerfile.gateway
pnpm-lock.yaml
```