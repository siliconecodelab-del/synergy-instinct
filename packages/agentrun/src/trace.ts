/**
 * Per-turn trace recording for AgentRun observability.
 *
 * Each `/chat` turn is recorded as a trace under `<data>/agentrun/traces/<turnId>/trace.json`,
 * capturing the input, principal, tools called (with argsHash), results, decisions,
 * approvals, spend, and outcome. Traces are replayable: given a trace file you can
 * reconstruct exactly what the agent saw and did during that turn.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { StateDir } from "@open-instinct/core";

export interface TurnTraceInput {
  conversationKey: string;
  channel: string;
  from: string;
  text?: string;
  messageId: string;
  receivedAt: string;
}

export interface TurnTraceToolCall {
  tool: string;
  argsHash: string;
  args?: Record<string, unknown>;
  outcome: "ok" | "error";
  error?: string;
  durationMs?: number;
}

export interface TurnTraceDecision {
  kind: "policy" | "approval" | "spend";
  tool?: string;
  outcome: "allow" | "deny" | "ask";
  reason?: string;
}

export interface TurnTrace {
  turnId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  input: TurnTraceInput;
  principal: { id: string; tier: string; kind: string };
  toolCalls: TurnTraceToolCall[];
  decisions: TurnTraceDecision[];
  spendUsd?: number;
  status: "acked" | "completed" | "escalated" | "error";
  reply?: string;
  conversationKey: string;
}

export class TurnTraceRecorder {
  private readonly dir: string;

  constructor(stateDir: StateDir) {
    this.dir = stateDir.path("agentrun", "traces");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Start a new trace. Returns the turnId and a callback to finish it. */
  start(input: TurnTraceInput, principal: { id: string; tier: string; kind: string }): { turnId: string; finish: (trace: Partial<TurnTrace>) => void } {
    const turnId = `turn-${createHash("sha256").update(`${input.messageId}:${input.receivedAt}`).digest("hex").slice(0, 16)}`;
    const traceDir = join(this.dir, turnId);
    mkdirSync(traceDir, { recursive: true });

    const trace: TurnTrace = {
      turnId,
      startedAt: new Date().toISOString(),
      input,
      principal,
      toolCalls: [],
      decisions: [],
      status: "acked",
      conversationKey: input.conversationKey,
    };
    this.write(traceDir, trace);

    return {
      turnId,
      finish: (updates: Partial<TurnTrace>) => {
        const updated = { ...trace, ...updates, finishedAt: new Date().toISOString() };
        if (updates.durationMs !== undefined) updated.durationMs = updates.durationMs;
        this.write(traceDir, updated);
      },
    };
  }

  /** Append a tool call to an existing trace. */
  appendToolCall(turnId: string, call: TurnTraceToolCall): void {
    const trace = this.read(turnId);
    if (!trace) return;
    trace.toolCalls.push(call);
    this.write(join(this.dir, turnId), trace);
  }

  /** Append a decision to an existing trace. */
  appendDecision(turnId: string, decision: TurnTraceDecision): void {
    const trace = this.read(turnId);
    if (!trace) return;
    trace.decisions.push(decision);
    this.write(join(this.dir, turnId), trace);
  }

  /** Read a trace by turnId. */
  read(turnId: string): TurnTrace | undefined {
    const file = join(this.dir, turnId, "trace.json");
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as TurnTrace;
    } catch {
      return undefined;
    }
  }

  /** List all trace turnIds, newest first. */
  list(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => existsSync(join(this.dir, e, "trace.json")))
      .sort((a, b) => {
        const ta = this.read(a);
        const tb = this.read(b);
        const da = ta?.startedAt ?? "";
        const db = tb?.startedAt ?? "";
        return db.localeCompare(da);
      });
  }

  private write(dir: string, trace: TurnTrace): void {
    writeFileSync(join(dir, "trace.json"), JSON.stringify(trace, null, 2) + "\n", "utf8");
  }
}

/** Stable hash of normalized tool arguments for idempotency/dedup in traces. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
}
