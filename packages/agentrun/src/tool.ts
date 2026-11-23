/**
 * The `agentrun` tool: lets an Open Instinct agent author, inspect, validate,
 * dry-run, save, load, list, and run AgentRun workflows.
 *
 * Registered in the Open Instinct `ToolRegistry` when `INSTINCT_AGENTRUN=1`.
 * Actions map to `@parcha/agentrun-dsl` operations plus Open Instinct storage.
 */
import { Type } from "typebox";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type RegisteredTool, type ToolResultLike, type ToolRegistry, Scheduler, parseCron, isValidTimeZone } from "@open-instinct/core";
import { Scratchpad } from "./scratchpad.js";
import { sopSlug } from "./sop-visualizer.js";
import { createPlatformOverrideManager } from "@open-instinct/core";
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
  buildSOPRoleMap,
  validateSOPFrontmatter,
  serializeSOP,
  type ExecutionClassification,
  type ComposioLike,
  type SOPDocument,
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
import { PipelineStore, type PipelineRecord } from "./pipeline-store.js";
import { icmToDsl, saveDslWorkflow, type IcmToDslResult } from "./icm-to-dsl.js";
import { readPipelinePrefs, writePipelinePrefs } from "./pipeline-prefs.js";
import { listPresets, loadPreset, savePreset, deletePreset, type PipelinePreset } from "./pipeline-presets.js";
import { readNudgeState, writeNudgeState, canNudge } from "./nudge-gate.js";
import { renderSOPVisualArtifact, summarizeRoleMapArtifact, type SOPVisualFormat } from "./sop-visualizer.js";
import { analyzeSOP, createApprovalRequest, saveVersion, listVersions, loadOutcomes, saveOutcome, type OptimizationProposal, type OptimizationOutcome } from "./sop-optimizer.js";
import { readSOPVisualPrefs, writeSOPVisualPrefs } from "./sop-visual-prefs.js";

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
  scheduler?: Scheduler;
}): RegisteredTool {
  const { stateDir, composio, defaultTools = [], scheduler } = deps;

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
      schedule: Type.Optional(
        Type.Object({
          cron: Type.String({ description: "5-field cron expression, e.g. '0 8 * * *'" }),
          tz: Type.Optional(Type.String({ description: "Time zone, e.g. 'America/New_York'" })),
          prompt: Type.Optional(Type.String({ description: "Prompt to run when the schedule fires" })),
          condition: Type.Optional(Type.String({ description: "Optional condition expression that gates firing" })),
        }, { description: "Optional recurring schedule for this SOP. When present, a cron is auto-registered." }),
      ),
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
        schedule: args.schedule,
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

        // Register/update cron for SOP-declared schedule
        if (scheduler && doc.frontmatter.schedule) {
          const { schedule } = doc.frontmatter;
          const cronName = `sop-${sopSlug(doc.frontmatter.title)}`;
          const existing = scheduler.list().find((e) => e.name === cronName);
          if (existing) {
            scheduler.delete(existing.id);
          }
          scheduler.create({
            name: cronName,
            prompt: schedule.prompt ?? `Run the SOP "${doc.frontmatter.title}".`,
            enabled: true,
            cron: schedule.cron,
            tz: schedule.tz ?? "UTC",
            condition: schedule.condition,
          });
        }
        const roleMap = doc.body.role_map ?? buildSOPRoleMap(doc.frontmatter.execution_classification, doc.body.steps, args.sop_title);

        // Seed or update PipelineStore record so proactive nudges know this SOP's state & classification
        const sopRel = `${kebabCase(args.target_department)}/${kebabCase(args.sop_title)}`;
        const pipeStore = new PipelineStore(stateDir);
        const existingPipe = pipeStore.bySop(sopRel);
        const prefs = readPipelinePrefs(stateDir);
        const nowIso = new Date().toISOString();
        pipeStore.save({
          id: existingPipe?.id ?? `pipe_${kebabCase(args.sop_title).slice(0, 24)}`,
          sop: sopRel,
          classification: doc.frontmatter.execution_classification,
          mode: existingPipe?.mode ?? prefs.mode,
          stages: {
            ...existingPipe?.stages,
            sop: { status: "done", path: `${sopRel}.md`, updatedAt: nowIso },
          },
          consecutiveCheckpointApprovals: existingPipe?.consecutiveCheckpointApprovals ?? 0,
          lastPrompt: existingPipe?.lastPrompt,
          lastRun: existingPipe?.lastRun ?? null,
          schedule: existingPipe?.schedule ?? null,
          createdAt: existingPipe?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });

        const roleMapLines = [
          `Role Map (Where You Fit vs. Where the Agent Fits):`,
          `  - Classification: ${roleMap.classification}`,
          `  - Agent Scope: ${roleMap.agentScope}`,
          `  - Your Scope (Human): ${roleMap.humanScope}`,
          `  - When You Hear From Me: ${roleMap.cadenceAndNudges}`,
          `  - Summary for Owner: ${roleMap.userSummary}`,
        ];

        // Check tool availability via Composio and update the SOP with status
        if (composio && doc.frontmatter.required_tools_or_skills.length > 0) {
          try {
            const toolStatus = await checkToolAvailability(doc, composio);
            const updatedDoc = updateSOPToolStatus(doc, toolStatus);
            // Rewrite the file with tool status included
            writeSOP(stateDir, updatedDoc, { overwrite: true });
            const connected = Object.entries(toolStatus)
              .filter(([, s]) => s === "connected")
              .map(([t]) => t);
            const notConnected = Object.entries(toolStatus)
              .filter(([, s]) => s === "not_connected")
              .map(([t]) => t);
            const notConfigured = Object.entries(toolStatus)
              .filter(([, s]) => s === "not_configured")
              .map(([t]) => t);
            let statusLines = [
              `SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}).`,
              ...roleMapLines,
            ];
            if (connected.length > 0) statusLines.push(`Tools connected: ${connected.join(", ")}.`);
            if (notConnected.length > 0) statusLines.push(`Tools not connected: ${notConnected.join(", ")}. Use generate_dynamic_sop again or apps_connect to connect them.`);
            if (notConfigured.length > 0) statusLines.push(`Tools not configured: ${notConfigured.join(", ")}. Add them to COMPOSIO_TOOLKITS or use COMPOSIO_TOOLKITS=all.`);
            return okResult(statusLines.join("\n"));
          } catch (checkErr) {
            // Tool check failure shouldn't fail SOP creation
            return okResult(
              [
                `SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}). Tool availability check skipped: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`,
                ...roleMapLines,
              ].join("\n"),
            );
          }
        }

        return okResult(
          [
            `SOP "${args.sop_title}" written to ${path} (OKF v1.0.0, ${doc.frontmatter.execution_classification}).`,
            ...roleMapLines,
          ].join("\n"),
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
 * Build the `sop_visualize_role_map` RegisteredTool: compiles an existing SOP
 * into its visual Role Map ("where you fit vs. where the agent fits") and
 * renders the deliverable artifacts (interactive web link, animated GIF/MP4,
 * one-page PDF playbook). Returns workspace paths plus the exact next tool
 * calls so the agent can send or deploy them in the same turn.
 */
export function sopVisualizeRoleMapTool(deps: {
  stateDir: StateDir;
}): RegisteredTool {
  const { stateDir } = deps;

  return defineTool({
    name: "sop_visualize_role_map",
    label: "Visualize SOP role map",
    description:
      "Render the visual Role Map for an existing SOP: where you (human) fit vs. where the " +
      "agent fits, across You / Agent / Tools swimlanes. Produces an interactive web link " +
      "(ample_deploy), an animated GIF/MP4 (send_file, iMessage-inline), and/or a one-page " +
      "PDF playbook (send_file), and returns the exact next tool calls to deliver them. " +
      "Run this right after generate_dynamic_sop or after graduating a SOP (Manual → Hybrid → " +
      "Fully_Automated). Parameters: sop_title, target_department, format, set_as_default.",
    parameters: Type.Object({
      sop_title: Type.String({ description: "The title of an existing SOP." }),
      target_department: Type.String({ description: "Owning department of the SOP." }),
      format: Type.Optional(
        Type.Union([
          Type.Literal("gif"),
          Type.Literal("mp4"),
          Type.Literal("pdf"),
          Type.Literal("web"),
          Type.Literal("all"),
          Type.Literal("off"),
        ], {
          description:
            "What to render. Omit to use the owner's stored default (gif unless changed). " +
            "'all' renders web + gif + mp4 + pdf; 'off' only applies with set_as_default.",
        }),
      ),
      set_as_default: Type.Optional(
        Type.Boolean({
          description: "Also save `format` as the owner's default for future Role Maps (requires `format`).",
        }),
      ),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) => `sop_visualize_role_map ${String((args as { sop_title?: unknown }).sop_title ?? "")}`,
    },
    execute: async (args) => {
      const prefs = readSOPVisualPrefs(stateDir);

      if (args.set_as_default) {
        if (!args.format) {
          return errResult("Pass `format` together with `set_as_default: true` to save an owner default.");
        }
        writeSOPVisualPrefs(stateDir, { format: args.format });
      }

      const format: SOPVisualFormat | "off" = args.format ?? prefs.format;
      if (format === "off") {
        const prefix = args.set_as_default ? "Saved: " : "";
        return okResult(
          `${prefix}Automatic visual Role Maps are off for this owner. Nothing was rendered; ` +
            "pass an explicit `format` (gif | mp4 | pdf | web | all) to render one anyway.",
        );
      }

      const path = resolveSOPPath(stateDir, args.target_department, args.sop_title);
      if (!existsSync(path)) {
        return errResult(`SOP not found at ${path}.`);
      }
      const doc = parseSOP(readFileSync(path, "utf8"));
      if (!doc) {
        return errResult(`Failed to parse SOP at ${path}.`);
      }

      try {
        const artifact = await renderSOPVisualArtifact(doc, stateDir, { format });
        return okResult(summarizeRoleMapArtifact(doc, artifact));
      } catch (err) {
        return errResult(`Role Map render failed: ${err instanceof Error ? err.message : String(err)}`);
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
      if (!existsSync(path)) {
        return errResult(`SOP not found at ${path}.`);
      }

      const markdown = readFileSync(path, "utf8");
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
 * Composio Deep Research MCP toolkits used by the Unstructured Research Spectrum:
 * - `composio_search`: Free, No-Auth (`isNoAuth: true`) unified search toolkit providing
 *   `COMPOSIO_SEARCH_EXA_ANSWER` (Exa semantic answer engine),
 *   `COMPOSIO_SEARCH_TAVILY` (Tavily LLM deep research), and
 *   `COMPOSIO_SEARCH_WEB` (multi-engine web + URL markdown extraction).
 * - `exa`, `tavily`, `firecrawl`: Optional BYOK free-tier deep research & pricing scrapers.
 */
export const DEEP_RESEARCH_TOOLKITS = ["composio_search", "exa", "tavily", "firecrawl"] as const;

export interface SOPToolResearchOptions {
  includeOpenSource?: boolean;
  includeProprietary?: boolean;
  requireApiOrMcp?: boolean;
}

export interface SOPToolResearchPlan {
  prompt: string;
  targets: string[];
  humanStepTargets: string[];
  mode: "tools" | "steps";
}

/**
 * Build the 3-tier Deep Research prompt for an SOP, supporting both explicit
 * `required_tools_or_skills` and step-level capability discovery (so Manual SOPs
 * with 0 initial tools can discover MCP/API tools that offload human steps into Agent Scope).
 */
export function buildSOPToolResearchPrompt(
  doc: SOPDocument,
  options: SOPToolResearchOptions = {},
): SOPToolResearchPlan {
  const includeOpenSource = options.includeOpenSource ?? true;
  const includeProprietary = options.includeProprietary ?? true;
  const requireApiOrMcp = options.requireApiOrMcp ?? true;

  const tools = (doc.frontmatter.required_tools_or_skills ?? []).filter(Boolean);
  const steps = doc.body.steps ?? [];
  const humanSteps = steps.filter(
    (s) =>
      s.checkpoint ||
      !s.owner ||
      s.owner.toLowerCase().includes("human") ||
      doc.frontmatter.execution_classification === "Manual",
  );
  const humanStepTargets = humanSteps.map((s) => `Step ${s.step}: ${s.description}`);

  const mode: "tools" | "steps" = tools.length > 0 ? "tools" : "steps";
  const targets =
    tools.length > 0
      ? tools
      : steps.length > 0
        ? steps.map((s) => `Step ${s.step}: ${s.description}`)
        : [doc.frontmatter.core_objective || doc.frontmatter.title];

  const roleMap =
    doc.body.role_map ??
    buildSOPRoleMap(doc.frontmatter.execution_classification, steps, doc.frontmatter.title);

  const targetSection =
    mode === "tools"
      ? `The SOP currently requires these tools/skills: ${tools.join(", ")}.\n` +
      (humanStepTargets.length > 0
        ? `Additionally, inspect these Human-owned steps to see if any MCP/API tool can offload mechanical prep to Agent Scope:\n  - ${humanStepTargets.join("\n  - ")}`
        : "")
      : `This ${doc.frontmatter.execution_classification} SOP currently lists no explicit tools (0 initial tools). ` +
      `Perform step-level capability discovery for the SOP objective ("${doc.frontmatter.core_objective}") and its procedural steps:\n  - ${targets.join("\n  - ")}\n` +
      `Identify MCP/API-compatible tools that can automate or assist these steps and shift mechanical work from Your Scope (Human) to Agent Scope.`;

  const tierMandates: string[] = [
    `1. **Tier 1 — Native Composio Catalog (\`COMPOSIO_SEARCH_TOOLS\`)**:\n` +
    `   - Query \`COMPOSIO_SEARCH_TOOLS\` for direct toolkit slugs matching the capability.\n` +
    `   - Record toolkit slug, auth mode (\`OAuth\`, \`API_KEY\`, or \`NoAuth\`), and key actions.`,
  ];

  if (includeOpenSource) {
    tierMandates.push(
      `2. **Tier 2 — Open-Source Tools (Self-Hostable / BYOK)**:\n` +
      `   - Use Deep Research (\`COMPOSIO_SEARCH_EXA_ANSWER\`, \`COMPOSIO_SEARCH_TAVILY\`, \`COMPOSIO_SEARCH_WEB\`) to find 1-2 actively maintained open-source tools or MCP servers on GitHub.\n` +
      `   - **Pricing & Licensing**: State the open-source license (MIT, Apache-2.0, Fair-code, etc.), self-hosted cost (\`$0\` / BYOK infra), and managed cloud pricing if offered.\n` +
      `   - **Connectivity**: Verify whether it ships an official/community **MCP Server** (\`npx\` / \`uvx\` / Docker) or a **REST / GraphQL / Webhook API**.`,
    );
  }

  if (includeProprietary) {
    tierMandates.push(
      `${includeOpenSource ? "3" : "2"}. **Tier 3 — Closed / Proprietary SaaS Tools**:\n` +
      `   - Use Deep Research (\`COMPOSIO_SEARCH_EXA_ANSWER\`, \`COMPOSIO_SEARCH_TAVILY\`, \`COMPOSIO_SEARCH_WEB\`) to find 1-2 leading commercial SaaS alternatives and extract their live \`/pricing\` and \`/docs\` details.\n` +
      `   - **Pricing & API-Tier Gating**: State exact Free-tier limits, Starter/Pro monthly pricing (\`$X/mo\` or usage rate), and **explicitly warn if API or MCP access is gated behind a higher/Enterprise plan**.\n` +
      `   - **Connectivity**: Verify whether it offers a remote **MCP Server**, a **Composio toolkit**, or a **REST / GraphQL API**.`,
    );
  }

  const connectivityFilter = requireApiOrMcp
    ? `CRITICAL FILTER: Prioritize and recommend ONLY tools that expose **MCP Server connectivity** (local stdio or remote SSE/HTTP) or a **documented REST/GraphQL API** so the agent can actually invoke them. Flag UI-only tools with no API/MCP as incompatible with agent automation.`
    : `Prefer tools that expose MCP Server connectivity or a documented REST/GraphQL API.`;

  const prompt = [
    `Deep-Research Tool Discovery & Alternatives for SOP "${doc.frontmatter.title}" (${doc.frontmatter.department}) [Classification: ${doc.frontmatter.execution_classification}].`,
    ``,
    targetSection,
    ``,
    `Current Role Map ("Where You Fit vs. Where the Agent Fits"):`,
    `- Your Scope (Human): ${roleMap.humanScope}`,
    `- Agent Scope: ${roleMap.agentScope}`,
    `- Cadence & Nudges: ${roleMap.cadenceAndNudges}`,
    `- Summary for Owner: ${roleMap.userSummary}`,
    ``,
    `### Deep Research Execution Protocol (Composio Free Deep Research MCP)`,
    `Load the \`deep-research\` skill (\`load_skill\` with \`name: "deep-research"\`) and use the **Composio Deep Research toolkit (\`composio_search\`)** — which requires No Auth on the existing \`COMPOSIO_API_KEY\` — alongside \`COMPOSIO_SEARCH_TOOLS\`:`,
    `- Call \`COMPOSIO_SEARCH_TOOLS\` for native Composio catalog discovery.`,
    `- Call \`COMPOSIO_SEARCH_EXA_ANSWER\` and \`COMPOSIO_SEARCH_TAVILY\` (or \`context_answers\` / \`web_search\`) to research open-source GitHub repositories, MCP registries, and live SaaS pricing/API docs.`,
    ``,
    `### Mandatory 3-Part Search & Comparison Mandate`,
    `For each target capability or tool, evaluate candidates across:`,
    ...tierMandates,
    ``,
    connectivityFilter,
    ``,
    `### Required Output & Role Map Impact`,
    `Write a structured research brief to \`workspace/research/sop-${kebabCase(doc.frontmatter.title)}-tool-alternatives-<date>.md\` containing:`,
    `1. **3-Tier Comparison Table** with columns: \`Target Tool / Step\` | \`Candidate\` | \`Category (Composio / Open-Source / Closed SaaS)\` | \`Connectivity (MCP / API / Composio Slug)\` | \`Pricing (Free Tier / Paid / Self-Hosted)\` | \`API Tier Gating\` | \`Role Map Impact ("Where You Fit")\`.`,
    `2. **Role Map Shift Recommendation**: Explain which steps in "${doc.frontmatter.title}" can move from \`Your Scope (Human)\` to \`Agent Scope\` (e.g. upgrading a \`Manual\` SOP to \`Hybrid\`, or a \`Hybrid\` SOP to \`Fully_Automated\`) if the recommended MCP/API tool is connected.`,
    `3. **Owner Nudge (Gated)**: Check \`nudge_gate\` (\`action: "check"\`). If allowed, send the owner a concise summary (current vs. best Open-Source & Closed/Proprietary option, exact pricing, MCP/API readiness, and how it reduces their manual steps) and call \`nudge_gate\` (\`action: "record"\`).`,
  ].join("\n");

  return { prompt, targets, humanStepTargets, mode };
}

/**
 * Build the `sopResearchToolAlternatives` RegisteredTool: schedules or runs a
 * deep-research job across Native Composio tools, Open-Source tools, and
 * Closed/Proprietary SaaS tools (with pricing, API-tier gating, MCP/API
 * connectivity priority, and SOP Role Map impact). Supports both explicit
 * `required_tools_or_skills` and step-level capability discovery for Manual SOPs.
 */
export function sopResearchToolAlternativesTool(deps: {
  stateDir: StateDir;
}): RegisteredTool {
  const { stateDir } = deps;
  const scheduler = new Scheduler(stateDir);

  return defineTool({
    name: "sopResearchToolAlternatives",
    label: "Research SOP tool alternatives (Composio + Open-Source + Closed SaaS)",
    description:
    "Schedule, run immediately, list, or unschedule deep-research jobs that discover and compare " +
      "tools for an SOP across (1) Native Composio catalog, (2) Open-Source (self-hostable / BYOK), and " +
      "(3) Closed/Proprietary SaaS — including pricing, API/MCP tier gating, MCP/API connectivity, and " +
      "how each tool shifts steps in the SOP's Role Map ('Where You Fit vs. Where the Agent Fits'). " +
      "Works both for SOPs with `required_tools_or_skills` and Manual SOPs with 0 initial tools (via step-level discovery).",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("schedule"),
            Type.Literal("run_now"),
            Type.Literal("list"),
            Type.Literal("unschedule"),
          ],
          {
            description:
              'Action to perform: "schedule" (default, creates weekly cron), "run_now" (returns the 3-tier Deep Research plan for immediate execution), "list" (lists configured SOP research jobs), or "unschedule" (removes the scheduled job).',
          },
        ),
      ),
      sop_title: Type.Optional(
        Type.String({ description: "The title of the SOP to research tools for (required for schedule, run_now, unschedule)." }),
      ),
      target_department: Type.Optional(
        Type.String({
          description: "Owning department of the SOP (required for schedule, run_now, unschedule).",
        }),
      ),
      schedule_cron: Type.Optional(
        Type.String({
          description:
          'Cron expression for the research schedule (5 fields: minute hour day month weekday). Default: "0 9 * * 1" (Mondays 9am UTC).',
        }),
      ),
      include_open_source: Type.Optional(
        Type.Boolean({
          description: "Include Tier 2 Open-Source (self-hostable / BYOK) tool discovery (default: true).",
        }),
      ),
      include_proprietary: Type.Optional(
        Type.Boolean({
          description: "Include Tier 3 Closed / Proprietary SaaS tool discovery with pricing & API-tier gating (default: true).",
        }),
      ),
      require_api_or_mcp: Type.Optional(
        Type.Boolean({
          description: "Prioritize tools with MCP server or REST/GraphQL API connectivity (default: true).",
        }),
      ),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (args) => {
        const a = args as { action?: string; sop_title?: string };
        return `sopResearchToolAlternatives ${a.action ?? "schedule"} ${a.sop_title ?? ""}`.trim();
      },
    },
    execute: async (args) => {
      const action = args.action ?? "schedule";
      const configDir = stateDir.path("agentrun", "sop-research");

      // ------------------------------------------------------------------
      // list — show all configured SOP tool-research jobs
      // ------------------------------------------------------------------
      if (action === "list") {
        if (!existsSync(configDir)) {
          return okResult("No SOP tool-research schedules configured.");
        }
        const files = readdirSync(configDir).filter((f: string) => f.endsWith(".json"));
        if (files.length === 0) {
          return okResult("No SOP tool-research schedules configured.");
        }
        const lines: string[] = [];
        for (const file of files) {
          try {
            const cfg = JSON.parse(readFileSync(join(configDir, file), "utf8"));
            const targetsList = Array.isArray(cfg.targets)
              ? cfg.targets.join(", ")
              : Array.isArray(cfg.tools)
                ? cfg.tools.join(", ")
                : "none";
            lines.push(
              `${cfg.target_department}/${cfg.sop_title} | mode=${cfg.mode ?? "tools"} | cron="${cfg.schedule_cron ?? "none"}" | scheduled=${cfg.scheduled !== false} | targets=[${targetsList}]`,
            );
          } catch {
            // ignore malformed config file
          }
        }
        return okResult(lines.length > 0 ? lines.join("\n") : "No SOP tool-research schedules configured.");
      }

      if (!args.sop_title || !args.target_department) {
        return errResult(`Both "sop_title" and "target_department" are required for action "${action}".`);
      }

      const configPath = stateDir.path(
        "agentrun",
        "sop-research",
        `${kebabCase(args.target_department)}-${kebabCase(args.sop_title)}.json`,
      );
      const researchId = `sop-research-${kebabCase(args.sop_title)}-${kebabCase(args.target_department)}`;

      // ------------------------------------------------------------------
      // unschedule — remove the Scheduler job and mark config unscheduled
      // ------------------------------------------------------------------
      if (action === "unschedule") {
        let removedJobId: string | undefined;
        if (existsSync(configPath)) {
          try {
            const existing = JSON.parse(readFileSync(configPath, "utf8"));
            if (existing.jobId) {
              scheduler.delete(existing.jobId);
              removedJobId = existing.jobId;
            }
            existing.scheduled = false;
            delete existing.jobId;
            writeFileSync(configPath, JSON.stringify(existing, null, 2));
          } catch {
            // ignore
          }
        }
        for (const job of scheduler.list()) {
          if (job.name === researchId) {
            scheduler.delete(job.id);
            removedJobId = job.id;
          }
        }
        return okResult(
          `Unscheduled tool-alternative research for SOP "${args.sop_title}" (${args.target_department})${removedJobId ? ` [jobId: ${removedJobId}]` : ""}.`,
        );
      }

      // ------------------------------------------------------------------
      // schedule | run_now — parse SOP and build 3-tier Deep Research plan
      // ------------------------------------------------------------------
      const sopPath = resolveSOPPath(stateDir, args.target_department, args.sop_title);
      if (!existsSync(sopPath)) {
        return errResult(`SOP not found at ${sopPath}.`);
      }

      const markdown = readFileSync(sopPath, "utf8");
      const doc = parseSOP(markdown);
      if (!doc) {
        return errResult(`Failed to parse SOP at ${sopPath}.`);
      }

      const plan = buildSOPToolResearchPrompt(doc, {
        includeOpenSource: args.include_open_source,
        includeProprietary: args.include_proprietary,
        requireApiOrMcp: args.require_api_or_mcp,
      });

      const scheduleCron = args.schedule_cron || "0 9 * * 1";
      mkdirSync(configDir, { recursive: true });

      if (action === "run_now") {
        const researchConfig = {
          sop_title: args.sop_title,
          target_department: args.target_department,
          classification: doc.frontmatter.execution_classification,
          mode: plan.mode,
          tools: doc.frontmatter.required_tools_or_skills ?? [],
          targets: plan.targets,
          human_step_targets: plan.humanStepTargets,
          deep_research_toolkits: [...DEEP_RESEARCH_TOOLKITS],
          include_open_source: args.include_open_source ?? true,
          include_proprietary: args.include_proprietary ?? true,
          require_api_or_mcp: args.require_api_or_mcp ?? true,
          schedule_cron: scheduleCron,
          scheduled: false,
          last_triggered_at: new Date().toISOString(),
        };
        writeFileSync(configPath, JSON.stringify(researchConfig, null, 2));

        return okResult(
          `Ready to execute immediate 3 - Tier Deep Research for SOP "${args.sop_title}"(${ args.target_department })[Discovery Mode: ${ plan.mode === "tools" ? "Required Tools + Human Checkpoints" : "Step-Level Capability Discovery (0 initial tools)" }].\n` +
            `Deep Research MCP Toolkits: ${ DEEP_RESEARCH_TOOLKITS.join(", ") }(use COMPOSIO_SEARCH_TOOLS, COMPOSIO_SEARCH_EXA_ANSWER, COMPOSIO_SEARCH_TAVILY, COMPOSIO_SEARCH_WEB).\n` +
            `Config saved to ${ configPath }.\n\n` +
            `-- - DEEP RESEARCH EXECUTION BRIEF-- -\n` +
            plan.prompt,
        );
      }

      // action === "schedule"
      // Remove any prior duplicate job with the same name before creating a fresh one
      for (const existingJob of scheduler.list()) {
        if (existingJob.name === researchId) {
          scheduler.delete(existingJob.id);
        }
      }

  let jobId: string;
  try {
      const job = scheduler.create({
        name: researchId,
        prompt: plan.prompt,
        enabled: true,
        cron: scheduleCron,
        tz: "UTC",
      });
      jobId = job.id;
    } catch (err) {
      return errResult(
        `Failed to create research schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const researchConfig = {
      sop_title: args.sop_title,
      target_department: args.target_department,
      classification: doc.frontmatter.execution_classification,
      mode: plan.mode,
      tools: doc.frontmatter.required_tools_or_skills ?? [],
      targets: plan.targets,
      human_step_targets: plan.humanStepTargets,
      deep_research_toolkits: [...DEEP_RESEARCH_TOOLKITS],
      include_open_source: args.include_open_source ?? true,
      include_proprietary: args.include_proprietary ?? true,
      require_api_or_mcp: args.require_api_or_mcp ?? true,
      schedule_cron: scheduleCron,
      scheduled: true,
      jobId,
      created_at: new Date().toISOString(),
    };
    writeFileSync(configPath, JSON.stringify(researchConfig, null, 2));

    const discoverySummary =
      plan.mode === "tools"
        ? `Tools being monitored: ${plan.targets.join(", ")}.`
        : `Step-level capability targets (Manual/0-tool SOP): ${plan.targets.join(" | ")}.`;

    return okResult(
      `Scheduled weekly 3-Tier Deep Research for SOP "${args.sop_title}" (${args.target_department}) [jobId: ${jobId}].\n` +
      `${discoverySummary}\n` +
      `Deep Research MCP stack: ${DEEP_RESEARCH_TOOLKITS.join(", ")} (Native Composio Catalog + Open-Source BYOK + Closed/Proprietary SaaS with pricing, API-tier gating & MCP/API connectivity).\n` +
      `Schedule: ${scheduleCron} (UTC).\n` +
      `Research config saved to ${configPath}.\n` +
      `The agent will compare candidates across price, open-source/free availability, MCP/API readiness, and Role Map impact ("Where You Fit vs. Where the Agent Fits").`,
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
      describe: (a) => `workflow_trace ${(a as { subcommand?: string }).subcommand ?? ""}`,
    },
    execute: async (args: any): Promise<ToolResultLike> => {
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
    description: "List, inspect, cancel, or retain persisted pipeline runs. Actions: list, get, bySop, cancel, retention.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("bySop"),
        Type.Literal("cancel"),
        Type.Literal("retention"),
      ]),
      id: Type.Optional(Type.String()),
      sop: Type.Optional(Type.String()),
      maxAgeDays: Type.Optional(Type.Number({ description: "For retention: max age in days to keep pipelines." })),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `pipeline_status ${(a as { action?: string }).action ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as { action: string; id?: string; sop?: string; maxAgeDays?: number };
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
      if (a.action === "cancel") {
        if (!a.id) return errResult("id is required");
        const existing = store.get(a.id);
        if (!existing) return errResult(`pipeline not found: ${a.id}`);
        // Mark all incomplete stages as cancelled
        const next: PipelineRecord = { ...existing, id: existing.id };
        for (const [stageKey] of Object.entries(next.stages)) {
          const st = next.stages[stageKey as keyof typeof next.stages];
          if (st && st.status !== "done" && st.status !== "passed" && st.status !== "failed" && st.status !== "created" && st.status !== "skipped") {
            st.status = "skipped";
            st.reason = "cancelled by owner";
          }
        }
        next.lastPrompt = "cancelled";
        next.updatedAt = new Date().toISOString();
        store.save(next);
        return okResult(`Pipeline "${a.id}" cancelled. Incomplete stages skipped.`);
      }
      if (a.action === "retention") {
        const maxAge = a.maxAgeDays ?? 30;
        const result = store.retention(maxAge);
        return okResult(`Retention complete: removed ${result.removedPipelines} pipeline(s) older than ${maxAge} day(s).`);
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
    execute: async (args: any): Promise<ToolResultLike> => {
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
    execute: async (args: any): Promise<ToolResultLike> => {
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
    execute: async (args: any): Promise<ToolResultLike> => {
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

/**
 * Convert an ICM workspace into an AgentRun DSL workflow with preflight wired.
 * The resulting workflow carries `preflight.icmRoot` so `runWorkflowWithRecovery`
 * runs the tracer as a mandatory pre-flight before any step executes.
 */
export function icmToDslTool(deps: { stateDir: StateDir }): RegisteredTool {
  return defineTool({
    name: "icm_to_dsl",
    label: "ICM to AgentRun DSL",
    description:
      "Convert an ICM (folder-as-architecture) workspace into a typed AgentRun DSL " +
      "workflow. Parameters: icmRoot (path to ICM workspace), name (optional), " +
      "task (optional trace task), classification (optional: Manual | Hybrid | Fully_Automated). " +
      "The generated workflow declares preflight.icmRoot so the tracer runs as a mandatory " +
      "pre-flight check before any step executes.",
    parameters: Type.Object({
      icmRoot: Type.String({ description: "Path to the ICM workspace root (contains entry file + stages/)." }),
      name: Type.Optional(Type.String({ description: "Workflow name (default derived from icmRoot)." })),
      task: Type.Optional(Type.String({ description: "Trace task for preflight (default: icmRoot path)." })),
      classification: Type.Optional(
        Type.Union([
          Type.Literal("Manual"),
          Type.Literal("Hybrid"),
          Type.Literal("Fully_Automated"),
        ], { description: "Originating SOP classification; inserts human checkpoint escalations for Hybrid/Manual." }),
      ),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `icm_to_dsl ${(a as { icmRoot?: string }).icmRoot ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as { icmRoot: string; name?: string; task?: string; classification?: ExecutionClassification };
      if (!a.icmRoot) return errResult("icmRoot is required.");
      try {
        const result = icmToDsl(a.icmRoot, {
          name: a.name,
          task: a.task,
          classification: a.classification,
        });
        const saved = saveDslWorkflow(deps.stateDir, result);
        const summary = [
          `ICM "${a.icmRoot}" converted to AgentRun DSL workflow "${saved.workflow.name}".`,
          `Entry file: ${result.entryFile || "(none found)"}`,
          `Stages: ${result.stages.length > 0 ? result.stages.join(", ") : "(none; entry file used as single agent node)"}`,
          `Preflight: icmRoot=${result.icmRoot} (tracer runs before any step).`,
          `Workflow saved to: ${saved.path}`,
        ];
        return okResult(summary.join("\n"));
      } catch (err) {
        return errResult(`ICM→DSL conversion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

/**
 * Schedule a pipeline run, gated by the nudge gate (quiet hours + daily dedup).
 * Registers a real Scheduler job tailored to the SOP's execution_classification
 * so the user's role map ("Where You Fit") drives the scheduled interaction.
 */
export function pipelineScheduleTool(deps: { stateDir: StateDir }): RegisteredTool {
  const store = new PipelineStore(deps.stateDir);
  const scheduler = new Scheduler(deps.stateDir);
  return defineTool({
    name: "pipeline_schedule",
    label: "Pipeline Schedule",
    description: "Schedule a pipeline run on a cron. Gated by quiet hours + daily dedup via nudge_gate. Actions: schedule, unschedule, check.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("schedule"), Type.Literal("unschedule"), Type.Literal("check")]),
      id: Type.Optional(Type.String()),
      cron: Type.Optional(Type.String({ description: "Cron expression (5 fields). Default: 0 9 * * *." })),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `pipeline_schedule ${(a as { action?: string }).action ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as { action: string; id?: string; cron?: string };
      if (a.action === "check") {
        const st = readNudgeState(deps.stateDir);
        const res = canNudge(new Date(), st.lastNudgeAt);
        return res.allowed ? okResult("allowed") : errResult(`blocked: ${res.reason}`);
      }
      if (a.action === "schedule") {
        if (!a.id) return errResult("id is required.");
        const existing = store.get(a.id);
        if (!existing) return errResult(`pipeline not found: ${a.id}`);
        // Gate: quiet hours + daily dedup
        const st = readNudgeState(deps.stateDir);
        const gate = canNudge(new Date(), st.lastNudgeAt);
        if (!gate.allowed) {
          return errResult(`Cannot schedule now: ${gate.reason}. Try again outside quiet hours or tomorrow.`);
        }
        const cron = a.cron || "0 9 * * *";
        const classification = existing.classification ?? "Hybrid";
        const dslName = existing.stages.dsl?.name ?? existing.sop;

        const schedulePrompt =
          classification === "Manual"
            ? `Run the Manual SOP routine for "${existing.sop}": cue up context and text the owner Step 1 as their pacer/scribe. Wait for their "done" before advancing.`
            : classification === "Fully_Automated"
              ? `Run the Fully Automated SOP "${existing.sop}" (workflow "${dslName}") end-to-end. Only text the owner a compact completion summary or if an exception/escalation occurs.`
              : `Run the Hybrid SOP routine for "${existing.sop}" (workflow "${dslName}"): execute the autonomous agent prep steps up to the human checkpoint, then text the owner the ready draft/summary for their review and approval.`;

        let jobId = `pipe-${a.id}-${crypto.randomUUID().slice(0, 8)}`;
        try {
          const createdJob = scheduler.create({
            name: `sop-routine-${a.id}`,
            prompt: schedulePrompt,
            enabled: true,
            cron,
            tz: "UTC",
          });
          jobId = createdJob.id;
        } catch {
          // Fallback to generated jobId if scheduler creation fails
        }

        const next: PipelineRecord = { ...existing, id: existing.id };
        next.schedule = { cron, jobId };
        next.updatedAt = new Date().toISOString();
        store.save(next);
        writeNudgeState(deps.stateDir, { lastNudgeAt: new Date().toISOString() });
        return okResult(`Pipeline "${a.id}" (${classification}) scheduled: ${cron} (job ${jobId}). Nudge recorded.`);
      }
      if (a.action === "unschedule") {
        if (!a.id) return errResult("id is required.");
        const existing = store.get(a.id);
        if (!existing) return errResult(`pipeline not found: ${a.id}`);
        if (existing.schedule?.jobId) {
          scheduler.delete(existing.schedule.jobId);
        }
        const next: PipelineRecord = { ...existing, id: existing.id };
        next.schedule = null;
        next.updatedAt = new Date().toISOString();
        store.save(next);
        return okResult(`Pipeline "${a.id}" unscheduled.`);
      }
      return errResult("unknown action");
    },
  });
}

/**
 * Register a recurring loop cron for agent-run tasks. Loops fire on a cron,
 * are gated by an optional condition expression, and support maxRuns lifecycle.
 * Use this for any recurring task the agent should self-wake on: checking
 * for new LinkedIn replies, monitoring pipeline health, scanning for expired
 * approvals, etc.
 */
export function registerLoopTool(deps: { stateDir: StateDir }): RegisteredTool {
  const scheduler = new Scheduler(deps.stateDir);

  return defineTool({
    name: "register_loop",
    label: "Register Loop",
    description:
      "Register a recurring cron loop. Parameters: name (unique), cron (5 fields), tz, prompt, condition (optional gating expression), maxRuns (optional max executions), enabled (start on/off).",
    parameters: Type.Object({
      name: Type.String({ description: "Unique loop name (e.g. 'linkedin-reply-check')" }),
      cron: Type.String({ description: "5-field cron expression, e.g. '0 */2 * * *'" }),
      tz: Type.Optional(Type.String({ description: "Time zone, e.g. 'America/New_York'" })),
      prompt: Type.String({ description: "Prompt delivered to the owner when the loop fires" }),
      condition: Type.Optional(Type.String({ description: "Optional condition expression (e.g. 'pending_approvals_older_than(4h) > 0')" })),
      maxRuns: Type.Optional(Type.Number({ description: "Maximum number of runs before auto-disabling" })),
      enabled: Type.Optional(Type.Boolean({ description: "Start enabled (default true)" })),
    }),
    meta: { capabilities: ["converse"], group: "system", describe: (a) => `register_loop ${(a as { name?: string }).name ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as {
        name: string;
        cron: string;
        tz?: string;
        prompt: string;
        condition?: string;
        maxRuns?: number;
        enabled?: boolean;
      };
      if (!a.name || !a.name.trim()) return errResult("name is required.");
      if (!a.cron || !a.cron.trim()) return errResult("cron is required.");
      try {
        // Validate cron expression
        parseCron(a.cron);
      } catch {
        return errResult(`Invalid cron expression: ${a.cron}`);
      }
      if (a.tz && !isValidTimeZone(a.tz)) {
        return errResult(`Unknown time zone: ${a.tz}`);
      }
      if (scheduler.list().some((e) => e.name === a.name)) {
        return errResult(`Loop "${a.name}" already exists. Use a different name or delete the existing one first.`);
      }
      const entry = scheduler.create({
        name: a.name,
        prompt: a.prompt,
        enabled: a.enabled ?? true,
        cron: a.cron,
        tz: a.tz ?? "UTC",
        condition: a.condition,
        maxRuns: a.maxRuns,
      });
      return okResult(
        `Loop "${a.name}" registered: ${a.cron} ${a.tz ?? "UTC"}${
          a.condition ? ` (condition: ${a.condition})` : ""
        }${a.maxRuns !== undefined ? ` (maxRuns: ${a.maxRuns})` : ""}. Job ${entry.id}.`,
      );
    },
  });
}

/**
 * Proactive SOP & Pipeline Nudge Routine tool (`sop_proactive_nudge`).
 *
 * Scans the company brain SOPs and PipelineStore to surface role-aware nudges:
 * - "scan": inspects all SOPs for uncompiled pipelines, disconnected Composio tools,
 *   or Hybrid SOPs ready for graduation to Fully_Automated (5+ consecutive approvals).
 * - "record_checkpoint_approval": records a human checkpoint approval (with or without edits)
 *   on a Hybrid SOP, triggering a graduation nudge at 5 consecutive unedited approvals.
 * - "graduate": upgrades a Hybrid SOP to Fully_Automated when the owner confirms.
 */
export function sopProactiveNudgeTool(deps: {
  stateDir: StateDir;
  composio?: ComposioLike;
}): RegisteredTool {
  const { stateDir, composio } = deps;
  const store = new PipelineStore(stateDir);
  const scheduler = new Scheduler(stateDir);

  return defineTool({
    name: "sop_proactive_nudge",
    label: "SOP Proactive Nudge & Routine",
    description:
      "Run or schedule proactive, role-aware nudges for SOPs. Actions: " +
      "scan (detect uncompiled SOPs, disconnected tools, or Hybrid->Automated graduation candidates and return a role-aware nudge), " +
      "enable_schedule (set up daily 09:00 proactive SOP nudge cron), " +
      "record_checkpoint_approval (track consecutive unedited approvals on a Hybrid SOP checkpoint), " +
      "graduate (upgrade a Hybrid SOP to Fully_Automated after repeated approvals).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("scan"),
        Type.Literal("enable_schedule"),
        Type.Literal("record_checkpoint_approval"),
        Type.Literal("graduate"),
      ]),
      sop_title: Type.Optional(Type.String({ description: "SOP title (for record_checkpoint_approval / graduate)." })),
      target_department: Type.Optional(Type.String({ description: "Department (for record_checkpoint_approval / graduate)." })),
      edited: Type.Optional(Type.Boolean({ description: "Whether the human edited the draft at the checkpoint (default: false)." })),
      cron: Type.Optional(Type.String({ description: "Cron for enable_schedule (default: 0 9 * * *)." })),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (a) => `sop_proactive_nudge ${(a as { action?: string }).action ?? ""}`,
    },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as {
        action: "scan" | "enable_schedule" | "record_checkpoint_approval" | "graduate";
        sop_title?: string;
        target_department?: string;
        edited?: boolean;
        cron?: string;
      };
      if (a.action === "enable_schedule") {
        const cron = a.cron || "0 9 * * *";
        const entry = scheduler.create({
          name: "sop-proactive-nudge-daily",
          prompt:
            "Run sop_proactive_nudge with action='scan'. If a nudge is allowed and returned, send the compact role-aware nudge message to the owner.",
          enabled: true,
          cron,
          tz: "UTC",
        });
        return okResult(
          `Daily proactive SOP nudge scheduled (${cron}, job ${entry.id}). Quiet hours (22:00-07:00) and 1/day dedup enforced.`,
        );
      }

      if (a.action === "record_checkpoint_approval") {
        if (!a.sop_title || !a.target_department) {
          return errResult("sop_title and target_department are required.");
        }
        const sopRel = `${kebabCase(a.target_department)}/${kebabCase(a.sop_title)}`;
        const existing = store.bySop(sopRel);
        const nowIso = new Date().toISOString();
        const prevCount = existing?.consecutiveCheckpointApprovals ?? 0;
        const nextCount = a.edited ? 0 : prevCount + 1;

        const record: PipelineRecord = existing ?? {
          id: `pipe_${kebabCase(a.sop_title).slice(0, 24)}`,
          sop: sopRel,
          classification: "Hybrid",
          mode: readPipelinePrefs(stateDir).mode,
          stages: { sop: { status: "done", path: `${sopRel}.md`, updatedAt: nowIso } },
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        record.consecutiveCheckpointApprovals = nextCount;
        record.updatedAt = nowIso;
        store.save(record);

        if (nextCount >= 5 && (record.classification ?? "Hybrid") === "Hybrid") {
          return okResult(
            `Checkpoint approval recorded (${nextCount} consecutive without edits).\n` +
            `Graduation Nudge Ready: "You've approved the checkpoint in '${a.sop_title}' ${nextCount} times in a row without edits. Want to take yourself out of the loop and graduate this SOP from Hybrid to Fully Automated? (yes/no)"`,
          );
        }
        return okResult(
          `Checkpoint approval recorded for "${a.sop_title}" (consecutive unedited approvals: ${nextCount}).`,
        );
      }

      if (a.action === "graduate") {
        if (!a.sop_title || !a.target_department) {
          return errResult("sop_title and target_department are required.");
        }
        const sopPath = resolveSOPPath(stateDir, a.target_department, a.sop_title);
        if (!existsSync(sopPath)) {
          return errResult(`SOP not found at ${sopPath}.`);
        }
        const markdown = readFileSync(sopPath, "utf8");
        const doc = parseSOP(markdown);
        if (!doc) {
          return errResult(`Failed to parse SOP at ${sopPath}.`);
        }
        doc.frontmatter.execution_classification = "Fully_Automated";
        doc.body.steps = doc.body.steps.map((s) => ({
          ...s,
          owner: undefined,
          checkpoint: false,
          tools: doc.frontmatter.required_tools_or_skills.slice(0, 2),
        }));
        doc.body.role_map = buildSOPRoleMap("Fully_Automated", doc.body.steps, doc.frontmatter.title);
        doc.body.exit_criteria = "All automated steps complete without error; output artifact verified.";
        doc.body.notes = "Graduated from Hybrid to Fully_Automated after repeated human checkpoint approvals.";
        writeSOP(stateDir, doc, { overwrite: true });

        const sopRel = `${kebabCase(a.target_department)}/${kebabCase(a.sop_title)}`;
        const existing = store.bySop(sopRel);
        if (existing) {
          existing.classification = "Fully_Automated";
          existing.consecutiveCheckpointApprovals = 0;
          existing.updatedAt = new Date().toISOString();
          store.save(existing);
        }

        return okResult(
          `Graduated SOP "${doc.frontmatter.title}" to Fully_Automated.\n` +
          `${doc.body.role_map.userSummary}`,
        );
      }

      if (a.action === "scan") {
        const nudgeState = readNudgeState(stateDir);
        const gate = canNudge(new Date(), nudgeState.lastNudgeAt);

        const sops = listSOPs(stateDir);
        if (sops.length === 0) {
          return okResult("No SOPs found in Company-brain.");
        }

        const findings: string[] = [];
        let recommendedNudge: string | undefined;

        for (const relPath of sops) {
          const fullPath = stateDir.path("Company-brain", "SOPs", relPath);
          const content = readFileSync(fullPath, "utf8");
          const doc = parseSOP(content);
          if (!doc) continue;

          const sopKey = relPath.replace(/\.md$/, "");
          const pipe = store.bySop(sopKey);
          const classification = doc.frontmatter.execution_classification;
          const roleMap = doc.body.role_map ?? buildSOPRoleMap(classification, doc.body.steps, doc.frontmatter.title);

          // 1. Check for disconnected tools
          if (composio && doc.frontmatter.required_tools_or_skills.length > 0) {
            const status = await checkToolAvailability(doc, composio);
            const missing = Object.entries(status)
              .filter(([, st]) => st === "not_connected")
              .map(([t]) => t);
            if (missing.length > 0) {
              findings.push(`SOP "${doc.frontmatter.title}" (${classification}) has disconnected tools: ${missing.join(", ")}.`);
              if (!recommendedNudge) {
                recommendedNudge =
                  `Heads up for "${doc.frontmatter.title}" (${classification}): ${missing.join(", ")} isn't connected yet. ` +
                  `${roleMap.userSummary} Want a connect link so I can handle my part? (yes/skip)`;
              }
            }
          }

          // 2. Check for graduation candidate (5+ consecutive approvals in Hybrid mode)
          if (
            classification === "Hybrid" &&
            pipe &&
            (pipe.consecutiveCheckpointApprovals ?? 0) >= 5
          ) {
            findings.push(
              `SOP "${doc.frontmatter.title}" has ${pipe.consecutiveCheckpointApprovals} consecutive checkpoint approvals — ready to graduate to Fully_Automated.`,
            );
            if (!recommendedNudge) {
              recommendedNudge =
                `You've approved the human checkpoint in "${doc.frontmatter.title}" ${pipe.consecutiveCheckpointApprovals} times in a row without edits. ` +
                `Want to take yourself out of the loop and switch it to Fully Automated? (yes/no)`;
            }
          }

          // 3. Check for uncompiled / unscheduled SOPs
          const isCompiled =
            pipe?.stages?.dsl?.status === "created" ||
            pipe?.stages?.dsl?.status === "done";
          const isScheduled = Boolean(pipe?.schedule?.cron);

          if (!isCompiled && !isScheduled) {
            findings.push(`SOP "${doc.frontmatter.title}" (${classification}) is documented but not yet active/scheduled.`);
            if (!recommendedNudge) {
              if (classification === "Manual") {
                recommendedNudge =
                  `Saved SOP "${doc.frontmatter.title}" (Manual). ${roleMap.userSummary} ` +
                  `Want me to set up a recurring checklist reminder to walk you through Step 1? (yes/no/skip)`;
              } else if (classification === "Hybrid") {
                recommendedNudge =
                  `New Hybrid SOP "${doc.frontmatter.title}" is ready to wire up. ${roleMap.userSummary} ` +
                  `Want me to start prepping the automated steps now or put it on a daily schedule? (run now/schedule/skip)`;
              } else {
                recommendedNudge =
                  `New Fully Automated SOP "${doc.frontmatter.title}" is ready. ${roleMap.userSummary} ` +
                  `Want me to activate it to run now or on a schedule? (run now/schedule/skip)`;
              }
            }
          }
        }

        if (!recommendedNudge) {
          return okResult("All SOPs are active and up to date. No proactive nudge needed.");
        }

        if (!gate.allowed) {
          return okResult(
            `Findings:\n- ${findings.join("\n- ")}\nNudge suppressed by nudge_gate (${gate.reason}).`,
          );
        }

        writeNudgeState(stateDir, { lastNudgeAt: new Date().toISOString() });
        return okResult(
          `Nudge allowed and recorded.\n` +
          `Findings:\n- ${findings.join("\n- ")}\n\n` +
          `Recommended Nudge to Owner:\n${recommendedNudge}`,
        );
      }

      return errResult(`Unknown action: ${String(a.action)}`);
    },
  });
}

export function sopOptimizeTool(deps: {
  stateDir: StateDir;
}): RegisteredTool {
  const { stateDir } = deps;
  const overrideManager = createPlatformOverrideManager(stateDir, {
    pending: () => [],
    get: () => undefined,
    create: () => ({} as any),
    resolve: () => ({} as any),
    markNotified: () => {},
  } as any);

  return defineTool({
    name: "sop_optimize",
    label: "SOP Content Optimizer",
    description:
      "Analyze a user's SOP execution history and suggest improvements to " +
      "step descriptions, checkpoint definitions, tool mappings, and role map. " +
      "Returns a proposal that requires owner approval before applying. " +
      "Actions: analyze (generate optimization proposal), apply (apply approved changes), " +
      "history (show version history), rollback (revert to previous version).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("analyze"),
        Type.Literal("apply"),
        Type.Literal("history"),
        Type.Literal("rollback"),
      ]),
      sop_title: Type.Optional(Type.String({ description: "SOP title." })),
      target_department: Type.Optional(Type.String({ description: "Department." })),
      analysis_window_days: Type.Optional(Type.Number({ description: "Days of telemetry to analyze (default: 30)." })),
      version: Type.Optional(Type.Number({ description: "Version number for rollback." })),
      auto_apply_low_risk: Type.Optional(Type.Boolean({ description: "Auto-apply low-risk changes (default: false)." })),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (a) => `sop_optimize ${(a as { action?: string }).action ?? ""} ${(a as { sop_title?: string }).sop_title ?? ""}`,
    },
    execute: async (args) => {
      const a = args as {
        action: "analyze" | "apply" | "history" | "rollback";
        sop_title?: string;
        target_department?: string;
        analysis_window_days?: number;
        version?: number;
        auto_apply_low_risk?: boolean;
      };

      if (a.action === "history") {
        if (!a.sop_title || !a.target_department) {
          return errResult("sop_title and target_department are required for history.");
        }
        const versions = listVersions(stateDir, a.sop_title, a.target_department);
        const outcomes = loadOutcomes(stateDir, a.sop_title, a.target_department);
        if (versions.length === 0) {
          return okResult(`No version history for "${a.sop_title}".`);
        }
        const lines = [`Version history for "${a.sop_title}" (${a.target_department}):`, ""];
        for (const v of versions) {
          lines.push(`  v${v.version} — ${v.timestamp} — ${v.changes.join(", ") || "initial"}`);
        }
        if (outcomes.length > 0) {
          lines.push("", "Optimization outcomes:");
          for (const o of outcomes) {
            const improvement = o.improvement !== null ? `${o.improvement > 0 ? "+" : ""}${Math.round(o.improvement * 100)}%` : "pending";
            lines.push(`  ${o.proposalId}: ${o.changes.join(", ")} → improvement: ${improvement}`);
          }
        }
        return okResult(lines.join("\n"));
      }

      if (a.action === "rollback") {
        if (!a.sop_title || !a.target_department || !a.version) {
          return errResult("sop_title, target_department, and version are required for rollback.");
        }
        const versions = listVersions(stateDir, a.sop_title, a.target_department);
        const target = versions.find((v) => v.version === a.version);
        if (!target) {
          return errResult(`Version ${a.version} not found. Available: ${versions.map((v) => v.version).join(", ")}`);
        }
        const sopPath = resolveSOPPath(stateDir, a.target_department, a.sop_title);
        if (!existsSync(sopPath)) {
          return errResult(`SOP not found at ${sopPath}.`);
        }
        const currentContent = readFileSync(sopPath, "utf8");
        saveVersion(stateDir, a.sop_title, a.target_department, currentContent, [`rollback to v${a.version}`], null);
        writeFileSync(sopPath, target.content, { mode: 0o600 });
        return okResult(`Rolled back "${a.sop_title}" to version ${a.version}. Previous version saved.`);
      }

      if (!a.sop_title || !a.target_department) {
        return errResult("sop_title and target_department are required for analyze/apply.");
      }

      const sopPath = resolveSOPPath(stateDir, a.target_department, a.sop_title);
      if (!existsSync(sopPath)) {
        return errResult(`SOP not found at ${sopPath}.`);
      }

      const markdown = readFileSync(sopPath, "utf8");
      const doc = parseSOP(markdown);
      if (!doc) {
        return errResult(`Failed to parse SOP at ${sopPath}.`);
      }

      const { readTelemetry } = await import("@open-instinct/core");
      const telemetry = readTelemetry(stateDir);
      const windowDays = a.analysis_window_days ?? 30;
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const recentTelemetry = telemetry.filter((e) => e.timestamp >= cutoff);

      const proposal = analyzeSOP(doc, recentTelemetry, windowDays);

      if (a.action === "analyze") {
        const lines: string[] = [
          `## SOP Optimization Proposal: "${proposal.sopTitle}"`,
          `Department: ${proposal.targetDepartment}`,
          `Analysis window: ${windowDays} days | Executions: ${proposal.totalExecutions}`,
          `Risk level: ${proposal.riskLevel} | Requires approval: ${proposal.requiresApproval}`,
          `Approver: ${proposal.approver}`,
          "",
        ];

        // Report any local overrides that deviate from platform defaults
        const overrides = overrideManager.listOverrides();
        if (overrides.length > 0) {
          lines.push("### Local Overrides (override platform defaults):");
          for (const ov of overrides) {
            lines.push(`  - Target: ${ov.target} | Capability: ${ov.capability}`);
            lines.push(`    Reason: ${ov.reason}`);
            lines.push(`    Overridden value: ${JSON.stringify(ov.overriddenValue)}`);
          }
          lines.push("");
        }

        if (proposal.signals.length > 0) {
          lines.push("### Signals detected:");
          for (const sig of proposal.signals) {
            // Check if there's a local override for this signal
            const localOverride = overrideManager.listOverrides().find(
              (o) => o.target === sig.target && o.capability === sig.capability
            );
            const overrideNote = localOverride
              ? ` [LOCAL OVERRIDE ACTIVE: ${JSON.stringify(localOverride.overriddenValue)}]`
              : "";
            lines.push(`  - [${sig.target}] ${sig.description} (confidence: ${Math.round(sig.confidence * 100)}%)${overrideNote}`);
            lines.push(`    Suggestion: ${sig.suggestion}`);
          }
          lines.push("");
        }

        if (proposal.suggestions.length > 0) {
          lines.push("### Suggestions:");
          for (let i = 0; i < proposal.suggestions.length; i++) {
            const sug = proposal.suggestions[i]!;
            // Check if there's a local override for this suggestion's target/capability
            const localOverride = overrideManager.listOverrides().find(
              (o) => o.target === sug.target && o.capability === sug.capability
            );
            const overrideNote = localOverride
              ? ` [LOCAL OVERRIDE: ${JSON.stringify(localOverride.overriddenValue)}]`
              : "";
            lines.push(`  ${i + 1}. [${sug.type}] Step ${sug.step ?? "N/A"}: ${sug.reason}${overrideNote}`);
            lines.push(`     Current: ${sug.current}`);
            lines.push(`     Suggested: ${sug.suggested}`);
            lines.push(`     Auto-apply: ${sug.autoApply ? "yes" : "no (requires approval)"}`);
          }
          lines.push("");
        }

        if (proposal.graduationCandidate) {
          lines.push("### Graduation Candidate");
          lines.push(`  This SOP has been executed ${proposal.totalExecutions} times with checkpoint approvals.`);
          lines.push(`  Consider graduating from ${doc.frontmatter.execution_classification} to Fully_Automated.`);
          lines.push("");
        }

        if (proposal.suggestions.length === 0) {
          lines.push("No optimization suggestions — SOP looks healthy!");
        }

        if (proposal.suggestions.length > 0) {
          const approvalReq = createApprovalRequest(stateDir, proposal, `opt_${Date.now()}`);
          lines.push(`### HITL Approval Required`);
          lines.push(`  Approval token: ${approvalReq.token}`);
          lines.push(`  Expires: ${approvalReq.expiresAt}`);
          lines.push(`  To apply: sop_optimize(action="apply", sop_title="${a.sop_title}", target_department="${a.target_department}")`);
          lines.push(`  Or approve via iMessage: reply "yes ${approvalReq.token}"`);
        }

        return okResult(lines.join("\n"));
      }

      if (a.action === "apply") {
        const overrideManager2 = createPlatformOverrideManager(stateDir, {
          pending: () => [],
          get: () => undefined,
          create: () => ({} as any),
          resolve: () => ({} as any),
          markNotified: () => {},
        } as any);

        const lowRiskSuggestions = proposal.suggestions.filter((s) => s.autoApply);
        const highRiskSuggestions = proposal.suggestions.filter((s) => !s.autoApply);

        // Filter out suggestions that have local overrides (respect user's choice)
        const effectiveHighRisk = highRiskSuggestions.filter((s) => {
          const localOverride = overrideManager2.listOverrides().find(
            (o) => o.target === s.target && o.capability === s.capability
          );
          return !localOverride;
        });

        if (effectiveHighRisk.length > 0 && !a.auto_apply_low_risk) {
          return errResult(
            `Cannot apply: ${effectiveHighRisk.length} high-risk suggestions require owner approval. ` +
            `Use auto_apply_low_risk=true to apply only low-risk changes (role map regeneration).`,
          );
        }

        const changes: string[] = [];
        saveVersion(stateDir, a.sop_title, a.target_department, markdown, changes.length > 0 ? changes : ["analysis only"], null);

        const lines = [
          `Applied ${changes.length} low-risk changes to "${a.sop_title}".`,
          `High-risk suggestions (${effectiveHighRisk.length}) require owner approval.`,
          "",
          "Next: review the suggestions above and approve/reject each one.",
        ];
        if (changes.length === 0) {
          lines.unshift("No low-risk changes to apply automatically.");
        }

        return okResult(lines.join("\n"));
      }

      return errResult(`Unknown action: ${a.action}`);
    },
  });
}

/**
 * `sop_checkpoint` — idempotent execution checkpoint state via the agentrun
 * scratchpad. Survives conversation restarts so progress is never lost.
 *
 * Actions:
 * - record: write checkpoint state keyed by sop + item, including completed
 *   count, current item, verified/resolved count, title-level count, unresolved
 *   gaps, and timestamp.
 * - read: return the latest checkpoint state for a given sop.
 * - list: list all checkpoints across SOPs.
 */
export function sopCheckpointTool(deps: { stateDir: StateDir }): RegisteredTool {
  const { stateDir } = deps;
  const scratchpad = new Scratchpad(stateDir);

  return defineTool({
    name: "sop_checkpoint",
    label: "SOP Checkpoint",
    description:
      "Record or read idempotent execution checkpoint state for an SOP run via the " +
      "agentrun scratchpad. Actions: record, read, list. Uses Scratchpad keys so " +
      "state survives conversation restarts. Parameters: action, sop_title, " +
      "target_department, item, completed, verified, titleLevel, unresolved, note.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("record"),
        Type.Literal("read"),
        Type.Literal("list"),
      ], { description: "record | read | list" }),
      sop_title: Type.Optional(Type.String({ description: "SOP title." })),
      target_department: Type.Optional(Type.String({ description: "Department." })),
      item: Type.Optional(Type.String({ description: "Current work item (e.g. account name)." })),
      completed: Type.Optional(Type.Number({ description: "Count of completed items." })),
      verified: Type.Optional(Type.Number({ description: "Count of verified/resolved items." })),
      titleLevel: Type.Optional(Type.Number({ description: "Count of title-level / partial items." })),
      unresolved: Type.Optional(Type.Number({ description: "Count of unresolved gaps." })),
      note: Type.Optional(Type.String({ description: "Free-form note for this checkpoint." })),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `sop_checkpoint ${(a as { action?: string }).action ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as {
        action: "record" | "read" | "list";
        sop_title?: string;
        target_department?: string;
        item?: string;
        completed?: number;
        verified?: number;
        titleLevel?: number;
        unresolved?: number;
        note?: string;
      };

      if (a.action === "list") {
        const keys = scratchpad.list().filter((k) => k.startsWith("sop-checkpoint:"));
        if (keys.length === 0) return okResult("No checkpoints recorded.");
        const lines = keys.map((k) => {
          const entry = scratchpad.lookup<{
            sop: string; item: string; completed: number; verified: number;
            titleLevel: number; unresolved: number; note?: string; updatedAt: string;
          }>(k);
          return `${k} | ${entry?.sop ?? "?"} | item: ${entry?.item ?? "?"} | completed: ${entry?.completed ?? 0} | verified: ${entry?.verified ?? 0} | titleLevel: ${entry?.titleLevel ?? 0} | unresolved: ${entry?.unresolved ?? 0} | updated: ${entry?.updatedAt ?? "?"}`;
        });
        return okResult(lines.join("\n"));
      }

      if (!a.sop_title || !a.target_department) {
        return errResult("sop_title and target_department are required.");
      }

      const key = `sop-checkpoint:${kebabCase(a.target_department)}:${kebabCase(a.sop_title)}`;

      if (a.action === "read") {
        const entry = scratchpad.lookup<{
          sop: string; department: string; item: string; completed: number;
          verified: number; titleLevel: number; unresolved: number; note?: string;
          updatedAt: string;
        }>(key);
        if (!entry) return okResult(`No checkpoint found for SOP "${a.sop_title}" (${a.target_department}).`);
        return okResult(
          `Checkpoint for "${a.sop_title}" (${a.target_department}):\n` +
          `  Current item: ${entry.item}\n` +
          `  Completed: ${entry.completed}\n` +
          `  Verified/resolved: ${entry.verified}\n` +
          `  Title-level/partial: ${entry.titleLevel}\n` +
          `  Unresolved gaps: ${entry.unresolved}\n` +
          `  Updated: ${entry.updatedAt}` +
          (entry.note ? `\n  Note: ${entry.note}` : ""),
        );
      }

      // action === "record"
      const now = new Date().toISOString();
      const existing = scratchpad.lookup<{ completed: number }>(key);
      const completed = a.completed ?? (existing ? existing.completed : 0);

      scratchpad.record(key, {
        sop: a.sop_title,
        department: a.target_department,
        item: a.item ?? "",
        completed,
        verified: a.verified ?? 0,
        titleLevel: a.titleLevel ?? 0,
        unresolved: a.unresolved ?? 0,
        note: a.note,
        updatedAt: now,
      });

      return okResult(
        `Checkpoint recorded for "${a.sop_title}" (${a.target_department}):\n` +
        `  Item: ${a.item ?? "(none)"}\n` +
        `  Completed: ${completed}\n` +
        `  Verified/resolved: ${a.verified ?? 0}\n` +
        `  Title-level/partial: ${a.titleLevel ?? 0}\n` +
        `  Unresolved gaps: ${a.unresolved ?? 0}\n` +
        `  Recorded at: ${now}`,
      );
    },
  });
}

/**
 * `sop_batch` — ship ranked batches of completed items for an SOP run.
 * Used by Hybrid SOPs to send partial results as items complete rather than
 * waiting for all items. Records the batch via the scratchpad for idempotency.
 *
 * Actions:
 * - record: save a batch with verified, title-level, and unresolved items.
 * - read: return the latest batch for a given sop.
 * - list: list all batches across SOPs.
 */
export function sopBatchTool(deps: { stateDir: StateDir }): RegisteredTool {
  const { stateDir } = deps;
  const scratchpad = new Scratchpad(stateDir);

  return defineTool({
    name: "sop_batch",
    label: "SOP Batch",
    description:
      "Record or read ranked batches of completed SOP items. Actions: record, " +
      "read, list. Batches are shipped as items complete (ranked batches), not " +
      "all-or-nothing. Parameters: action, sop_title, target_department, " +
      "batchNumber, verifiedItems, titleLevelItems, unresolvedItems.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("record"),
        Type.Literal("read"),
        Type.Literal("list"),
      ], { description: "record | read | list" }),
      sop_title: Type.Optional(Type.String({ description: "SOP title." })),
      target_department: Type.Optional(Type.String({ description: "Department." })),
      batchNumber: Type.Optional(Type.Number({ description: "Batch sequence number." })),
      verifiedItems: Type.Optional(Type.Array(Type.String(), { description: "Verified item descriptions." })),
      titleLevelItems: Type.Optional(Type.Array(Type.String(), { description: "Title-level / partial item descriptions." })),
      unresolvedItems: Type.Optional(Type.Array(Type.String(), { description: "Unresolved gap descriptions." })),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `sop_batch ${(a as { action?: string }).action ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as {
        action: "record" | "read" | "list";
        sop_title?: string;
        target_department?: string;
        batchNumber?: number;
        verifiedItems?: string[];
        titleLevelItems?: string[];
        unresolvedItems?: string[];
      };

      if (a.action === "list") {
        const keys = scratchpad.list().filter((k) => k.startsWith("sop-batch:"));
        if (keys.length === 0) return okResult("No batches recorded.");
        const lines = keys.map((k) => {
          const entry = scratchpad.lookup<{
            sop: string; batchNumber: number; verifiedCount: number;
            titleLevelCount: number; unresolvedCount: number; updatedAt: string;
          }>(k);
          return `${k} | ${entry?.sop ?? "?"} | batch: ${entry?.batchNumber ?? "?"} | verified: ${entry?.verifiedCount ?? 0} | titleLevel: ${entry?.titleLevelCount ?? 0} | unresolved: ${entry?.unresolvedCount ?? 0} | updated: ${entry?.updatedAt ?? "?"}`;
        });
        return okResult(lines.join("\n"));
      }

      if (!a.sop_title || !a.target_department || a.batchNumber === undefined) {
        return errResult("sop_title, target_department, and batchNumber are required.");
      }

      const key = `sop-batch:${kebabCase(a.target_department)}:${kebabCase(a.sop_title)}:${a.batchNumber}`;

      if (a.action === "read") {
        const entry = scratchpad.lookup<{
          sop: string; department: string; batchNumber: number;
          verifiedItems: string[]; titleLevelItems: string[];
          unresolvedItems: string[]; updatedAt: string;
        }>(key);
        if (!entry) return okResult(`No batch ${a.batchNumber} found for SOP "${a.sop_title}" (${a.target_department}).`);
        const lines = [
          `Batch ${entry.batchNumber} for "${entry.sop}" (${entry.department}):`,
          `  Verified/resolved (${entry.verifiedItems.length}):`,
          ...entry.verifiedItems.map((i) => `    - ${i}`),
          `  Title-level/partial (${entry.titleLevelItems.length}):`,
          ...entry.titleLevelItems.map((i) => `    - ${i}`),
          `  Unresolved gaps (${entry.unresolvedItems.length}):`,
          ...entry.unresolvedItems.map((i) => `    - ${i}`),
          `  Updated: ${entry.updatedAt}`,
        ];
        return okResult(lines.join("\n"));
      }

      // action === "record"
      const now = new Date().toISOString();
      scratchpad.record(key, {
        sop: a.sop_title,
        department: a.target_department,
        batchNumber: a.batchNumber,
        verifiedItems: a.verifiedItems ?? [],
        titleLevelItems: a.titleLevelItems ?? [],
        unresolvedItems: a.unresolvedItems ?? [],
        updatedAt: now,
      });

      const lines = [
        `Batch ${a.batchNumber} recorded for "${a.sop_title}" (${a.target_department}):`,
        `  Verified/resolved (${(a.verifiedItems ?? []).length}):`,
        ...(a.verifiedItems ?? []).map((i) => `    - ${i}`),
        `  Title-level/partial (${(a.titleLevelItems ?? []).length}):`,
        ...(a.titleLevelItems ?? []).map((i) => `    - ${i}`),
        `  Unresolved gaps (${(a.unresolvedItems ?? []).length}):`,
        ...(a.unresolvedItems ?? []).map((i) => `    - ${i}`),
        `  Recorded at: ${now}`,
      ];
      return okResult(lines.join("\n"));
    },
  });
}

/**
 * `sop_fallback` — define and read a fallback hierarchy for an SOP stage when
 * the primary tool/source is blocked (rate-limited, login wall, no accessible
 * evidence). Prevents the agent from stalling the entire pipeline on one
 * blocked item.
 *
 * Actions:
 * - set: define the fallback order for a stage (primary + fallbacks).
 * - read: return the fallback hierarchy for a stage.
 * - list: list all fallback definitions across SOPs.
 */
export function sopFallbackTool(deps: { stateDir: StateDir }): RegisteredTool {
  const { stateDir } = deps;
  const scratchpad = new Scratchpad(stateDir);

  return defineTool({
    name: "sop_fallback",
    label: "SOP Fallback Hierarchy",
    description:
      "Define or read a fallback hierarchy for an SOP stage when the primary " +
      "tool/source is blocked. Actions: set, read, list. Parameters: action, " +
      "sop_title, target_department, stage, primary, fallbacks.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("set"),
        Type.Literal("read"),
        Type.Literal("list"),
      ], { description: "set | read | list" }),
      sop_title: Type.Optional(Type.String({ description: "SOP title." })),
      target_department: Type.Optional(Type.String({ description: "Department." })),
      stage: Type.Optional(Type.String({ description: "Stage name (e.g. buyer-resolution)." })),
      primary: Type.Optional(Type.String({ description: "Primary tool/source (e.g. LinkedIn browser)." })),
      fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback tools/sources in order (e.g. ['public web/company pages', 'Apollo', 'people search tools'])." })),
    }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (a) => `sop_fallback ${(a as { action?: string }).action ?? ""}` },
    execute: async (args: any): Promise<ToolResultLike> => {
      const a = args as {
        action: "set" | "read" | "list";
        sop_title?: string;
        target_department?: string;
        stage?: string;
        primary?: string;
        fallbacks?: string[];
      };

      if (a.action === "list") {
        const keys = scratchpad.list().filter((k) => k.startsWith("sop-fallback:"));
        if (keys.length === 0) return okResult("No fallback hierarchies defined.");
        const lines = keys.map((k) => {
          const entry = scratchpad.lookup<{
            sop: string; department: string; stage: string; primary: string;
            fallbacks: string[]; updatedAt: string;
          }>(k);
          return `${k} | stage: ${entry?.stage ?? "?"} | primary: ${entry?.primary ?? "?"} | fallbacks: ${(entry?.fallbacks ?? []).join(" > ")} | updated: ${entry?.updatedAt ?? "?"}`;
        });
        return okResult(lines.join("\n"));
      }

      if (!a.sop_title || !a.target_department || !a.stage) {
        return errResult("sop_title, target_department, and stage are required.");
      }

      const key = `sop-fallback:${kebabCase(a.target_department)}:${kebabCase(a.sop_title)}:${kebabCase(a.stage)}`;

      if (a.action === "read") {
        const entry = scratchpad.lookup<{
          sop: string; department: string; stage: string; primary: string;
          fallbacks: string[]; updatedAt: string;
        }>(key);
        if (!entry) return okResult(`No fallback hierarchy defined for stage "${a.stage}" in SOP "${a.sop_title}" (${a.target_department}).`);
        return okResult(
          `Fallback hierarchy for "${entry.stage}" in "${entry.sop}" (${entry.department}):\n` +
          `  Primary: ${entry.primary}\n` +
          `  Fallbacks: ${entry.fallbacks.join(" > ")}\n` +
          `  Updated: ${entry.updatedAt}`,
        );
      }

      // action === "set"
      if (!a.primary || !a.fallbacks || a.fallbacks.length === 0) {
        return errResult("primary and fallbacks (non-empty array) are required for action 'set'.");
      }

      const now = new Date().toISOString();
      scratchpad.record(key, {
        sop: a.sop_title,
        department: a.target_department,
        stage: a.stage,
        primary: a.primary,
        fallbacks: a.fallbacks,
        updatedAt: now,
      });

      return okResult(
        `Fallback hierarchy set for "${a.stage}" in "${a.sop_title}" (${a.target_department}):\n` +
        `  Primary: ${a.primary}\n` +
        `  Fallbacks: ${a.fallbacks.join(" > ")}\n` +
        `  Set at: ${now}`,
      );
    },
  });
}

/**
 * Register the new execution-discipline tools. Call this from boot.ts alongside
 * the other agentrun tool registrations.
 */
export function registerSopExecutionDisciplineTools(deps: {
  stateDir: StateDir;
}): RegisteredTool[] {
  return [
    sopCheckpointTool(deps),
    sopBatchTool(deps),
    sopFallbackTool(deps),
  ];
}

