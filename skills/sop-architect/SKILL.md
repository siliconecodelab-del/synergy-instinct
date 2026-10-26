---
name: sop-architect
description: Design, scaffold, validate, and deploy Standard Operating Procedures (SOPs) into the company brain repository. Use when a recurring process needs documentation, or when the user requests a new SOP. Invokes generate_dynamic_sop with sop_title, target_department, execution_classification, core_objective, required_tools_or_skills, and raw_procedural_steps. Also invokes sop_check_required_tools to verify Composio tool connections and sopResearchToolAlternatives to schedule routine tool-alternative research.
---

# SOP Architect

Designs OKF-compliant Standard Operating Procedures (SOPs) and deploys them into the company brain repository at `<data>/Company-brain/SOPs/<department>/<sop_title>.md`.

## When to invoke

Use this skill when:

- A recurring process is detected that lacks documentation
- The user requests a new SOP ("create an SOP for X", "document how we do Y")
- An existing SOP needs updating or versioning
- A process needs to be classified by execution type (Manual / Hybrid / Fully_Automated)
- You need to verify which tools an SOP requires are connected via Composio
- After creating an SOP, ask the owner if they want routine deep-research on alternative tools for each tool required by the SOP

## Tools

### generate_dynamic_sop

Call this tool with the following parameters:

| Parameter | Type | Description |
|---|---|---|
| `sop_title` | string | The title of the procedure (becomes the filename) |
| `target_department` | string | Owning department (e.g. `GTM-playbook`, `Research-and-Dev`). Becomes the `<SOP_root_dir>` |
| `execution_classification` | "Manual" \| "Hybrid" \| "Fully_Automated" | How the procedure is executed. Affects SOP structure |
| `core_objective` | string | Brief summary of the SOP's goal |
| `required_tools_or_skills` | string[] | List of tools or skills needed (e.g. `["gmail", "notion", "slack"]`). If omitted, defaults to the agent's configured `COMPOSIO_TOOLKITS`. |
| `raw_procedural_steps` | string | Markdown-formatted instructions, steps, or notes forming the body |

**Execution classification affects SOP structure:**

| Classification | Structure emphasis |
|---|---|
| **Manual** | Step-by-step human actions, explicit checkpoints, human approval gates, owner/responsible-party fields per step |
| **Hybrid** | Mix of human and automated steps; each step annotated with who/what executes it (human vs tool/skill); check can be human + script |
| **Fully_Automated** | Tool calls, API calls, script execution steps; minimal human intervention; check is automated (script or model); outputs are machine-readable where possible |

**Tool connection checking:** When `required_tools_or_skills` is specified and Composio is configured, the tool checks which tools are already connected and which need connection. The result includes connection status for each tool.

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

After creating an SOP, ask the owner:

*"Would you like me to routinely research alternative tools for the tools in this SOP? I can check weekly for alternatives, compare them on price, open-source/free availability, and features, and send you a brief summary."*

If the owner says yes, call `sopResearchToolAlternatives` with the SOP's title and department.

## Output

The SOP is written as a markdown file to:

```
<data>/Company-brain/SOPs/<target_department-kebab-case>/<sop_title>.md
```

The file follows a minimal Open Knowledge Format (OKF) schema with YAML frontmatter and a structured body. Frontmatter includes `required_tools_status` tracking each tool's connection state.

## Template config loading

When the agent is provisioned from a gateway template, `COMPOSIO_TOOLKITS` from the template's `env` map is applied as the agent's toolkit list. If `generate_dynamic_sop` is called without `required_tools_or_skills`, the agent's configured toolkits are used as the default required tools.

## Dynamic tool connection via Composio

When Composio is configured (`COMPOSIO_API_KEY` set):

1. `generate_dynamic_sop` automatically checks which required tools are connected
2. `sop_check_required_tools` returns OAuth connect links for tools that are configured but not connected
3. Use `apps_connect` with the toolkit slug to initiate OAuth connection for a missing tool
4. After connecting, re-run `sop_check_required_tools` to verify all tools are connected

## Routine tool-alternative research

When the owner opts in, `sopResearchToolAlternatives` schedules a weekly job that:

1. Reads each tool required by the SOP
2. Searches the web for alternatives ("<tool> alternative", "<tool> vs competitors", "<tool> pricing")
3. Fetches top results and compares on price, open-source/free-tier availability, features, and integration difficulty
4. Writes a research brief to `workspace/research/sop-<title>-tool-alternatives-<date>.md`
5. Notifies the owner with a one-paragraph summary per tool

## Do not

- Do not create SOPs without explicit user request or a detected recurring process
- Do not overwrite an existing SOP without confirmation (the tool fails if the file already exists)
- Do not include secrets, API keys, or credentials in `raw_procedural_steps` or `required_tools_or_skills`
- Do not skip the walk-through validation: every SOP must state its owner, trigger, and exit criteria