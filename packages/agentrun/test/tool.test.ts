import { describe, it, expect, vi } from "vitest";
import { agentrunTool } from "../src/tool.js";
import { WorkflowStore } from "../src/store.js";
import { StateDir } from "@open-instinct/core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkflow, dryRunWorkflow } from "@parcha/agentrun-dsl";

function tempStateDir(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "agentrun-tool-test-"));
  return new StateDir(root);
}

function cleanup(dir: StateDir): void {
  require("node:fs").rmSync(dir.root, { recursive: true, force: true });
}

const WF = {
  v: 2,
  name: "test-wf",
  schemas: {
    Input: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    Output: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Output", path: "result" },
  root: { node: "code", label: "double", code: "s => ({ result: { value: s.value * 2 } })" },
};

function makeDeps() {
  const state = tempStateDir();
  const store = new WorkflowStore(state);
  const registry: any = {
    all: () => [],
    get: () => undefined,
  };
  const adapters: any = {
    runEffect: vi.fn(),
    runNode: vi.fn(),
    runJudge: vi.fn(),
  };
  const tool = agentrunTool({ store, adapters, stateDir: state, registry });
  return { state, store, tool, cleanup: () => cleanup(state) };
}

describe("agentrunTool", () => {
  it("describe lists available tools", async () => {
    const { tool, cleanup } = makeDeps();
    try {
      const result = await tool.spec.execute({ action: "describe" }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("AgentRun");
      expect(text).toContain("inspect");
    } finally {
      cleanup();
    }
  });

  it("list returns saved workflows", async () => {
    const { tool, store, cleanup } = makeDeps();
    try {
      store.save("alpha", WF);
      store.save("beta", WF);
      const result = await tool.spec.execute({ action: "list" }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    } finally {
      cleanup();
    }
  });

  it("save stores a workflow", async () => {
    const { tool, store, cleanup } = makeDeps();
    try {
      const result = await tool.spec.execute({ action: "save", name: "my-wf", workflow: WF }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("Saved workflow \"my-wf\"");
      expect(store.load("my-wf")).toEqual(WF);
    } finally {
      cleanup();
    }
  });

  it("load returns a saved workflow", async () => {
    const { tool, store, cleanup } = makeDeps();
    try {
      store.save("keep", WF);
      const result = await tool.spec.execute({ action: "load", name: "keep" }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(JSON.parse(text)).toEqual(WF);
    } finally {
      cleanup();
    }
  });

  it("inspect accepts a valid workflow", async () => {
    const { tool, cleanup } = makeDeps();
    try {
      const result = await tool.spec.execute({ action: "inspect", workflow: WF }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("structurally valid");
    } finally {
      cleanup();
    }
  });

  it("inspect rejects an invalid workflow", async () => {
    const { tool, cleanup } = makeDeps();
    try {
      const result = await tool.spec.execute({ action: "inspect", workflow: { v: 99 } }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }>; isError?: boolean }).content[0].text;
      expect(result.isError).toBe(true);
      expect(text).toContain("failed");
    } finally {
      cleanup();
    }
  });

  it("dry-run uses the DSL", async () => {
    const { tool, cleanup } = makeDeps();
    try {
      const result = await tool.spec.execute({ action: "dry-run", workflow: WF }, {} as any);
      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("Dry-run");
    } finally {
      cleanup();
    }
  });
});
