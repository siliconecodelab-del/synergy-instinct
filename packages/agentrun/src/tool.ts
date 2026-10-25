/**
 * The `agentrun` tool: lets an Open Instinct agent author, inspect, validate,
 * dry-run, save, load, list, and run AgentRun workflows.
 *
 * Registered in the Open Instinct `ToolRegistry` when `INSTINCT_AGENTRUN=1`.
 * Actions map to `@parcha/agentrun-dsl` operations plus Open Instinct storage.
 */
import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolResultLike, type ToolRegistry } from "@open-instinct/core";
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
} from "./sop-okf.js";
import {
  writeSOP,
  resolveSOPPath,
  listSOPs,
  checkToolAvailability,
  updateSOPToolStatus,
  getToolConnectLink,
} from "./sop-generator.js";

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
