/**
 * Adapter configuration for bridging AgentRun workflows to Open Instinct.
 */
import type { AgentRuntime, ApprovalStore, AuditLog, Outbox, PolicyEngine, Principal, StateDir, ToolRegistry } from "@open-instinct/core";
import type { Model } from "@earendil-works/pi-ai";
import type { JevJudge } from "@parcha/agentrun-jev";

export interface AgentRunAdapterDeps {
  /** Open Instinct runtime for conversation-backed agent steps. */
  runtime: AgentRuntime;
  /** Tool registry for `call` node dispatch (full tool surface, policy guarded). */
  registry: ToolRegistry;
  /** Policy engine for capability/tier/spend/approval gating. */
  policy: PolicyEngine;
  /** Approval store for owner-consented tool calls. */
  approvals: ApprovalStore;
  /** Audit log for tool_call / spend entries. */
  audit: AuditLog;
  /** Outbox for notifying the owner of pending approvals. */
  outbox: Outbox;
  /** Pi model for `runNode` agent steps. */
  model: Model<any>;
  /** State directory for workflow/run storage. */
  state: StateDir;
  /** Resolves the owner principal for workflow runs. */
  ownerPrincipal: () => Principal;
  /** Channel for workflow conversations. Defaults to "chat". */
  channel?: "chat" | "a2a" | "imessage" | "sms" | "email";
  /** Optional live Jev runner. Without it, `runJudge` uses a fixed-probability offline fallback. */
  jevRunner?: JevJudge;
  /** Clock. Defaults to system time. */
  now?: () => Date;
}

/** Result of `runWorkflowWithRecovery`. */
export interface AgentRunResult {
  status: "complete" | "escalated";
  output?: unknown;
  escalation?: { reason: string; executionPath?: string; state?: Record<string, unknown> };
}
