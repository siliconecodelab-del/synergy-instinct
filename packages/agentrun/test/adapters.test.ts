import { describe, it, expect, vi } from "vitest";
import { makeAdapters } from "../src/adapters.js";
import type { AgentRunAdapterDeps } from "../src/types.js";
import { PolicyEngine, defaultPolicy, ToolRegistry, defineTool, textResult, type Principal, type ToolMeta, type Capability } from "@open-instinct/core";
import { Type } from "typebox";

function makePrincipal(): Principal {
  return { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" };
}

function makeDeps(): AgentRunAdapterDeps {
  const registry = new ToolRegistry();
  const policy = new PolicyEngine(defaultPolicy());
  const approvals: any = { create: vi.fn(), resolve: vi.fn(), pending: () => [], findPending: () => undefined, consume: () => undefined, promptedToken: () => 0, markPrompted: vi.fn(), clearPrompted: vi.fn() };
  const audit: any = { append: vi.fn() };
  const outbox: any = { send: vi.fn(), typing: vi.fn() };
  const model: any = { id: "test", provider: "test" };
  const runtime: any = { ownerPrincipal: () => makePrincipal(), conversation: () => ({ agent: { state: { tools: [], messages: [] }, prompt: vi.fn(), waitForIdle: vi.fn() } }) };

  return {
    registry,
    policy,
    approvals,
    audit,
    outbox,
    model,
    state: undefined as any,
    ownerPrincipal: () => makePrincipal(),
    channel: "chat",
    now: () => new Date(),
  } as unknown as AgentRunAdapterDeps;
}

describe("makeAdapters", () => {
  it("runEffect allows a tool the owner may use directly", async () => {
    const deps = makeDeps();
    const tool = defineTool({
      name: "web_search",
      label: "Web search",
      description: "Search the web",
      parameters: Type.Object({ query: Type.String() }),
      meta: { capabilities: ["web.read"], group: "web" },
      execute: async (args) => textResult(`results for ${(args as any).query}`),
    });
    deps.registry.register(tool);

    const { runEffect } = makeAdapters(deps);
    const result = await runEffect({
      node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
      input: { query: "open instinct" },
      attempt: 1,
      idempotencyKey: "key-1",
      signal: new AbortController().signal,
    });
    const text = typeof result === "string" ? result : (result as { content: Array<{ type: string; text: string }> }).content[0].text;
    expect(text).toContain("results for open instinct");
  });

  it("runEffect blocks an unknown tool", async () => {
    const deps = makeDeps();
    const { runEffect } = makeAdapters(deps);
    await expect(
      runEffect({
        node: { via: "tool", tool: "nonexistent", label: "bad", as: "x", deadline_s: 10 },
        input: {},
        attempt: 1,
        idempotencyKey: "key-2",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("runEffect blocks a stranger-only tool for a non-owner principal", async () => {
    const deps = makeDeps();
    const tool = defineTool({
      name: "computer_use",
      label: "Computer",
      description: "Use desktop",
      parameters: Type.Object({ action: Type.String() }),
      meta: { capabilities: ["computer.use"], group: "computer" },
      execute: async () => textResult("done"),
    });
    deps.registry.register(tool);

    // computer.use is owner-only; a stranger gets denied
    const strangerPolicy = deps.policy;
    const { runEffect } = makeAdapters({
      ...deps,
      ownerPrincipal: () => ({ kind: "stranger", id: "stranger:imessage:+1234", tier: "stranger", displayName: "Stranger" }),
    });
    await expect(
      runEffect({
        node: { via: "tool", tool: "computer_use", label: "compute", as: "x", deadline_s: 10 },
        input: { action: "click" },
        attempt: 1,
        idempotencyKey: "key-3",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/blocked by policy/);
  });

  it("runJudge fallback returns noul answers", async () => {
    const deps = makeDeps();
    const { runJudge } = makeAdapters(deps);
    const result = await runJudge({
      label: "check",
      kind: "judge",
      state: { text: "hello" },
      questions: {
        q1: { type: "noul", question: "Is it true?", instructions: "Answer yes or no" },
      },
      signal: new AbortController().signal,
    });
    expect(result.answers.q1).toBeDefined();
    expect(result.answers.q1.type).toBe("noul");
    expect(typeof result.answers.q1.noul).toBe("number");
  });
});
