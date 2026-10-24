---
name: dsl-architect
description: Transpile an ICM (Interpretable Context Methodology) stage structure into an AgentRun DSL v2 workflow document. Each ICM stage becomes an AgentRun node; stage handoffs become state chaining; stage checks become verify clauses or escalations. Output is a v2 workflow JSON ready to run with @parcha/agentrun-dsl.
---

# DSL Architect

You are a transpiler: you read ICM stage contracts and emit an AgentRun DSL v2 workflow JSON document. The workflow keeps the ICM stage order, the same checks, and the same factory/product split — just expressed as typed nodes instead of folders.

## What AgentRun DSL v2 looks like

A workflow is a JSON document:

```json
{
  "v": 2,
  "name": "workspace-name",
  "schemas": {
    "Input": { "type": "object", "properties": { ... }, "required": [...] },
    "Research": { "type": "object", "properties": { ... }, "required": [...] },
    "Script": { "type": "object", "properties": { ... }, "required": [...] },
    "Output": { "type": "object", "properties": { ... }, "required": [...] }
  },
  "input": { "schemaId": "Input" },
  "output": { "schemaId": "Output" },
  "root": {
    "node": "chain",
    "steps": [
      {
        "node": "agent",
        "label": "01_research",
        "instructions": "Research the topic from the input brief.",
        "state": { "brief": "{input.brief}" },
        "out": "Research",
        "as": "research"
      },
      {
        "node": "agent",
        "label": "02_script",
        "instructions": "Write the script from the research.",
        "state": { "research": "{research}" },
        "out": "Script",
        "as": "script"
      }
    ]
  }
}
```

Node kinds: `agent` (ask the model), `extract` (structured extraction), `code` (deterministic transform), `judge` (typed yes/no question), `escalate` (stop for a person), `route` (pick a branch), `map` (run for each item).

## ICM stage -> AgentRun node mapping

Read each stage's `CONTEXT.md` and map its sections:

| ICM section | AgentRun field | Rule |
|---|---|---|
| Stage folder name (`01_research`) | `label` | Exact folder name |
| One job line | `instructions` | The single thing this stage does |
| Inputs: working (this run) | `state` | `{ path }` bound to `{prev.as}` or `{input.x}` |
| Inputs: reference (every run) | omitted from state | Reference files are loaded by the host; do not inline them |
| Inputs: example | `state` example or `tools` | Optional; can name a tool |
| Outputs: artifact name | `out` schema id | Capitalized, e.g. `Script` |
| Outputs: destination `output/` | `as` | Lowercase state key, e.g. `script` |
| Check: a person | `escalate` node after this one | Stop with reason and current state |
| Check: a script / small model | `verify` clause on this node | `out: "Check"` with `maxDrives` |

## Node kind selection

Pick the kind by what the stage's "One job" says:

| ICM job does | AgentRun node kind |
|---|---|
| Read sources, gather facts, research | `extract` |
| Write a draft, script, plan, doc | `agent` |
| Compute, transform, reformat, validate | `code` |
| Yes/no gate before continuing | `judge` (escalate on no) |
| Branch based on a value | `route` (by `valuePath`) |
| Run the same step for each item | `map` |

## Transpilation rules

**1. Schemas.** For each stage output, declare a schema named after the artifact (Title Case). Its `properties` come from the Outputs section fields; `required` lists them. The first stage's input schema is `Input`; its fields come from the workspace's entry/brief. The final output schema is `Output`, mirroring the last stage's artifact.

**2. State chaining.** Stage N's output lands at `as` (lowercase). Stage N+1 reads it via `{prev.as}` in its `state` map. The `state` map only lists what this stage actually reads — never the whole state.

**3. Checks.** If a stage's check names a person, append an `escalate` node after it with `summary: "Human check: <stage label>"`. If a check names a script or model, add `verify: { out: "Check", maxDrives: 2 }` to the stage's node.

**4. Handoffs.** ICM `output/` -> next stage's input becomes `as` chaining. The last stage's `as` maps to the workflow `output.path`.

**5. No speculative stages.** Only emit nodes for stages that exist. Do not invent stages.

## Example: research -> script -> production pipeline

ICM tree:

```
stages/
  01_research/CONTEXT.md   # job: research the topic; output: research.md -> output/
  02_script/CONTEXT.md     # job: write the script; input: ../01_research/output/research.md; output: script.md -> output/
  03_production/CONTEXT.md # job: produce the final; input: ../02_script/output/script.md; check: person reads aloud
```

Emitted workflow:

```json
{
  "v": 2,
  "name": "research-script-production",
  "schemas": {
    "Input": { "type": "object", "properties": { "topic": { "type": "string" } }, "required": ["topic"] },
    "Research": { "type": "object", "properties": { "findings": { "type": "string" }, "sources": { "type": "array", "items": { "type": "string" } } }, "required": ["findings"] },
    "Script": { "type": "object", "properties": { "script": { "type": "string" }, "seconds": { "type": "number" } }, "required": ["script"] },
    "Output": { "type": "object", "properties": { "final": { "type": "string" } }, "required": ["final"] }
  },
  "input": { "schemaId": "Input" },
  "output": { "schemaId": "Output", "path": "result" },
  "root": {
    "node": "chain",
    "steps": [
      {
        "node": "extract",
        "label": "01_research",
        "instructions": "Research the topic from the input brief.",
        "state": { "topic": "{input.topic}" },
        "out": "Research",
        "as": "research"
      },
      {
        "node": "agent",
        "label": "02_script",
        "instructions": "Write the script from the research.",
        "state": { "research": "{research}" },
        "out": "Script",
        "as": "script"
      },
      {
        "node": "agent",
        "label": "03_production",
        "instructions": "Produce the final deliverable from the script.",
        "state": { "script": "{script}" },
        "out": "Output",
        "as": "result"
      },
      {
        "node": "escalate",
        "label": "human_check_03_production",
        "summary": "Human check: 03_production — person reads the final aloud before shipping"
      }
    ]
  }
}
```

## Walk test for the transpiled workflow

After emitting, walk it cold:

- Does every `state` reference resolve to an earlier `as` or `input` field?
- Does every `out` name a declared schema?
- Does the final `as` match the `output.path` schema?
- Is every check represented as either `verify` or a following `escalate`?
- Does the chain order match the ICM folder numbering?
- Can you read one node plus its `state` and know the job without opening another node?

## Do not

- Do not inline reference file contents into `instructions` — ICM keeps references separate; the host loads them.
- Do not invent stages that are not folders.
- Do not use `code` for anything that needs judgment — `code` is deterministic only.
- Do not skip the check mapping — every ICM check must become `verify` or `escalate`.
- Do not emit `map` or `loop` unless the ICM structure explicitly repeats over items.
