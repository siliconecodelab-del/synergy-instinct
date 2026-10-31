---
name: agentrun
description: Author, inspect, validate, dry-run, save, load, and run AgentRun workflows. Use when a task needs checkpoints, structured decisions, recovery, or a multi-step sequence of tool calls that should be inspected before committing. Workflows run under the same policy guard as direct tool calls.
---

# AgentRun

AgentRun workflows are typed, multi-step programs that combine tools, code, judgments (Jev), and agents. Use the `agentrun` tool when a task benefits from:

- **Checkpoints**: recovery records each committed step so an interrupted run resumes without re-executing.
- **Structured decisions**: `judge`/`pick`/`sift`/`route` nodes ask typed questions and branch on answers.
- **Inspection before commit**: `inspect` checks structure, `dry-run` executes on synthetic values with no model call.
- **Multi-step sequencing**: `chain`, `map`, `parallel`, `loop`, `workflow` (child) nodes compose complex logic.

## When to use

Use `agentrun` when the task is more than a single tool call:

| Task | Use |
|---|---|
| Look up one thing and reply | Direct tool call, not a workflow |
| Search, check the answer, escalate if unsure | `agentrun` workflow with `judge` + `agent` + `escalate` |
| Process a list of items, one by one | `agentrun` with `map` |
| Try one of several paths based on data | `agentrun` with `route` |
| Retry until a condition holds | `agentrun` with `loop` |

Do not use `agentrun` for simple lookups or single actions—call the tool directly.

## How to use

1. **`agentrun` with action `"inspect"`** — pass a `workflow` JSON document to check its structure without running.
2. **`agentrun` with action `"dry-run"`** — pass `workflow` and optional `input` to execute on synthetic values. No model, no key, no side effects.
3. **`agentrun` with action `"save"`** — persist a workflow under `<data>/workflows/<name>.json`.
4. **`agentrun` with action `"run"`** — pass `workflow` (or `name` of a saved one) and optional `input` to execute. Runs under the policy guard.

## Workflow shape

A workflow is a v2 JSON document:

```json
{
  "v": 2,
  "name": "example",
  "schemas": { "Input": { ... }, "Output": { ... } },
  "input": { "schemaId": "Input" },
  "output": { "schemaId": "Output" },
  "root": {
    "node": "chain",
    "steps": [
      { "node": "agent", "label": "research", "instructions": "...", "out": "Result", "as": "result" },
      { "node": "judge", "label": "check", "state": { "result": "{result}" }, "out": "Fit", "as": "fit" }
    ]
  }
}
```

## Policy

Workflows run under the same policy guard as direct agent tool calls:

- Capabilities, tiers, grants, spend limits, and approvals all apply.
- A `call` node that needs owner approval blocks until the owner answers.
- Spend (`purchase`, `travel.book`) is audited like any other tool call.

## CLI

```
instinct agentrun inspect <workflow.json>
instinct agentrun validate <workflow.json>
instinct agentrun dry-run <workflow.json> [input.json]
instinct agentrun list [--data-dir <dir>]
instinct agentrun run requires a running agent server
```

## Opt-in

AgentRun is disabled by default. Set `INSTINCT_AGENTRUN=1` to register the `agentrun` tool and enable the prompt section.

## Live judgments

Set `TYPESAFE_API_KEY` for live Jev judgments. Without it, `runJudge` uses a fixed-probability offline fallback suitable for testing.
