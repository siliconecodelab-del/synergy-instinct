---
name: pipeline-nudge
description: Set up and run a daily proactive nudge that scans /data/Company-brain for SOPs, disconnected tools, and Hybrid-to-Automated graduation candidates, surfacing a role-aware nudge to the owner while keeping ICM/DSL mechanics abstracted away. Use when the owner asks for "daily nudges", "proactive reminders", "ping me about SOPs", or when a scheduled nudge fires.
---

# Pipeline Nudge (Role-Aware SOP Routines)

## Setting up the nudge (owner request)

When the owner asks to enable nudges:

1. Call `sop_proactive_nudge` with `action: "enable_schedule"` (default cron `0 9 * * *`).
2. Confirm: "Daily nudge set for 09:00. I'll check your SOPs and ping you where your input is needed. Quiet hours 22:00-07:00 respected."

## Running the nudge (scheduled or manual)

1. Call `sop_proactive_nudge` with `action: "scan"`.
2. The tool enforces `nudge_gate` (quiet hours 22:00-07:00 + max 1 nudge/day) and inspects all SOPs in `/data/Company-brain/SOPs` alongside `PipelineStore`:
   - **Disconnected tools:** Flags missing Composio connections and reminds the owner of their Role Map in the SOP.
   - **Graduation candidates (`Hybrid` -> `Fully_Automated`):** If a `Hybrid` SOP checkpoint has 5+ consecutive unedited approvals, offers to graduate the SOP to `Fully_Automated`.
   - **New / unscheduled SOPs:** Surfaces a role-aware prompt based on the SOP's `execution_classification` (`Manual`, `Hybrid`, or `Fully_Automated`) without exposing internal `ICM`/`DSL` terminology.
3. If `sop_proactive_nudge` returns a `Recommended Nudge to Owner`, send that compact message to the owner.

## Handling owner responses

- If the owner replies `"yes"` to a **Graduation Nudge**, call `sop_proactive_nudge` with `action: "graduate"`, `sop_title`, and `target_department`.
- If the owner replies `"run now"` or `"schedule"` to a new SOP nudge, run or schedule the underlying pipeline silently via `pipeline-runner` (`icm_to_dsl` / `pipeline_schedule`) while framing progress around their SOP steps.

## Do not

- Do not nudge more than once per day (`nudge_gate` enforces this).
- Do not nudge during quiet hours (22:00-07:00).
- Do not expose internal engine jargon (`ICM`, `tracer`, `DSL`) in the nudge text; always speak in terms of the SOP and the owner's Role Map ("Where you fit").
- Do not auto-run or auto-graduate without the owner's confirmation.