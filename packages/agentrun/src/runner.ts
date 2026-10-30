/**
 * Durable workflow runner for Open Instinct.
 *
 * Wraps `@parcha/agentrun-dsl`'s `runWorkflow` with pi-durable recovery via
 * `@parcha/agentrun-dsl/recovery`, so an interrupted workflow run can be
 * resumed without re-executing committed steps. Decisions are recorded to
 * `<data>/agentrun/decisions/` and run journals to `<data>/agentrun/runs/`.
 */
import { openRecovery, withRecovery, fileStore, type RecoveryDriver } from "@parcha/agentrun-dsl/recovery";
import { runWorkflow, type Workflow, type WorkflowDeps, type WorkflowRunResult } from "@parcha/agentrun-dsl";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunResult, PreflightSpec } from "./types.js";
import { makeAdapters } from "./adapters.js";
import { runPreflight } from "./workflow-tracer.js";

/** Shape of the adapters returned by `makeAdapters`. */
export type AgentRunAdapters = ReturnType<typeof makeAdapters>;

/** Run a workflow with recovery and decision recording. */
export async function runWorkflowWithRecovery(
  workflow: Workflow,
  input: Record<string, unknown>,
  adapters: AgentRunAdapters,
  stateDir: { path: (...parts: string[]) => string },
  options?: { runId?: string; signal?: AbortSignal },
): Promise<AgentRunResult> {
  const runId = options?.runId ?? `run-${crypto.randomUUID()}`;
  const runsDir = stateDir.path("agentrun", "runs", runId);
  const decisionsDir = stateDir.path("agentrun", "decisions");

  // Ensure directories exist
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(decisionsDir, { recursive: true });

  // Recovery store for this run
  const store = fileStore(runsDir);
  const driver: RecoveryDriver = await openRecovery(store, workflow, { key: runId });

  // Decision recorder: persist each decision receipt as a JSON file
  const recordDecision = async (receipt: { id: string; [k: string]: unknown }, exchange: unknown): Promise<void> => {
    const file = join(decisionsDir, `${receipt.id}.json`);
    writeFileSync(file, JSON.stringify({ receipt, exchange, recordedAt: new Date().toISOString() }, null, 2));
  };

  // Wrap with recovery: runEffect/runNode/runJudge learn about committed state
  // runCode is passed through for sandboxed code-node execution.
  const deps: WorkflowDeps = withRecovery(driver, {
    runEffect: adapters.runEffect,
    runNode: adapters.runNode,
    runJudge: adapters.runJudge,
    runCode: adapters.runCode ?? undefined,
    recordDecision,
    signal: options?.signal,
  });

  // Optional tracer-based pre-flight check: if the workflow declares an ICM root,
  // run the trace first and escalate before any step executes on a failure.
  const preflight = (workflow as { preflight?: PreflightSpec }).preflight;
  let preflightResult: { passed: boolean; checks: Array<{ name: string; pass: boolean; note: string }>; htmlPath?: string; reason?: string } | undefined;
  if (preflight) {
    const outDir = preflight.outDir ?? stateDir.path("agentrun", "traces", runId);
    mkdirSync(outDir, { recursive: true });
    const task = preflight.task ?? String((input as Record<string, unknown>).task ?? (input as Record<string, unknown>).goal ?? "");
    preflightResult = await runPreflight(preflight.icmRoot, task, outDir);
    if (!preflightResult.passed) {
      await driver.close().catch(() => undefined);
      return {
        status: "escalated",
        escalation: {
          reason: preflightResult.reason ?? "preflight_failed",
          checks: preflightResult.checks,
        },
        preflight: preflightResult,
      };
    }
  }

  let result: WorkflowRunResult;
  try {
    result = await runWorkflow(workflow, input, deps);
  } finally {
    await driver.close().catch(() => undefined);
  }

  if (result.status === "complete") {
    return { status: "complete", output: result.output, preflight: preflightResult };
  }
  return {
    status: "escalated",
    escalation: {
      reason: (result as { escalation?: { reason?: string } }).escalation?.reason ?? "workflow escalated",
      executionPath: (result as { escalation?: { executionPath?: string } }).escalation?.executionPath,
    },
    preflight: preflightResult,
  };
}
