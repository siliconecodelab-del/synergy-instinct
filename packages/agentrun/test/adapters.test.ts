import { describe, it, expect, vi } from "vitest";
import { makeAdapters } from "../src/adapters.js";
import type { AgentRunAdapterDeps } from "../src/types.js";
import { PolicyEngine, defaultPolicy, ToolRegistry, defineTool, textResult, type Principal, type ToolMeta, type Capability } from "@open-instinct/core";
import { Type } from "typebox";
import { Scratchpad } from "../src/scratchpad.js";
import { StateDir } from "@open-instinct/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makePrincipal(): Principal {
  return { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" };
}

function tempState(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "agentrun-adapters-"));
  return new StateDir(root);
}

function cleanup(state: StateDir): void {
  rmSync(state.root, { recursive: true, force: true });
}

function makeDeps(scratchpad?: Scratchpad): AgentRunAdapterDeps {
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
    state: tempState(),
    ownerPrincipal: () => makePrincipal(),
    channel: "chat",
    now: () => new Date(),
    scratchpad,
  } as unknown as AgentRunAdapterDeps;
}

describe("makeAdapters with scratchpad idempotency", () => {
  it("runEffect executes and records when scratchpad claim is fresh", async () => {
    const state = tempState();
    try {
      const deps = makeDeps(new Scratchpad(state));
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
      const result1 = await runEffect({
        node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
        input: { query: "open instinct" },
        attempt: 1,
        idempotencyKey: "key-fresh",
        signal: new AbortController().signal,
      });
      const text1 = typeof result1 === "string" ? result1 : (result1 as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text1).toContain("results for open instinct");

      // Second call with same key returns cached result, tool NOT re-executed.
      const result2 = await runEffect({
        node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
        input: { query: "DIFFERENT QUERY" },
        attempt: 2,
        idempotencyKey: "key-fresh",
        signal: new AbortController().signal,
      });
      const text2 = typeof result2 === "string" ? result2 : (result2 as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text2).toContain("results for open instinct"); // cached, not "DIFFERENT QUERY"
    } finally {
      cleanup(state);
    }
  });

  it("runEffect without scratchpad executes every time (no idempotency)", async () => {
    const deps = makeDeps(undefined);
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
    const result1 = await runEffect({
      node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
      input: { query: "first" },
      attempt: 1,
      idempotencyKey: "key-no-scratchpad",
      signal: new AbortController().signal,
    });
    const text1 = typeof result1 === "string" ? result1 : (result1 as { content: Array<{ type: string; text: string }> }).content[0].text;
    expect(text1).toContain("results for first");

    const result2 = await runEffect({
      node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
      input: { query: "second" },
      attempt: 2,
      idempotencyKey: "key-no-scratchpad",
      signal: new AbortController().signal,
    });
    const text2 = typeof result2 === "string" ? result2 : (result2 as { content: Array<{ type: string; text: string }> }).content[0].text;
    expect(text2).toContain("results for second"); // no scratchpad, so re-executed
  });

  it("runEffect propagates audit entries for tool calls", async () => {
    const state = tempState();
    try {
      const deps = makeDeps(new Scratchpad(state));
      const tool = defineTool({
        name: "web_search",
        label: "Web search",
        description: "Search the web",
        parameters: Type.Object({ query: Type.String() }),
        meta: { capabilities: ["web.read"], group: "web" },
        execute: async (args) => textResult(`results for ${(args as any).query}`),
      });
      deps.registry.register(tool);
      const auditAppend = deps.audit.append as ReturnType<typeof vi.fn>;

      const { runEffect } = makeAdapters(deps);
      await runEffect({
        node: { via: "tool", tool: "web_search", label: "search", as: "result", deadline_s: 10 },
        input: { query: "audit test" },
        attempt: 1,
        idempotencyKey: "key-audit",
        signal: new AbortController().signal,
      });

      expect(auditAppend).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tool_call", detail: expect.objectContaining({ tool: "web_search", workflow: true }) }),
      );
    } finally {
      cleanup(state);
    }
  });
});
