# AgentRun Integration

Open Instinct integrates [AgentRun](https://github.com/Parcha-ai/agentrun) — a typed workflow DSL for agents — so the agent can author, inspect, validate, dry-run, save, load, and run multi-step workflows with checkpoints and structured decisions.

## What it adds

| Component | Purpose |
|---|---|
| `@open-instinct/agentrun` | New workspace package bridging AgentRun to Open Instinct's Pi runtime, tool registry, policy engine, and approval flow. |
| `agentrun` tool | Lets the agent author, inspect, validate, dry-run, save, load, list, and run workflows from chat. |
| `instinct agentrun` CLI | `inspect`, `validate`, `dry-run`, `list`, `run` subcommands. `run` works via HTTP against a running server. |
| `/agentrun` Pi extension | Pi commands (`/agentrun demo`, `/agentrun run`, `/agentrun dry-run`, `/agentrun save`, `/agentrun load`, `/agentrun status`) via `@parcha/agentrun-pi`. |
| `skills/agentrun/SKILL.md` | Playbook telling the model when to use workflows vs. direct tool calls. |

## Architecture

The integration maps AgentRun's three host adapters to Open Instinct:

- **`runEffect`** — dispatches workflow `call` nodes through Open Instinct's `ToolRegistry`, subject to the same `PolicyEngine` guard (tiers, grants, spend, approvals) as direct agent tool calls. Full tool surface is available; policy still applies.
- **`runNode`** — runs a Pi `Conversation` with the node's projected input and captures a schema-checked structured result via a `__agentrun_result__` capture tool.
- **`runJudge`** — answers typed questions via `@parcha/agentrun-jev`'s `createJevRunner` (live, needs `TYPESAFE_API_KEY`) or a fixed-probability offline fallback (dev/testing).
- **`runCode`** — optional sandboxed executor for `code` nodes. When supplied via `deps.runCode`, `code` nodes run in the sandbox instead of in-process.

Durability uses `@parcha/agentrun-dsl/recovery` with `fileStore` under `<data>/agentrun/runs/` and decision receipts under `<data>/agentrun/decisions/`.

## Opt-in

AgentRun is disabled by default. Enable it:

```bash
export INSTINCT_AGENTRUN=1
```

When enabled, `boot()` registers the `agentrun` tool, adds an AgentRun section to the system prompt, and exposes HTTP endpoints under `/agentrun/*`.

## HTTP endpoints (running server)

When `INSTINCT_AGENTRUN=1` and the server is running, these endpoints are available (owner's surface, requires `INSTINCT_CHAT_TOKEN` if set):

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/agentrun/run` | POST | `{ workflow?, name?, input?, runId? }` | Run a workflow (inline or saved by name) |
| `/agentrun/inspect` | POST | `{ workflow: object }` | Validate workflow structure without running |
| `/agentrun/validate` | POST | `{ workflow: object }` | Full semantic validation of a workflow |
| `/agentrun/dry-run` | POST | `{ workflow: object, input?: object }` | Synthetic execution, no model, no key |
| `/agentrun/list` | GET | — | List saved workflows under `<data>/workflows/` |

## Live judgments (Jev)

Set `TYPESAFE_API_KEY` for live Jev system-one decisions. Without it, `runJudge` uses a fixed-probability fallback — suitable for testing but not for consequential decisions.

```bash
export TYPESAFE_API_KEY=your-key
export TYPESAFE_BASE_URL=https://your-gateway.example.com  # optional
```

## Pi extension (`/agentrun` command)

`@parcha/agentrun-pi` (Pi 1.0.4 to below 1.4) provides the `/agentrun` Pi extension. Install it into Pi:

```bash
pi install npm:@parcha/agentrun-pi@beta -l
pi --offline
```

Then inside Pi:
- `/agentrun demo` — run a scripted research workflow
- `/agentrun run` — run a drafted workflow
- `/agentrun dry-run` — dry-run without a model
- `/agentrun save <name>` / `/agentrun load <name>` — persist/load workflow definitions
- `/agentrun status` — check setup
- `/agentrun` — show the workflow graph

Open Instinct's Pi dependencies were upgraded from `^1.0.1` to `>=1.0.4 <1.4.0` to support it. The core AgentRun integration (`@parcha/agentrun-dsl` + `@parcha/agentrun-jev`) does not require Pi and works with any Pi 1.0.x.

Peer dependencies for the Pi extension:
- `@earendil-works/pi-coding-agent` (>=1.0.4 <1.4.0)
- `@earendil-works/pi-tui` (>=1.0.4 <1.4.0)
- `@earendil-works/pi-durable` (>=1.0.4 <1.4.0)
- `@earendil-works/chord` (>=1.0.4 <1.4.0)

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

# Run via HTTP against a running server
curl -X POST http://127.0.0.1:8080/agentrun/run \
  -H "Content-Type: application/json" \
  -d '{"workflow": {...}, "input": {...}}'
```

## Workflow storage

Saved workflows live under `<data>/workflows/<name>.json`. Run journals live under `<data>/agentrun/runs/<run-id>/`. Decision receipts live under `<data>/agentrun/decisions/<receipt-id>.json`.

## Sandboxed `code` nodes

By default, `code` nodes run in-process through AgentRun's own executor (shadowed globals, not a sandbox). To run `code` nodes in a host-controlled sandbox, supply `deps.runCode` when building adapters via `makeAdapters({ runCode, ... })`. The interpreter calls `runCode(node, state, ctx)` for each `code` node and merges the returned patch under the same state rules.

## Limitations

- `call` nodes only support `via: "tool"` (not `executor` or `shell` transports).
- Without `deps.runCode`, `code` nodes run in-process (not sandboxed).
