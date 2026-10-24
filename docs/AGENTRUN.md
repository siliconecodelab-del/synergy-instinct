# AgentRun Integration

Open Instinct integrates [AgentRun](https://github.com/Parcha-ai/agentrun) — a typed workflow DSL for agents — so the agent can author, inspect, validate, dry-run, save, load, and run multi-step workflows with checkpoints and structured decisions.

## What it adds

| Component | Purpose |
|---|---|
| `@open-instinct/agentrun` | New workspace package bridging AgentRun to Open Instinct's Pi runtime, tool registry, policy engine, and approval flow. |
| `agentrun` tool | Lets the agent author, inspect, validate, dry-run, save, load, list, and run workflows from chat. |
| `instinct agentrun` CLI | `inspect`, `validate`, `dry-run`, `list` subcommands for local workflow files. |
| `skills/agentrun/SKILL.md` | Playbook telling the model when to use workflows vs. direct tool calls. |

## Architecture

The integration maps AgentRun's three host adapters to Open Instinct:

- **`runEffect`** — dispatches workflow `call` nodes through Open Instinct's `ToolRegistry`, subject to the same `PolicyEngine` guard (tiers, grants, spend, approvals) as direct agent tool calls. Full tool surface is available; policy still applies.
- **`runNode`** — runs a Pi `Conversation` with the node's projected input and captures a schema-checked structured result via a `__agentrun_result__` capture tool.
- **`runJudge`** — answers typed questions via `@parcha/agentrun-jev`'s `createJevRunner` (live, needs `TYPESAFE_API_KEY`) or a fixed-probability offline fallback (dev/testing).

Durability uses `@parcha/agentrun-dsl/recovery` with `fileStore` under `<data>/agentrun/runs/` and decision receipts under `<data>/agentrun/decisions/`.

## Opt-in

AgentRun is disabled by default. Enable it:

```bash
export INSTINCT_AGENTRUN=1
```

When enabled, `boot()` registers the `agentrun` tool and adds an AgentRun section to the system prompt.

## Live judgments (Jev)

Set `TYPESAFE_API_KEY` for live Jev system-one decisions. Without it, `runJudge` uses a fixed-probability fallback that always answers with 95% confidence — suitable for testing but not for consequential decisions.

```bash
export TYPESAFE_API_KEY=your-key
export TYPESAFE_BASE_URL=https://your-gateway.example.com  # optional
```

## Pi version requirement

`@parcha/agentrun-pi` (the `/agentrun` Pi extension) requires Pi 1.0.4 to below 1.4. Open Instinct's Pi dependencies were upgraded from `^1.0.1` to `>=1.0.4 <1.4.0` to support it. The core AgentRun integration (`@parcha/agentrun-dsl` + `@parcha/agentrun-jev`) does not require Pi and works with any Pi 1.0.x.

## CLI usage

```bash
# Validate a workflow file
instinct agentrun inspect workflow.json
instinct agentrun validate workflow.json

# Dry-run on synthetic values (no model, no key)
instinct agentrun dry-run workflow.json
instinct agentrun dry-run workflow.json input.json

# List saved workflows
instinct agentrun list --data-dir /data

# Run requires a running agent server; call the `agentrun` tool from chat instead.
```

## Workflow storage

Saved workflows live under `<data>/workflows/<name>.json`. Run journals live under `<data>/agentrun/runs/<run-id>/`. Decision receipts live under `<data>/agentrun/decisions/<receipt-id>.json`.

## Limitations

- `code` nodes run in-process (not sandboxed). Untrusted workflow authors need a host-controlled sandbox via `deps.runCode`.
- `call` nodes only support `via: "tool"` (not `executor` or `shell` transports).
- `run` via CLI is not yet supported; use the `agentrun` tool from chat against a running server.
