import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnTraceRecorder, argsHash, type TurnTraceInput } from "../src/trace.js";
import { StateDir } from "@open-instinct/core";

function tempState(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "agentrun-trace-"));
  return new StateDir(root);
}

function cleanup(state: StateDir): void {
  rmSync(state.root, { recursive: true, force: true });
}

const input: TurnTraceInput = {
  conversationKey: "imessage:+15550001111",
  channel: "imessage",
  from: "owner",
  text: "Verify LinkedIn profile",
  messageId: "msg-1",
  receivedAt: "2026-11-10T09:00:00Z",
};

const principal = { id: "owner", tier: "owner", kind: "owner" };

describe("TurnTraceRecorder", () => {
  afterEach(() => {
    // each test gets a fresh temp dir
  });

  it("start creates a trace and returns turnId + finish callback", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      const { turnId, finish } = recorder.start(input, principal);
      expect(turnId).toMatch(/^turn-[0-9a-f]{16}$/);
      const trace = recorder.read(turnId);
      expect(trace).toBeDefined();
      expect(trace!.turnId).toBe(turnId);
      expect(trace!.status).toBe("acked");
      expect(trace!.input).toEqual(input);
      expect(trace!.principal).toEqual(principal);
      expect(trace!.toolCalls).toEqual([]);
      expect(trace!.decisions).toEqual([]);
      expect(new Date(trace!.startedAt).getTime()).toBeLessThanOrEqual(Date.now());

      finish({ status: "completed", reply: "done", durationMs: 1234 });
      const updated = recorder.read(turnId);
      expect(updated!.status).toBe("completed");
      expect(updated!.reply).toBe("done");
      expect(updated!.durationMs).toBe(1234);
      expect(updated!.finishedAt).toBeDefined();
    } finally {
      cleanup(state);
    }
  });

  it("read returns undefined for a missing trace", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      expect(recorder.read("turn-missing")).toBeUndefined();
    } finally {
      cleanup(state);
    }
  });

  it("appendToolCall adds a tool call to the trace", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      const { turnId } = recorder.start(input, principal);
      recorder.appendToolCall(turnId, {
        tool: "computer",
        argsHash: "a1b2c3d4",
        outcome: "ok",
      });
      const trace = recorder.read(turnId);
      expect(trace!.toolCalls).toHaveLength(1);
      expect(trace!.toolCalls[0]).toMatchObject({ tool: "computer", argsHash: "a1b2c3d4", outcome: "ok" });
    } finally {
      cleanup(state);
    }
  });

  it("appendToolCall is a no-op for a missing trace", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      expect(() => recorder.appendToolCall("turn-missing", { tool: "x", argsHash: "h", outcome: "ok" })).not.toThrow();
    } finally {
      cleanup(state);
    }
  });

  it("appendDecision adds a decision to the trace", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      const { turnId } = recorder.start(input, principal);
      recorder.appendDecision(turnId, { kind: "policy", tool: "web_search", outcome: "allow" });
      recorder.appendDecision(turnId, { kind: "approval", tool: "stripe.pay", outcome: "ask", reason: "needs owner consent" });
      const trace = recorder.read(turnId);
      expect(trace!.decisions).toHaveLength(2);
      expect(trace!.decisions[0]).toMatchObject({ kind: "policy", tool: "web_search", outcome: "allow" });
      expect(trace!.decisions[1]).toMatchObject({ kind: "approval", tool: "stripe.pay", outcome: "ask", reason: "needs owner consent" });
    } finally {
      cleanup(state);
    }
  });

  it("list returns all turnIds", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      const t1 = recorder.start({ ...input, messageId: "m1", receivedAt: "2026-11-10T09:00:00Z" }, principal);
      const t2 = recorder.start({ ...input, messageId: "m2", receivedAt: "2026-11-10T09:01:00Z" }, principal);
      const t3 = recorder.start({ ...input, messageId: "m3", receivedAt: "2026-11-10T09:02:00Z" }, principal);
      const ids = recorder.list();
      expect(ids).toHaveLength(3);
      expect(ids.sort()).toEqual([t1.turnId, t2.turnId, t3.turnId].sort());
    } finally {
      cleanup(state);
    }
  });

  it("list returns empty array when no traces exist", () => {
    const state = tempState();
    try {
      const recorder = new TurnTraceRecorder(state);
      expect(recorder.list()).toEqual([]);
    } finally {
      cleanup(state);
    }
  });
});

describe("argsHash", () => {
  it("produces a stable 16-char hex hash", () => {
    const h1 = argsHash({ query: "open instinct" });
    const h2 = argsHash({ query: "open instinct" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different hashes for different args", () => {
    const h1 = argsHash({ query: "a" });
    const h2 = argsHash({ query: "b" });
    expect(h1).not.toBe(h2);
  });

  it("is stable for the same args object", () => {
    const obj = { a: 1, b: 2 };
    expect(argsHash(obj)).toBe(argsHash(obj));
  });
});
