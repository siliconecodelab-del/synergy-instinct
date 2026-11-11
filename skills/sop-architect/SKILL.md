---
name: sop-architect
description: Design, scaffold, validate, and deploy Standard Operating Procedures (SOPs) into the company brain repository, and map out where the human fits vs. where the agent fits within each SOP — as text and as a delivered visual Role Map (animated GIF, interactive web link, one-page PDF). Use when a recurring process needs documentation, when the user requests a new SOP, or when running proactive SOP routines/nudges. Invokes generate_dynamic_sop, sop_check_required_tools, sop_visualize_role_map, sopResearchToolAlternatives, and sop_proactive_nudge.
---

# SOP Architect

Designs OKF-compliant Standard Operating Procedures (SOPs), deploys them into the company brain repository at `<data>/Company-brain/SOPs/<department>/<sop_title>.md`, and gives the owner a clear **"Full Map" of where their role/involvement is vs. what the agent handles** within that SOP.

> **Core UX Principle:** The underlying `SOP -> ICM -> Tracer -> AgentRun DSL` pipeline is the internal execution engine and is **abstracted away from the user**. The user interacts with their **SOP** and their **Role Map** within it (`Manual`, `Hybrid`, or `Fully_Automated`).

## When to invoke

Use this skill when:

- A recurring process is detected that lacks documentation
- The user requests a new SOP ("create an SOP for X", "document how we do Y")
- An existing SOP needs updating, versioning, or graduating from `Hybrid` to `Fully_Automated`
- A process needs to be classified by execution type (`Manual` / `Hybrid` / `Fully_Automated`) so the owner knows where they fit in the execution flow
- The owner asks for a visual of an SOP ("show me the map", "send the role map") or an SOP was just created/graduated and its visual Role Map is due
- You need to verify which tools an SOP requires are connected via Composio
- You are setting up or running proactive SOP nudges (`sop_proactive_nudge`) or routine tool-alternative research (`sopResearchToolAlternatives`)

## Required Component: The "Where You Fit vs. Where the Agent Fits" Role Map

Every SOP must treat `execution_classification` (`Manual` | `Hybrid` | `Fully_Automated`) not merely as a formatting switch, but as an **explicit contract of "Where You (the Human) Fit vs. Where the Agent Fits" within the respective SOP** (following Jake Van Clief's framework on human judgment vs. AI execution: https://youtu.be/H2bYz5kIYk4):

| Classification | Human vs. Agent Role Within the SOP | What You Tell the Owner (The User's "Full Map") |
|---|---|---|
| **Manual** | **Human = Executor & Judge.**<br>**Agent = Pacer & Scribe.**<br>Used when every step relies on human relationships, physical action, or bespoke taste. | *"You execute Steps 1..N. I won't run steps behind your back — I'll cue up context before you start, walk you through each step when scheduled, and log your sign-off at checkpoints."* |
| **Hybrid** | **Agent = Draftsman / Clerk.**<br>**Human = Editor / Taste Gatekeeper.**<br>Agent handles the 0-to-80% mechanical prep; human steps in only at judgment/approval gates. | *"I handle Steps [X, Y] autonomously (gathering data & prepping drafts) and pause to text you at Checkpoint Step [Z] for your review/approval before finishing."* |
| **Fully_Automated** | **Agent = Full Executor.**<br>**Human = Architect & Exception Handler.**<br>Rules and verification are clear enough for end-to-end execution. | *"Zero manual steps during normal runs — I run Steps 1..N end-to-end and only text you a compact completion summary or if an exception needs your call."* |

Whenever `generate_dynamic_sop` finishes, **always include the Role Map summary (`Summary for Owner`) in your reply** so the human immediately sees their exact scope of involvement in the SOP. Then **run `sop_visualize_role_map` for that SOP in the same turn and deliver it** (unless the owner's format default is `off`) — see the tool section below.

## Tools

### generate_dynamic_sop

Call this tool with the following parameters:

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | The title of the procedure (becomes the filename) |
| `target_department` | string | Owning department (e.g. `GTM-playbook`, `Research-and-Dev`). Becomes the `<SOP_root_dir>` |
| `execution_classification` | `"Manual"` \| `"Hybrid"` \| `"Fully_Automated"` | How the procedure is executed. Generates the `## Role Map: Where You Fit vs. Where the Agent Fits` section and seeds `PipelineStore` |
| `core_objective` | string | Brief summary of the SOP's goal |
| `required_tools_or_skills` | string[] | List of tools or skills needed (e.g. `["gmail", "notion", "slack"]`). If omitted, defaults to the agent's configured `COMPOSIO_TOOLKITS`. |
| `raw_procedural_steps` | string | Markdown-formatted instructions, steps, or notes forming the body |

**What `generate_dynamic_sop` does automatically:**
1. Builds the OKF markdown with an explicit `## Role Map: Where You Fit vs. Where the Agent Fits` section.
2. Annotates steps with owners and human checkpoints (`Hybrid` automatically identifies review/approval steps as `Human (Taste / Approval Gate)` and remaining steps as `Agent`).
3. Seeds a `PipelineStore` record with the SOP's `classification` so background compilation and proactive nudges know how to handle it.
4. Checks `required_tools_or_skills` against Composio and reports connected vs. disconnected tools.

### sop_visualize_role_map

Renders the SOP's Role Map as a **visual artifact** — You / Agent / Tools swimlanes showing every step plus *Where You (Human) Fit vs. Where the Agent Fits* for its execution classification — and returns the workspace paths plus the exact next tool calls to deliver it.

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | Title of an existing SOP |
| `target_department` | string | Owning department of the SOP |
| `format` | `"gif"` \| `"mp4"` \| `"pdf"` \| `"web"` \| `"all"` \| `"off"` | What to render. **Omit to use the owner's stored default** (`gif` unless changed). `all` renders web + gif + mp4 + pdf |
| `set_as_default` | boolean | Also save `format` as the owner's default for future Role Maps (requires `format`; `off` turns off auto-delivery) |

**What it renders:**

1. **gif (default)** — animated walkthrough that steps through the procedure and lights up your checkpoints/handoffs. Stays under iMessage's 10 MB inline limit. Delivered with `send_file`.
2. **web** — interactive standalone HTML written to `workspace/apps/sop-<slug>/index.html`. Deploy with `ample_deploy {"path": "apps/sop-<slug>"}` and paste the returned URL.
3. **pdf** — one-page playbook (map image + steps table + Role Map text) at `workspace/sop-maps/<slug>.pdf`. Delivered with `send_file`.

**When to run it:**

- Right after `generate_dynamic_sop` succeeds — once the SOP exists, never during creation (keep SOP creation fast).
- Right after `sop_proactive_nudge` `graduate` — graduating `Hybrid` → `Fully_Automated` moves the lanes, so the map must be refreshed and re-sent.
- Whenever the owner asks to see, show, or send an SOP's map.

**Deliver in the same turn:** the tool output ends with `Next tool calls (deliver now, in this same turn)` — follow them in order: `send_file` the default artifact with its caption, run `ample_deploy` and share the returned URL as the interactive link, and mention any offered extra (e.g. the PDF) in the same message. If the tool returns `Notes` about a missing renderer, send what was produced and tell the owner plainly which format was skipped — never block or fail the SOP itself over a visual.

### sop_proactive_nudge

Proactive, role-aware routines and nudges for SOPs (gated by `nudge_gate` quiet hours 22:00–07:00 and 1/day deduplication):

| Action | Parameters | What it does |
|---|---|---|
| `scan` | — | Scans all SOPs in `/data/Company-brain/SOPs` for: (1) disconnected Composio tools blocking an SOP, (2) `Hybrid` SOPs with 5+ consecutive unedited checkpoint approvals ready to graduate to `Fully_Automated`, and (3) newly documented SOPs not yet active/scheduled. Returns a role-aware nudge message tailored to `Manual`, `Hybrid`, or `Fully_Automated`. |
| `enable_schedule` | `cron` (optional, default `"0 9 * * *"`) | Registers a daily 09:00 `Scheduler` job (`sop-proactive-nudge-daily`) that runs `scan` and nudges the owner at most once per day. |
| `record_checkpoint_approval` | `sop_title`, `target_department`, `edited` (boolean) | Records when the owner approves a `Hybrid` checkpoint. If `edited: false` 5 times in a row, surfaces a **Graduation Nudge**: *"You've approved the checkpoint in '<title>' 5 times in a row without edits. Want to take yourself out of the loop and graduate this SOP from Hybrid to Fully Automated? (yes/no)"* |
| `graduate` | `sop_title`, `target_department` | Upgrades a `Hybrid` SOP to `Fully_Automated` on disk and in `PipelineStore`, updating its Role Map so the agent runs all steps end-to-end. **After graduating, run `sop_visualize_role_map` and deliver the refreshed map.** |

### sop_check_required_tools

Check which tools referenced by an existing SOP are connected via Composio, and get OAuth connect links for missing ones.

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | The title of the SOP to check |
| `target_department` | string | Owning department of the SOP |

Returns connection status for each required tool and OAuth connect links for tools that are configured but not yet connected.

### sopResearchToolAlternatives

Schedule, run immediately, list, or unschedule a **3-Tier Deep Research** job that discovers and compares tools for an SOP across:
1. **Tier 1 — Native Composio Catalog (`COMPOSIO_SEARCH_TOOLS`)**: Direct toolkit slug, auth mode (`OAuth`, `API_KEY`, `NoAuth`), and actions.
2. **Tier 2 — Open-Source Tools (Self-Hostable / BYOK)**: GitHub & MCP registry discovery, open-source license (MIT/Apache-2.0/Fair-code), `$0` self-hosted vs. managed cloud pricing, and official/community **MCP Server** or **REST/GraphQL API** availability.
3. **Tier 3 — Closed / Proprietary SaaS Tools**: Commercial alternatives, Free-tier limits, Starter/Pro monthly pricing (`$X/mo`), **API/MCP paywall gating warnings** (flagging if API/MCP is locked behind an Enterprise plan), and remote **MCP Server / REST API** connectivity.

**Step-Level Capability Discovery for Manual SOPs:**
- If an SOP already defines `required_tools_or_skills`, `sopResearchToolAlternatives` researches alternatives for each tool **plus** checks whether any `Human`-owned steps can be offloaded.
- If a `Manual` SOP has **`0` initial tools** (`required_tools_or_skills: []`), `sopResearchToolAlternatives` automatically switches to **Step-Level Capability Discovery** (`mode: "steps"`), analyzing each step in `## Procedural Steps` to discover MCP/API tools that can move mechanical steps from `Your Scope (Human)` to `Agent Scope`.

**Free Deep Research MCP Stack (`composio_search` + `deep-research` skill):**
Uses the standalone `deep-research` skill (`load_skill` with `name: "deep-research"`) powered by Composio's built-in, **No-Auth (`isNoAuth: true`) `composio_search` toolkit** on the existing `COMPOSIO_API_KEY` (`COMPOSIO_SEARCH_EXA_ANSWER`, `COMPOSIO_SEARCH_TAVILY`, `COMPOSIO_SEARCH_WEB`) alongside `COMPOSIO_SEARCH_TOOLS` (plus optional free-tier `exa`, `tavily`, `firecrawl`).

| Parameter | Type | Description |
|---|---|---|
| `action` | `"schedule"` \| `"run_now"` \| `"list"` \| `"unschedule"` | Optional (default `"schedule"`). `"schedule"` creates the weekly cron; `"run_now"` returns the 3-tier Deep Research execution brief immediately; `"list"` shows all configured SOP research jobs; `"unschedule"` removes the cron job |
| `sop_title` | string | The title of the SOP to research tools for (required for `schedule`, `run_now`, `unschedule`) |
| `target_department` | string | Owning department of the SOP (required for `schedule`, `run_now`, `unschedule`) |
| `schedule_cron` | string | Optional. Cron expression (5 fields: minute hour day month weekday). Default: `"0 9 * * 1"` (Mondays 9am UTC) |
| `include_open_source` | boolean | Optional (default `true`). Include Tier 2 Open-Source (self-hostable / BYOK) candidates |
| `include_proprietary` | boolean | Optional (default `true`). Include Tier 3 Closed / Proprietary SaaS candidates with pricing & API-tier gating |
| `require_api_or_mcp` | boolean | Optional (default `true`). Prioritize tools with MCP server or REST/GraphQL API connectivity and flag UI-only tools |

**Required Comparison Table in Research Briefs (`workspace/research/sop-<slug>-tool-alternatives-<date>.md`):**

| Target Tool / Step | Candidate | Category (`Composio` / `Open-Source` / `Closed SaaS`) | Connectivity (`MCP` / `API` / `Composio Slug`) | Pricing (Free Tier / Paid / Self-Hosted) | API Tier Gating | Role Map Impact ("Where You Fit") |
|---|---|---|---|---|---|---|

After creating an SOP (even a `Manual` SOP with no initial tools), ask the owner:

*"Would you like me to research MCP/API-ready tools for this SOP across Composio, Open-Source (self-hostable), and Closed SaaS (with pricing and API-tier checks) — either right now (`run_now`) or on a weekly schedule (`schedule`) — to see which steps I can take off your plate?"*

## Output

The SOP is written as a markdown file to:

```
<data>/Company-brain/SOPs/<target_department-kebab-case>/<sop_title>.md
```

The file follows the Open Knowledge Format (OKF) schema with YAML frontmatter, the `## Role Map: Where You Fit vs. Where the Agent Fits` section, and structured procedural steps.

## Do not

- Do not expose internal engine jargon (`ICM`, `workflow_trace`, `AgentRun DSL`) when explaining the SOP Role Map to the owner — frame everything in terms of the SOP steps and where the owner fits vs. where the agent fits
- Do not create SOPs without explicit user request or a detected recurring process
- Do not overwrite an existing SOP without confirmation (use `graduate` when upgrading `Hybrid` -> `Fully_Automated`)
- Do not include secrets, API keys, or credentials in `raw_procedural_steps` or `required_tools_or_skills`
- Do not skip the walk-through validation: every SOP must state its Role Map, owner, trigger, and exit criteria