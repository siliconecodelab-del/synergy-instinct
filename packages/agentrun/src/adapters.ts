/**
 * AgentRun adapters for Open Instinct.
 *
 * `makeAdapters` builds the three adapters the AgentRun interpreter needs:
 * - `runEffect` dispatches permitted tools through Open Instinct's registry,
 *   subject to the same policy guard (tiers, grants, spend, approvals) as
 *   direct agent tool calls.
 * - `runNode` runs a Pi conversation with the node's projected input and
 *   captures a schema-checked structured result.
 * - `runJudge` answers typed questions via Jev (live) or a fixed-probability
 *   fallback (offline/dev).
 */
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { SystemOneAnswer, SystemOneQuestion } from "@parcha/agentrun-dsl";
import { createJevRunner, type JevJudge } from "@parcha/agentrun-jev";
import { Type } from "typebox";
import {
  AgentRuntime,
  ApprovalStore,
  AuditLog,
  PolicyEngine,
  ToolRegistry,
  type Capability,
  type Channel,
  type Principal,
  type ToolContext,
} from "@open-instinct/core";
import type { Outbox } from "@open-instinct/core";
import type { AgentRunAdapterDeps } from "./types.js";

const RESULT_TOOL = "__agentrun_result__";

/** Build the three AgentRun adapters from Open Instinct dependencies. */
export function makeAdapters(deps: AgentRunAdapterDeps) {
  const {
    registry,
    policy,
    approvals,
    audit,
    outbox,
    model,
    ownerPrincipal,
    channel = "chat",
    jevRunner,
    now = () => new Date(),
  } = deps;

  // ------------------------------------------------------------------
  // runEffect — dispatch workflow `call` nodes through Open Instinct tools
  // ------------------------------------------------------------------

  const runEffect = async (params: {
    node: { via: string; tool?: string; label: string; as: string; deadline_s: number; produces?: string[] };
    input: Record<string, unknown>;
    attempt: number;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<unknown> => {
    const { node, input, signal } = params;
    if (node.via !== "tool" || !node.tool) {
      throw new Error(`Workflow call node "${node.label}": only via:tool is supported, got ${node.via ?? "(none)"}`);
    }

    const tool = registry.get(node.tool);
    if (!tool) {
      throw new Error(`Workflow call node "${node.label}": unknown tool "${node.tool}"`);
    }

    const meta = tool.spec.meta;
    const principal = ownerPrincipal();
    const ctx: ToolContext = {
      principal,
      conversationKey: `agentrun:${params.idempotencyKey}`,
      channel,
      now,
    };

    // Policy guard — same gate as AgentRuntime.guard
    const decision = policy.evaluate(principal, meta, input);
    if (decision.outcome === "deny") {
      throw new Error(`Workflow call node "${node.label}": blocked by policy: ${decision.reason}`);
    }
    if (decision.outcome === "ask") {
      throw new Error(`Workflow call node "${node.label}": requires owner approval: ${decision.approvalPrompt ?? decision.reason}`);
    }

    // Audit the tool call
    audit.append({
      kind: "tool_call",
      conversationKey: ctx.conversationKey,
      principal: principal.id,
      detail: { tool: node.tool, workflow: true, attempt: params.attempt, summary: meta.describe ? meta.describe(input) : node.tool },
    });

    // Spend audit
    const spends = meta.capabilities.some((c) => ["purchase", "travel.book"].includes(c));
    const amountUsd = meta.amountUsd ? meta.amountUsd(input) : undefined;
    if ((amountUsd !== undefined && amountUsd > 0) || spends) {
      audit.append({
        kind: "spend",
        conversationKey: ctx.conversationKey,
        principal: principal.id,
        detail: { tool: node.tool, ...(amountUsd !== undefined ? { amountUsd } : {}), summary: meta.describe ? meta.describe(input) : node.tool, workflow: true },
      });
    }

    // Execute
    try {
      const result = await tool.spec.execute(input, ctx, signal);
      return result;
    } catch (err) {
      audit.append({
        kind: "error",
        conversationKey: ctx.conversationKey,
        principal: principal.id,
        detail: { message: err instanceof Error ? err.message : String(err), tool: node.tool, workflow: true },
      });
      throw err;
    }
  };

  // ------------------------------------------------------------------
  // runNode — run a Pi conversation and capture a structured result
  // ------------------------------------------------------------------

  const runNode = async (params: {
    kind: "agent" | "decide" | "extract" | "report";
    label: string;
    system: string[];
    user: string;
    schema: Record<string, unknown>;
    tools?: string[];
    signal?: AbortSignal;
  }): Promise<unknown> => {
    const { kind, label, system, user, schema, tools: toolNames, signal } = params;
    const runtime: AgentRuntime = deps.runtime;
    const principal = ownerPrincipal();

    // Conversation key for this workflow node run
    const convKey = `agentrun:node:${label}`;
    const conv = runtime.conversation(convKey, principal, { deliveryKey: convKey, replyRef: {} });

    // Build the tools available to this node: registry tools filtered by names,
    // plus a result capture tool that stores the structured answer.
    const available = registry.all();
    const nodeTools: AgentTool<any>[] = [];
    if (toolNames && toolNames.length > 0) {
      const wanted = new Set(toolNames);
      for (const t of available) {
        if (wanted.has(t.spec.name)) nodeTools.push(toAgentTool(t));
      }
    } else {
      // No tool restriction: expose all registry tools (full surface per policy).
      for (const t of available) nodeTools.push(toAgentTool(t));
    }

    let captured: unknown = undefined;
    const resultTool: AgentTool<any> = {
      name: RESULT_TOOL,
      label: "Capture structured result",
      description: `Submit the structured answer for node "${label}" matching the declared output schema.`,
      parameters: schema as Record<string, unknown>,
      execute: async (_id, args) => {
        captured = args;
        return { content: [{ type: "text", text: "Result captured." }], details: undefined };
      },
    };

    conv.agent.state.tools = [...nodeTools, resultTool];

    // Build system prompt: node instructions + directive to use the result tool.
    const systemText = system.length > 0 ? system.join("\n\n") : "";
    const resultInstruction = `
You are running workflow node "${label}" (kind: ${kind}).
Your job is to produce a structured result matching the declared output schema.
When you have the answer, call the "__agentrun_result__" tool with the structured fields.
Do not add extra text after calling the tool. The tool result is the final answer.
`;
    const prompt = `${systemText}${resultInstruction}\n\n---\nInput (state):\n${user}`;

    // Manually set the system message (Conversation.applySystemPrompt is private).
    const tools = conv.agent.state.tools.map(toToolDeclaration);
    const systemMsg = createInitialSystemMessage(prompt, tools);
    const rest = conv.agent.state.messages.filter((m) => m.role !== "system");
    conv.agent.state.messages = systemMsg ? [systemMsg, ...rest] : rest;

    await conv.agent.prompt(user);
    await conv.agent.waitForIdle();

    if (captured === undefined) {
      throw new Error(`Workflow node "${label}" (${kind}): no structured result captured; the model did not call "${RESULT_TOOL}".`);
    }

    return captured;
  };

  // ------------------------------------------------------------------
  // runJudge — answer typed questions via Jev or offline fallback
  // ------------------------------------------------------------------

  let jev: JevJudge;
  if (jevRunner) {
    jev = jevRunner;
  } else if (typeof process !== "undefined" && process.env.TYPESAFE_API_KEY) {
    jev = createJevRunner({ timeoutMs: 30_000, maxAttempts: 3 });
    } else {
    // Offline fallback: fixed-probability noul answers (no key, no network).
    jev = async (params: { label: string; kind: string; state: unknown; questions: Record<string, SystemOneQuestion> }): Promise<{
      answers: Record<string, SystemOneAnswer>;
      model?: string | null;
      usage?: { input_tokens: number; output_tokens: number } | null;
      cost_usd?: number | null;
      request_sha256?: string;
    }> => {
      const answers: Record<string, SystemOneAnswer> = {};
      for (const [id, q] of Object.entries(params.questions)) {
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: 0.5 };
        } else if (q.type === "choice") {
          answers[id] = { type: "choice", choice: "", probabilities: {}, confidence: 0 };
        } else if (q.type === "score") {
          answers[id] = { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 0 };
        }
      }
      return { answers, model: null, usage: null, cost_usd: null };
    };
  }

  const runJudge = async (params: {
    label: string;
    kind: "judge" | "pick" | "sift" | "route" | "ask";
    state: unknown;
    questions: Record<string, SystemOneQuestion>;
    signal?: AbortSignal;
    decisionId?: string;
  }): Promise<{
    answers: Record<string, SystemOneAnswer>;
    model?: string | null;
    usage?: { input_tokens: number; output_tokens: number } | null;
    cost_usd?: number | null;
    request_sha256?: string;
  }> => {
    const { label, kind, state, questions, signal } = params;
    const result = await jev({ label, kind, state, questions, signal, decisionId: params.decisionId });
    return {
      answers: result.answers,
      model: result.model ?? null,
      usage: result.usage ?? null,
      cost_usd: result.cost_usd ?? null,
      request_sha256: result.request_sha256,
    };
  };

  return { runEffect, runNode, runJudge };
}

/** Convert a core RegisteredTool-like spec to a Pi AgentTool. */
function toAgentTool(tool: {
  spec: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    meta: {
      capabilities: Capability[];
      describe?: (args: unknown) => string;
      amountUsd?: (args: unknown) => number | undefined;
    };
    execute: (args: unknown, ctx: ToolContext, signal?: AbortSignal) => Promise<unknown>;
  };
}): AgentTool<any> {
  const spec = tool.spec;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as Record<string, unknown>,
    execute: async (_id, params, signal) => {
      const result = await spec.execute(params, {} as ToolContext, signal);
      return { content: [{ type: "text", text: String(result) }], details: undefined };
    },
  };
}

// Re-export types used by the caller
export type { AgentRunAdapterDeps };
export type AgentRunAdapters = ReturnType<typeof makeAdapters>;
