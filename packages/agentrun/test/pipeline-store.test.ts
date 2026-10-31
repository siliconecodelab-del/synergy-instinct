import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { PipelineStore } from "../src/pipeline-store.js";

describe("PipelineStore", () => {
  it("save/get/list/remove", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-"));
    const state = new StateDir(root);
    state.ensure();
    const store = new PipelineStore(state);
    const rec = store.save({ id: "p1", sop: "a/b", mode: "auto", stages: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect(store.get("p1")?.id).toBe("p1");
    expect(store.list().length).toBe(1);
    expect(store.bySop("a/b")?.id).toBe("p1");
    expect(store.remove("p1")).toBe(true);
    expect(store.get("p1")).toBeUndefined();
  });
});