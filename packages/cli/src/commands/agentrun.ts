/** `instinct agentrun <subcommand>`: inspect, validate, dry-run, list, and run AgentRun workflows. */
import { parse, str, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { inspectWorkflow, validateWorkflow, dryRunWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const agentrunOptions: OptionSpec = {
  dataDir: { type: "string" },
};

export async function runAgentrun(ctx: CliContext, argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    ctx.print("Usage: instinct agentrun <inspect|validate|dry-run|list|run> <file|name> [--data-dir <dir>]");
    return 0;
  }

  switch (subcommand) {
    case "inspect":
    case "validate": {
      const file = rest[0];
      if (!file) {
        ctx.print("Usage: instinct agentrun inspect <workflow.json>");
        return 0;
      }
      try {
        const wf = JSON.parse(readFileSync(file, "utf8")) as Workflow;
        validateWorkflow(wf);
        ctx.print(`Workflow "${String((wf as { name?: unknown }).name ?? "(unnamed)")}" is valid.`);
        return 0;
      } catch (err) {
        ctx.print(`Invalid: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    case "dry-run": {
      const file = rest[0];
      if (!file) {
        ctx.print("Usage: instinct agentrun dry-run <workflow.json> [input.json]");
        return 0;
      }
      try {
        const wf = JSON.parse(readFileSync(file, "utf8")) as Workflow;
        const inputFile = rest[1];
        const input = inputFile ? JSON.parse(readFileSync(inputFile, "utf8")) : {};
        const result = await dryRunWorkflow(wf, { input });
        if (result.ok) {
          ctx.print(`Dry-run ${result.status}: ${result.skipped?.length ? `skipped: ${result.skipped.join(", ")}` : "all checks ran"}`);
        } else {
          ctx.print(`Dry-run failed: ${result.problems.join("; ")}`);
          return 1;
        }
        return 0;
      } catch (err) {
        ctx.print(`Dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    case "list": {
      const { values } = parse("agentrun", rest, agentrunOptions);
      const dataDir = str(values, "dataDir") ?? ".instinct";
      const workflowsDir = join(dataDir, "workflows");
      if (!existsSync(workflowsDir)) {
        ctx.print("No saved workflows.");
        return 0;
      }
      const names = readdirSync(workflowsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
      if (names.length === 0) {
        ctx.print("No saved workflows.");
        return 0;
      }
      ctx.print(names.join("\n"));
      return 0;
    }
    case "run": {
      ctx.print("agentrun run requires a running agent server. Use `instinct dev` to start one, then call the `agentrun` tool from chat.");
      return 0;
    }
    default:
      ctx.print(`Unknown subcommand "${subcommand}". Use: inspect, validate, dry-run, list, run`);
      return 1;
  }
}
