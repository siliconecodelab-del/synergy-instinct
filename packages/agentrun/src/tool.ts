/**
 * The `agentrun` tool: lets an Open Instinct agent author, inspect, validate,
 * dry-run, save, load, list, and run AgentRun workflows.
 *
 * Registered in the Open Instinct `ToolRegistry` when `INSTINCT_AGENTRUN=1`.
 * Actions map to `@parcha/agentrun-dsl` operations plus Open Instinct storage.
 */
import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolResultLike, type ToolRegistry, Scheduler } from "@open-instinct/core";
import {
  inspectWorkflow,
  dryRunWorkflow,
  type Workflow,
  type DryRunResult,
} from "@parcha/agentrun-dsl";
import { runWorkflowWithRecovery, type AgentRunAdapters } from "./runner.js";
import { WorkflowStore } from "./store.js";
import type { StateDir } from "@open-instinct/core";
import {
  buildSOPDocument,
  validateSOPFrontmatter,
  type ExecutionClassification,
  type ComposioLike,
  parseSOP,
} from "./sop-okf.js";
import {
  writeSOP,
  resolveSOPPath,
  listSOPs,
  checkToolAvailability,
  updateSOPToolStatus,
  getToolConnectLink,
  kebabCase,
} from "./sop-generator.js";
import { resolveTracerScript, runTracerCommand } from "./workflow-tracer.js";
import { PipelineStore } from "./pipeline-store.js";
import { readPipelinePrefs, writePipelinePrefs } from "./pipeline-prefs.js";
import { listPresets, loadPreset, savePreset, deletePreset, type PipelinePreset } from "./pipeline-presets.js";
import { readNudgeState, writeNudgeState, canNudge } from "./nudge-gate.js";

function okResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

function errResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

/** Build the `agentrun` RegisteredTool. */
export function agentrunTool(deps: {
  store: WorkflowStore;
  adapters: AgentRunAdapters;
  stateDir: StateDir;
  registry: ToolRegistry;
}): RegisteredTool {
  const { store, adapters, registry } = deps;

  return defineTool({
    name: "agentrun",
    label: "AgentRun workflow",
    description:
      "Author, inspect, validate, dry-run, save, load, list, and run AgentRun workflows. " +
      "Workflows are typed, multi-step programs that combine tools, code, judgments, and agents. " +
      "Use this for complex, multi-step tasks that need checkpoints, recovery, or structured decisions.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("describe"),
        Type.Literal("inspect"),
        Type.Literal("dry-run"),
        Type.Literal("save"),
        Type.Literal("load"),
        Type.Literal("list"),
        Type.Literal("run"),
      ], { description: "What to do with the workflow." }),
      name: Type.Optional(Type.String({ description: "Workflow name (for save/load/list/run)." })),
      workflow: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Inline AgentRun workflow JSON (v2 document)." })),
      input: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Workflow input JSON (for dry-run/run)." })),
      runId: Type.Optional(Type.String({ description: "Stable run id for recovery (default: auto-generated)." })),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) => `agentrun ${String((args as { action?: unknown }).action ?? "")}`,
    },
    execute: async (args) => {
      const action = args.action;

      // ------------------------------------------------------------------
      // describe — surface the workflow language and available tools
      // ------------------------------------------------------------------
      if (action === "describe") {
        const tools = registry.all().map((t) => t.spec.name);
        return okResult(
          `AgentRun: typed workflows that combine tools, code, judgments, and agents.\n` +
          `Available tools for call nodes: ${tools.join(", ") || "none"}.\n` +
          `Node kinds: chain, agent, extract, judge, pick, sift, route, code, call, map, parallel, loop, workflow, escalate, report.\n` +
          `Use "inspect" to check a workflow, "dry-run" to test it without a model, "run" to execute it.`,
        );
      }

      // ------------------------------------------------------------------
      // inspect — validate structure without running
      // ------------------------------------------------------------------
      if (action === "inspect") {
        const wf = args.workflow;
        if (!wf || typeof wf !== "object") {
          return errResult("No workflow supplied. Pass `workflow` with the AgentRun JSON document.");
        }
        try {
          inspectWorkflow(wf as Workflow);
          return okResult(`Workflow "${String((wf as { name?: unknown }).name ?? "(unnamed)")}" is structurally valid.`);
        } catch (err) {
          return errResult(`Workflow inspection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ------------------------------------------------------------------
      // dry-run — synthetic execution, no model, no key
      // ------------------------------------------------------------------
      if (action === "dry-run") {
        const wf = args.workflow;
        if (!wf || typeof wf !== "object") {
          return errResult("No workflow supplied. Pass `workflow` with the AgentRun JSON document.");
        }
        const input = (args.input ?? {}) as Record<string, unknown>;
        try {
          const dryResult = await dryRunWorkflow(wf as Workflow, { input });
          if (dryResult.ok) {
            return okResult(`Dry-run ${dryResult.status}: ${dryResult.skipped?.length ? `skipped: ${dryResult.skipped.join(", ")}` : "all checks ran"}`);
          }
          return errResult(`Dry-run failed: ${dryResult.problems.join("; ")}`);
        } catch (err) {
          return errResult(`Dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ------------------------------------------------------------------
      // list — saved workflows
      // ------------------------------------------------------------------
      if (action === "list") {
        const names = store.list();
        if (names.length === 0) return okResult("No saved workflows.");
        return okResult(names.join("\n"));
      }

      // ------------------------------------------------------------------
      // load — read a saved workflow
      // ------------------------------------------------------------------
      if (action === "load") {
        if (!args.name) return errResult("Pass `name` to load a saved workflow.");
        const wf = store.load(args.name);
        if (!wf) return errResult(`No saved workflow named "${args.name}".`);
        return okResult(JSON.stringify(wf, null, 2));
      }

      // ------------------------------------------------------------------
      // save — persist a workflow
      // ------------------------------------------------------------------
      if (action === "save") {
        if (!args.name) return errResult("Pass `name` to save the workflow.");
        if (!args.workflow || typeof args.workflow !== "object") {
          return errResult("Pass `workflow` with the AgentRun JSON document.");
        }
        store.save(args.name, args.workflow);
        return okResult(`Saved workflow "${args.name}".`);
      }

      // ------------------------------------------------------------------
      // run — execute a workflow (saved or inline)
      // ------------------------------------------------------------------
      if (action === "run") {
        let wf: Workflow;
        if (args.workflow && typeof args.workflow === "object") {
          wf = args.workflow as Workflow;
        } else if (args.name) {
          const saved = store.load(args.name);
          if (!saved) return errResult(`No saved workflow named "${args.name}".`);
          wf = saved as Workflow;
        } else {
          return errResult("Pass `workflow` or `name` to run a workflow.");
        }

        const input = (args.input ?? {}) as Record<string, unknown>;
        try {
          const runResult = await runWorkflowWithRecovery(wf, input, adapters, deps.stateDir, { runId: args.runId });
          if (runResult.status === "complete") {
            return okResult(`Workflow complete.\nOutput: ${JSON.stringify(runResult.output)}`);
          }
          return errResult(
            `Workflow escalated: ${runResult.escalation?.reason ?? "unknown reason"}`,
          );
        } catch (err) {
          return errResult(
            `Workflow run failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return errResult(`Unknown agentrun action: ${String(action)}`);
    },
  });
}

/**
 * Build the `generate_dynamic_sop` RegisteredTool: designs, validates, and
 * deploys an OKF-compliant SOP into the company brain repository.
 */
export function sopArchitectTool(deps: {
  stateDir: StateDir;
  composio?: ComposioLike;
  defaultTools?: string[];
}): RegisteredTool {
  const { stateDir, composio, defaultTools = [] } = deps;

  return defineTool({
    name: "generate_dynamic_sop",
    label: "Generate dynamic SOP",
    description:
      "Design, validate, and deploy an OKF-compliant Standard Operating Procedure " +
      "into the company brain repository. Parameters: sop_title, target_department, " +
      "execution_classification (Manual | Hybrid | Fully_Automated), core_objective, " +
      "required_tools_or_skills (string[]), raw_procedural_steps (markdown).",
    parameters: Type.Object({
      sop_title: Type.String({ description: "The title of the procedure." }),
      target_department: Type.String({
        description: "Owning department, e.g. GTM-playbook or Research-and-Dev.",
      }),
      execution_classification: Type.Union([
        Type.Literal("Manual"),
        Type.Literal("Hybrid"),
        Type.Literal("Fully_Automated"),
      ], {
        description:
          "How the procedure is executed. Affects SOP structure: Manual emphasizes human steps and checkpoints; Hybrid mixes human and automated steps; Fully_Automated emphasizes tool calls and automated checks.",
      }),
      core_objective: Type.String({
        description: "Brief summary of the SOP's goal.",
      }),
      required_tools_or_skills: Type.Array(Type.String(), {
        description: "List of tools or skills needed, e.g. [\"Slack\", \"CRM API\"].",
      }),
      raw_procedural_steps: Type.String({
        description: "Markdown-formatted instructions, steps, or notes forming the body of the SOP.",
      }),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) => `generate_dynamic_sop ${String((args as { sop_title?: unknown }).sop_title ?? "")}`,
    },
    execute: async (args) => {
      // Build the OKF document from parameters, falling back to default tools
      const requiredTools = args.required_tools_or_skills?.length > 0
        ? args.required_tools_or_skills
        : defaultTools;

      const doc = buildSOPDocument({
        sop_title: args.sop_title,
        target_department: args.target_department,
        execution_classification: args.execution_classification,
        core_objective: args.core_objective,
        required_tools_or_skills: requiredTools,
        raw_procedural_steps: args.raw_procedural_steps,
      });

      // Validate frontmatter against OKF schema
      const errors = validateSOPFrontmatter(doc.frontmatter);
      if (errors.length > 0) {
        return errResult(
          `SOP validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
        );
      }

      // Write to disk (refuses to overwrite existing)
      try {
        const { path } = writeSOP(stateDir, doc);

        // Check tool availability via Composio and update the SOP with status
        if (composio && doc.frontmatter.required_tools_or_skills.length > 0) {
          try {
            const toolStatus = await checkToolAvailability(doc, composio);
            const updatedDoc = updateSOPToolStatus(doc, toolStatus);
            // Rewrite the file with tool status included
            writeSOP(stateDir, updatedDoc);
            const connected = Object.entries(toolStatus)
              .filter(([, s]) => s === "connected")
                .map(([t]) => t);
            const notConnected = Object.entries(toolStatus)
              .filter(([, s]) => s === "not_connected")
              .map(([t]) => t);
            const notConfigured = Object.entries(toolStatus)
              .filter(([, s]) => s === "not_configured")
                .map(([t]) => t);
            let statusLines = [`SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}).`];
            if (connected.length > 0) statusLines.push(`Tools connected: ${connected.join(", ")}.`);
            if (notConnected.length > 0) statusLines.push(`Tools not connected: ${notConnected.join(", ")}. Use generate_dynamic_sop again or apps_connect to connect them.`);
            if (notConfigured.length > 0) statusLines.push(`Tools not configured: ${notConfigured.join(", ")}. Add them to COMPOSIO_TOOLKITS or use COMPOSIO_TOOLKITS=all.`);
            return okResult(statusLines.join("\n"));
          } catch (checkErr) {
            // Tool check failure shouldn't fail SOP creation
            return okResult(
              `SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}). Tool availability check skipped: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`,
            );
          }
        }

        return okResult(
          `SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}).`,
        );
      } catch (err) {
        return errResult(
          `Failed to write SOP: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
}

/**
 * Build the `sop_check_required_tools` RegisteredTool: checks which tools
 * referenced by an SOP are connected via Composio, and returns connect links
 * for missing ones.
 */
export function sopCheckRequiredToolsTool(deps: {
  stateDir: StateDir;
  composio?: ComposioLike;
}): RegisteredTool {
  const { stateDir, composio } = deps;

  return defineTool({
    name: "sop_check_required_tools",
    label: "Check SOP required tools",
    description:
      "Check which tools referenced by an SOP are connected via Composio. " +
      "Parameters: sop_title, target_department. Returns connection status and " +
      "OAuth connect links for missing tools.",
    parameters: Type.Object({
      sop_title: Type.String({ description: "The title of the SOP to check." }),
      target_department: Type.String({
        description: "Owning department of the SOP.",
      }),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) => `sop_check_required_tools ${String((args as { sop_title?: unknown }).sop_title ?? "")}`,
    },
    execute: async (args) => {
      if (!composio) {
        return errResult(
          "Composio is not configured on this agent. Set COMPOSIO_API_KEY to enable tool connection checking.",
        );
      }

      const path = resolveSOPPath(stateDir, args.target_department, args.sop_title);
      const fs = require("node:fs");
      if (!fs.existsSync(path)) {
        return errResult(`SOP not found at ${path}.`);
      }

      const markdown = fs.readFileSync(path, "utf8");
      const doc = (await import("./sop-okf.js")).parseSOP(markdown);
      if (!doc) {
        return errResult(`Failed to parse SOP at ${path}.`);
      }

      const toolStatus = await checkToolAvailability(doc, composio);

      const connected = Object.entries(toolStatus)
        .filter(([, s]) => s === "connected")
        .map(([t]) => t);
      const notConnected = Object.entries(toolStatus)
        .filter(([, s]) => s === "not_connected")
        .map(([t]) => t);
      const notConfigured = Object.entries(toolStatus)
        .filter(([, s]) => s === "not_configured")
        .map(([t]) => t);

      let lines: string[] = [];
      lines.push(`Tool status for SOP "${args.sop_title}" (${args.target_department}):`);
      if (connected.length > 0) lines.push(`  Connected: ${connected.join(", ")}.`);
      if (notConnected.length > 0) lines.push(`  Not connected: ${notConnected.join(", ")}.`);
      if (notConfigured.length > 0) lines.push(`  Not configured: ${notConfigured.join(", ")}.`);

      // Get connect links for not_connected tools
      const connectLinks: string[] = [];
      for (const tool of notConnected) {
        const link = await getToolConnectLink(tool, composio);
        if (link) connectLinks.push(`  - ${tool}: ${link}`);
      }
      if (connectLinks.length > 0) {
        lines.push("");
        lines.push("Connect links (open in browser to authorize):");
        lines.push(...connectLinks);
      }

      if (connected.length === doc.frontmatter.required_tools_or_skills.length && connected.length > 0) {
        lines.push("");
        lines.push("All required tools are connected. The SOP is ready to execute.");
      }

      return okResult(lines.join("\n"));
    },
  });
}

/**
 * Build the `sopResearchToolAlternatives` RegisteredTool: schedules a weekly
 * deep-research job that checks for alternative tools for each tool required
 * by an SOP, compares them on price, open-source/free availability, and
 * features, and reports back to the owner.
 */
export function sopResearchToolAlternativesTool(deps: {
  stateDir: StateDir;
}): RegisteredTool {
  const { stateDir } = deps;
  const scheduler = new Scheduler(stateDir);

  return defineTool({
    name: "sopResearchToolAlternatives",
    label: "Research SOP tool alternatives",
    description:
      "Schedule a weekly deep-research job that checks for alternative tools " +
      "for each tool required by an SOP, compares them on price, open-source/" +
      "free availability, and features, and reports back to the owner. " +
      "Parameters: sop_title, target_department, schedule_cron (optional, " +
      'default "0 9 * * 1" = Mondays 9am).',
    parameters: Type.Object({
      sop_title: Type.String({ description: "The title of the SOP to research tools for." }),
      target_department: Type.String({
        description: "Owning department of the SOP.",
      }),
      schedule_cron: Type.Optional(
        Type.String({
          description:
            "Cron expression for the research schedule (5 fields: minute hour day month weekday). Default: weekly Mondays 9am.",
        }),
      ),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) =>
        `sopResearchToolAlternatives ${String((args as { sop_title?: unknown }).sop_title ?? "")}`,
    },
    execute: async (args) => {
      const sopPath = resolveSOPPath(stateDir, args.target_department, args.sop_title);
      const fs = require("node:fs");
      if (!fs.existsSync(sopPath)) {
        return errResult(`SOP not found at ${sopPath}.`);
      }

      const markdown = fs.readFileSync(sopPath, "utf8");
      const doc = parseSOP(markdown);
      if (!doc) {
        return errResult(`Failed to parse SOP at ${sopPath}.`);
      }

      const tools = doc.frontmatter.required_tools_or_skills;
      if (!tools || tools.length === 0) {
        return errResult(
          `SOP "${args.sop_title}" has no required tools to research alternatives for.`,
        );
      }

      const scheduleCron = args.schedule_cron || "0 9 * * 1";
      const researchId = `sop-research-${kebabCase(args.sop_title)}-${kebabCase(args.target_department)}`;

      // Save research config
      const researchConfig = {
        sop_title: args.sop_title,
        target_department: args.target_department,
        tools,
        schedule_cron: scheduleCron,
        created_at: new Date().toISOString(),
      };
      const configPath = stateDir.path(
        "agentrun",
        "sop-research",
        `${kebabCase(args.target_department)}-${kebabCase(args.sop_title)}.json`,
      );
      const configDir = stateDir.path("agentrun", "sop-research");
      require("node:fs").mkdirSync(configDir, { recursive: true });
      require("node:fs").writeFileSync(configPath, JSON.stringify(researchConfig, null, 2));

      // Create the schedule
      const schedulePrompt = `
Research alternative tools for the SOP "${args.sop_title}" (${args.target_department}).

The SOP requires these tools: ${tools.join(", ")}.

For each tool, research:
1. Alternative/competing tools (2-3 options)
2. Pricing models and cost comparison
3. Open-source or free-tier availability
4. Key features vs the current tool
5. Integration difficulty

Write a research brief to workspace/research/sop-${kebabCase(args.sop_title)}-tool-alternatives-<date>.md
with a comparison table and recommendation. Then notify the owner with a short summary
(one paragraph per tool: current → recommended alternative, key reason, cost impact).
      `.trim();

      try {
        scheduler.create({
          name: researchId,
          prompt: schedulePrompt,
          enabled: true,
          cron: scheduleCron,
          tz: "UTC",
        });
      } catch (err) {
        return errResult(
          `Failed to create research schedule: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return okResult(
        `Scheduled weekly research for SOP "${args.sop_title}" (${args.target_department}).\n` +
          `Tools being monitored: ${tools.join(", ")}.\n` +
          `Schedule: ${scheduleCron} (UTC).\n` +
          `Research config saved to ${configPath}.\n` +
          `The agent will research alternatives for each tool and report back with comparisons on price, open-source/free availability, and features.`,
      );
    },
  });
}

export function workflowTraceTool(deps: { stateDir: StateDir }): RegisteredTool {
  return defineTool({
    name: "workflow_trace",
    label: "Workflow Trace (ICM)",
    description:
      "Run a subcommand of the workflow-tracer on an ICM workspace and return its output. " +
      "Subcommands: tree, read, scan, miss, done, html. Use `tree` first to scan the folder, " +
      "then `read` for each file the walk opens (with --layer and --why), `scan`/`miss` for " +
      "searches/dead ends, and `done` to compute the four ICM checks and write trace.html.",
    parameters: Type.Object({
      subcommand: Type.Union([
        Type.Literal("tree"),
        Type.Literal("read"),
        Type.Literal("scan"),
        Type.Literal("miss"),
        Type.Literal("done"),
        Type.Literal("html"),
      ]),
      args: Type.Array(Type.String(), { default: [] }),
      dir: Type.Optional(Type.String()),
    }),
    meta: {
      capabilities: ["files.read"],
      group: "files",
      describe: (a) => `workflow_trace ${ (a as { subcommand?: string }).subcommand ?? "" }`,
    },
    execute: async (args): Promise<ToolResultLike> => {
      const a = args as { subcommand: string; args?: string[]; dir?: string };
      const script = resolveTracerScript();
      if (!script) {
        return { content: [{ type: "text", text: "workflow-tracer script not found (skills/workflow-tracer/scripts/tracer.py)." }], isError: true };
      }
      const cmdArgs = [...(a.args ?? [])];
      if (a.dir) cmdArgs.push("-d", a.dir);
      const res = await runTracerCommand(script, [a.subcommand, ...cmdArgs]);
      const text = [res.stdout, res.stderr ? `\nSTDERR:\n${res.stderr}` : ""].join("").trim();
      return { content: [{ type: "text", text: text || "(no output)" }], ...(res.code !== 0 ? { isError: true } : {}) };
    },
  });
}

export function pipelineStatusTool(deps: { stateDir: StateDir }): RegisteredTool {
  const store = new PipelineStore(deps.stateDir);
  return defineTool({
    name: "pipeline_status",
    label: "Pipeline Status",
    description: "List or inspect persisted pipeline runs. Actions: list, get, bySop.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("bySop")]),
      id: Type.Optional(Type.String()),
      sop: Type.Optional(Type.String()),
    }),
    meta: { capabilities: ["files.read"], group: "files", describe: (a) => `pipeline_status ${(a as { action?: string }).action ?? ""}` },
    execute: async (args): Promise<ToolResultLike> => {
      const a = args as { action: string; id?: string; sop?: string };
      if (a.action === "list") {
        const recs = store.list();
        if (recs.length === 0) return okResult("No pipelines.");
        const lines = recs.map((r) => {
          const stages = Object.entries(r.stages).map(([k, v]) => `${k}:${v?.status ?? "?"}`).join(" ");
          return `${r.id} | ${r.sop} | ${stages} | lastRun=${r.lastRun ?? "never"} | schedule=${r.schedule?.cron ?? "none"}`;
        });
        return okResult(lines.join("\n"));
      }
      if (a.action === "get") {
        if (!a.id) return errResult("id is required");
        const r = store.get(a.id);
        if (!r) return errResult(`pipeline not found: ${a.id}`);
        return okResult(JSON.stringify(r, null, 2));
      }
      if (a.action === "bySop") {
        if (!a.sop) return errResult("sop is required");
        const r = store.bySop(a.sop);
        if (!r) return errResult(`no pipeline for sop: ${a.sop}`);
        return okResult(JSON.stringify(r, null, 2));
      }
      return errResult("unknown action");
    },
  });
}

export function pipelinePrefsTool(deps: { stateDir: StateDir }): RegisteredTool {
  return defineTool({
    name: "pipeline_prefs",
    label: "Pipeline Preferences",
    description: "Get or set the owner's pipeline mode (auto or guided). Actions: get, set.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("guided")])),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `pipeline_prefs ${(a as { action?: string }).action ?? ""}` },
    execute: async (args): Promise<ToolResultLike> => {
      const a = args as { action: string; mode?: "auto" | "guided" };
      if (a.action === "get") {
        return okResult(JSON.stringify(readPipelinePrefs(deps.stateDir)));
      }
      if (a.action === "set") {
        if (!a.mode) return errResult("mode is required (auto|guided)");
        const p = writePipelinePrefs(deps.stateDir, { mode: a.mode });
        return okResult(`mode set to ${p.mode}`);
      }
      return errResult("unknown action");
    },
  });
}

export function pipelinePresetTool(deps: { stateDir: StateDir }): RegisteredTool {
  return defineTool({
    name: "pipeline_preset",
    label: "Pipeline Preset",
    description: "List, load, save, or delete pipeline presets. Actions: list, load, save, delete.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("load"), Type.Literal("save"), Type.Literal("delete")]),
      name: Type.Optional(Type.String()),
      preset: Type.Optional(Type.Any()),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `pipeline_preset ${(a as { action?: string }).action ?? ""}` },
    execute: async (args): Promise<ToolResultLike> => {
      const a = args as { action: string; name?: string; preset?: unknown };
      if (a.action === "list") {
        const ps = listPresets(deps.stateDir);
        if (ps.length === 0) return okResult("No presets.");
        return okResult(ps.map((p) => `${p.name} (${p.department}, ${p.classification}, ${p.tools.join(",")})`).join("\n"));
      }
      if (a.action === "load") {
        if (!a.name) return errResult("name is required");
        const p = loadPreset(deps.stateDir, a.name);
        if (!p) return errResult(`preset not found: ${a.name}`);
        return okResult(JSON.stringify(p, null, 2));
      }
      if (a.action === "save") {
        if (!a.preset || typeof a.preset !== "object") return errResult("preset object is required");
        const saved = savePreset(deps.stateDir, a.preset as PipelinePreset);
        return okResult(`saved preset: ${saved.name}`);
      }
      if (a.action === "delete") {
        if (!a.name) return errResult("name is required");
        const ok = deletePreset(deps.stateDir, a.name);
        return ok ? okResult(`deleted: ${a.name}`) : errResult(`not found: ${a.name}`);
      }
      return errResult("unknown action");
    },
  });
}

export function nudgeGateTool(deps: { stateDir: StateDir }): RegisteredTool {
  return defineTool({
    name: "nudge_gate",
    label: "Nudge Gate",
    description: "Check whether a proactive nudge may be sent now (quiet hours + daily dedup). Action: check or record.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("check"), Type.Literal("record")]),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `nudge_gate ${(a as { action?: string }).action ?? ""}` },
    execute: async (args): Promise<ToolResultLike> => {
      const a = args as { action: string };
      if (a.action === "check") {
        const st = readNudgeState(deps.stateDir);
        const res = canNudge(new Date(), st.lastNudgeAt);
        return res.allowed ? okResult("allowed") : errResult(`blocked: ${res.reason}`);
      }
      if (a.action === "record") {
        writeNudgeState(deps.stateDir, { lastNudgeAt: new Date().toISOString() });
        return okResult("recorded");
      }
      return errResult("unknown action");
    },
  });
}
