---
name: sop-architect
description: Design, scaffold, validate, and deploy Standard Operating Procedures (SOPs) into the company brain repository, and map out where the human fits vs. where the agent fits within each SOP. Use when a recurring process needs documentation, when the user requests a new SOP, or when running proactive SOP routines/nudges. Invokes generate_dynamic_sop, sop_check_required_tools, sopResearchToolAlternatives, and sop_proactive_nudge.
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
- You need to verify which tools an SOP requires are connected via Composio
- You are setting up or running proactive SOP nudges (`sop_proactive_nudge`) or routine tool-alternative research (`sopResearchToolAlternatives`)

## Required Component: The "Where You Fit vs. Where the Agent Fits" Role Map

Every SOP must treat `execution_classification` (`Manual` | `Hybrid` | `Fully_Automated`) not merely as a formatting switch, but as an **explicit contract of "Where You (the Human) Fit vs. Where the Agent Fits" within the respective SOP** (following Jake Van Clief's framework on human judgment vs. AI execution: https://youtu.be/H2bYz5kIYk4):

| Classification | Human vs. Agent Role Within the SOP | What You Tell the Owner (The User's "Full Map") |
|---|---|---|
| **Manual** | **Human = Executor & Judge.**<br>**Agent = Pacer & Scribe.**<br>Used when every step relies on human relationships, physical action, or bespoke taste. | *"You execute Steps 1..N. I won't run steps behind your back — I'll cue up context before you start, walk you through each step when scheduled, and log your sign-off at checkpoints."* |
| **Hybrid** | **Agent = Draftsman / Clerk.**<br>**Human = Editor / Taste Gatekeeper.**<br>Agent handles the 0-to-80% mechanical prep; human steps in only at judgment/approval gates. | *"I handle Steps [X, Y] autonomously (gathering data & prepping drafts) and pause to text you at Checkpoint Step [Z] for your review/approval before finishing."* |
| **Fully_Automated** | **Agent = Full Executor.**<br>**Human = Architect & Exception Handler.**<br>Rules and verification are clear enough for end-to-end execution. | *"Zero manual steps during normal runs — I run Steps 1..N end-to-end and only text you a compact completion summary or if an exception needs your call."* |

Whenever `generate_dynamic_sop` finishes, **always include the Role Map summary (`Summary for Owner`) in your reply** so the human immediately sees their exact scope of involvement in the SOP.

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

### sop_proactive_nudge

Proactive, role-aware routines and nudges for SOPs (gated by `nudge_gate` quiet hours 22:00–07:00 and 1/day deduplication):

| Action | Parameters | What it does |
|---|---|---|
| `scan` | — | Scans all SOPs in `/data/Company-brain/SOPs` for: (1) disconnected Composio tools blocking an SOP, (2) `Hybrid` SOPs with 5+ consecutive unedited checkpoint approvals ready to graduate to `Fully_Automated`, and (3) newly documented SOPs not yet active/scheduled. Returns a role-aware nudge message tailored to `Manual`, `Hybrid`, or `Fully_Automated`. |
| `enable_schedule` | `cron` (optional, default `"0 9 * * *"`) | Registers a daily 09:00 `Scheduler` job (`sop-proactive-nudge-daily`) that runs `scan` and nudges the owner at most once per day. |
| `record_checkpoint_approval` | `sop_title`, `target_department`, `edited` (boolean) | Records when the owner approves a `Hybrid` checkpoint. If `edited: false` 5 times in a row, surfaces a **Graduation Nudge**: *"You've approved the checkpoint in '<title>' 5 times in a row without edits. Want to take yourself out of the loop and graduate this SOP from Hybrid to Fully Automated? (yes/no)"* |
| `graduate` | `sop_title`, `target_department` | Upgrades a `Hybrid` SOP to `Fully_Automated` on disk and in `PipelineStore`, updating its Role Map so the agent runs all steps end-to-end. |

### sop_check_required_tools

Check which tools referenced by an existing SOP are connected via Composio, and get OAuth connect links for missing ones.

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | The title of the SOP to check |
| `target_department` | string | Owning department of the SOP |

Returns connection status for each required tool and OAuth connect links for tools that are configured but not yet connected.

### sopResearchToolAlternatives

Schedule a weekly deep-research job that checks for alternative tools for each tool required by an SOP, compares them on price, open-source/free availability, and features, and reports back to the owner.

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | The title of the SOP to research tools for |
| `target_department` | string | Owning department of the SOP |
| `schedule_cron` | string | Optional. Cron expression (5 fields: minute hour day month weekday). Default: `"0 9 * * 1"` (Mondays 9am UTC) |

After creating an SOP, you can also ask the owner:

*"Would you like me to routinely research alternative tools for the tools in this SOP? I can check weekly for alternatives, compare them on price, open-source/free availability, and features, and send you a brief summary."*

If the owner says yes, call `sopResearchToolAlternatives` with the SOP's title and department.

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