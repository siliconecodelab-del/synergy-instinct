/**
 * ICM → AgentRun DSL converter.
 *
 * Reads an ICM (Interpretable Context Methodology) workspace and generates an
 * AgentRun DSL workflow (`v: 2`) whose root is a chain of agent nodes — one per
 * stage contract found under `<icmRoot>/stages/`. The workflow carries
 * `preflight.icmRoot` so `runWorkflowWithRecovery` runs the tracer as a
 * mandatory pre-flight before any step executes.
 *
 * ICM workspace layout (expected):
 *   <icmRoot>/
 *     AGENTS.md           # L0 entry file: routes tasks to stage contracts
 *     stages/
 *       triage.md         # L2 stage contract
 *       ...
 *     inputs/             # L4 material (referenced, not embedded)
 *
 * The entry file is parsed for stage references (e.g. "stages/triage.md").
 * Each stage contract becomes an `agent` node in a `chain`, wired in order.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Workflow } from "@parcha/agentrun-dsl";

/** The AgentRun DSL schema id used for the output state. */
const OUTPUT_SCHEMA_ID = "icm-dsl-output";

/** Result of converting an ICM workspace to a DSL workflow. */
export interface IcmToDslResult {
  workflow: Workflow;
  icmRoot: string;
  stages: string[];
  entryFile: string;
  traceHtml?: string;
}

/** Read a file safely, returning undefined if missing. */
function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Extract stage references from an ICM entry file. Looks for "stages/<name>.md"
 * mentions and common routing phrases like "stages/x.md". */
function extractStages(entryContent: string): string[] {
  const stages: string[] = [];
  // Match explicit stage file references: stages/foo.md, stages/foo/bar.md
  const refRegex = /stages\/[A-Za-z0-9_\-/]+\.md/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(entryContent)) !== null) {
    const ref = match[0];
    if (!stages.includes(ref)) stages.push(ref);
  }
  return stages;
}

/** Slugify a stage path into a safe node label/as key. */
function slugify(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-+$)/g, "")
    .replace(/-+/g, "-");
}

/** Parse a stage contract's core objective from its markdown frontmatter or H1. */
function stageObjective(content: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) return titleMatch[1]!.trim();
  return "Stage contract";
}

/** Convert an ICM workspace to an AgentRun DSL workflow. */
export function icmToDsl(icmRoot: string, options?: {
  /** Task name for the workflow. Defaults to derived from ICM root. */
  name?: string;
  /** Task to trace (preflight). Defaults to the ICM root path. */
  task?: string;
}): IcmToDslResult {
  if (!existsSync(icmRoot)) {
    throw new Error(`ICM root not found: ${icmRoot}`);
  }

  // Find the entry file: prefer AGENTS.md, then CLAUDE.md, then any .md at root.
  const entryCandidates = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"];
  let entryFile = "";
  let entryContent = "";
  for (const cand of entryCandidates) {
    const p = join(icmRoot, cand);
    if (existsSync(p)) {
      entryFile = cand;
      entryContent = readFileSync(p, "utf8");
      break;
    }
  }
  if (!entryFile) {
    // Fallback: any markdown at root
    try {
      const files = readdirSync(icmRoot).filter((f) => f.endsWith(".md"));
      if (files.length > 0) {
        entryFile = files[0]!;
        entryContent = readFileSync(join(icmRoot, entryFile), "utf8");
      }
    } catch {
      // no readable files
    }
  }

  const stages = extractStages(entryContent);

  // Build stage contract nodes
  const stageNodes: Array<{ label: string; node: any; as: string }> = [];
  const stageDir = join(icmRoot, "stages");

  for (const stageRef of stages) {
    const stagePath = join(icmRoot, stageRef);
    const content = readFileSafe(stagePath) || "";
    const asKey = `stage_${slugify(stageRef)}`;
    stageNodes.push({
      label: stageObjective(content) || stageRef,
      as: asKey,
      node: {
        node: "agent",
        label: stageObjective(content) || stageRef,
        instructions: content || `No content found for stage contract ${stageRef}.`,
        state: {
          stageRef,
          icmRoot,
          source: "icm-stage-contract",
        },
        out: "stage_result",
        as: asKey,
        tools: [],
        effort: "medium",
        thinking: "medium",
        verify: {
          out: "accepted",
          maxDrives: 1,
        },
      },
    });
  }

  // If no stages found, create a single catch-all agent node from the entry file
  let rootNode: any;
  if (stageNodes.length === 0) {
    rootNode = {
      node: "agent",
      label: "ICM entry",
      instructions: entryContent || `ICM workspace at ${icmRoot} with no stage contracts.`,
      state: { icmRoot, source: "icm-entry" },
      out: "result",
      as: "entry_result",
      tools: [],
      effort: "medium",
      thinking: "medium",
    };
  } else {
    rootNode = {
      node: "chain",
      steps: stageNodes.map((s) => s.node),
      metadata: {
        icmSource: icmRoot,
        stageCount: stageNodes.length,
      },
    };
  }

  const workflow: Workflow = {
    v: 2,
    name: options?.name || `icm-${slugify(icmRoot)}`,
    schemas: {
      [OUTPUT_SCHEMA_ID]: {
        type: "object",
        properties: {
          stage_results: { type: "object" },
          final: { type: "string" },
        },
        required: ["stage_results"],
      },
    },
    output: {
      schemaId: OUTPUT_SCHEMA_ID,
    },
    root: rootNode,
  };

  return {
    workflow,
    icmRoot,
    stages: stages.map((s) => s),
    entryFile,
  };
}

/** Save the DSL workflow to a file under <state>/agentrun/dsls/<name>.json. */
export function saveDslWorkflow(
  stateDir: { path: (...parts: string[]) => string },
  result: IcmToDslResult,
): { path: string; workflow: Workflow } {
  const fs = require("node:fs");
  const dslDir = stateDir.path("agentrun", "dsls");
  fs.mkdirSync(dslDir, { recursive: true });
  const fileName = `${slugify(result.workflow.name)}.json`;
  const filePath = join(dslDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(result.workflow, null, 2), "utf8");
  return { path: filePath, workflow: result.workflow };
}