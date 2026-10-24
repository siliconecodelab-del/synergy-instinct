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
import type { AgentRunResult } from "./types.js";
import { makeAdapters } from "./adapters.js";

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
  const deps: WorkflowDeps = withRecovery(driver, {
    runEffect: adapters.runEffect,
    runNode: adapters.runNode,
    runJudge: adapters.runJudge,
    recordDecision,
    signal: options?.signal,
  });

  let result: WorkflowRunResult;
  try {
    result = await runWorkflow(workflow, input, deps);
  } finally {
    await driver.close().catch(() => undefined);
  }

  if (result.status === "complete") {
    return { status: "complete", output: result.output };
  }
  return {
    status: "escalated",
    escalation: {
      reason: (result as { escalation?: { reason?: string } }).escalation?.reason ?? "workflow escalated",
      executionPath: (result as { escalation?: { executionPath?: string } }).escalation?.executionPath,
    },
  };
}
