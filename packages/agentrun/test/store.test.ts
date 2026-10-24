import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { WorkflowStore } from "../src/store.js";

function tempStateDir(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "agentrun-test-"));
  return new StateDir(root);
}

function cleanup(dir: StateDir): void {
  rmSync(dir.root, { recursive: true, force: true });
}

describe("WorkflowStore", () => {
  it("saves, loads, lists, and removes workflows", () => {
    const state = tempStateDir();
    const store = new WorkflowStore(state);
    try {
      expect(store.list()).toEqual([]);

      const wf = { v: 2, name: "wf-1", schemas: {}, input: { schemaId: "Input" }, output: { schemaId: "Output" }, root: { node: "code", label: "x", code: "s => s" } };
      store.save("wf-1", wf);
      expect(store.list()).toEqual(["wf-1"]);

      const loaded = store.load("wf-1");
      expect(loaded).toEqual(wf);

      expect(store.load("nonexistent")).toBeUndefined();

      expect(store.remove("wf-1")).toBe(true);
      expect(store.list()).toEqual([]);
      expect(store.remove("wf-1")).toBe(false);
    } finally {
      cleanup(state);
    }
  });

  it("creates the workflows directory if missing", () => {
    const state = tempStateDir();
    const store = new WorkflowStore(state);
    try {
      store.save("x", { v: 2 });
      const dir = join(state.root, "workflows");
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBe(1);
    } finally {
      cleanup(state);
    }
  });
});
