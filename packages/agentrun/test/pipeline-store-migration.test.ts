import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { PipelineStore } from "../src/pipeline-store.js";

describe("PipelineStore locking, migration, and retention", () => {
  it("save/get/list/remove with locking", () => {
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

  it("imports legacy records from /data/Company-brain/pipelines/", () => {
    const root = mkdtempSync(join(tmpdir(), "psmig-"));
    const state = new StateDir(root);
    state.ensure();

    const legacyDir = join(root, "Company-brain", "pipelines");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "pipe_legacy.json"), JSON.stringify({
      id: "pipe_legacy",
      sop: "legacy/sop",
      mode: "guided",
      stages: { sop: { status: "done" }, icm: { status: "pending" } },
      lastPrompt: "build_icm",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
    }));

    const store = new PipelineStore(state);
    const result = store.migrateLegacyRecords(state);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const imported = store.get("pipe_legacy");
    expect(imported).toBeDefined();
    expect(imported!.sop).toBe("legacy/sop");
    expect(imported!.mode).toBe("guided");
    expect(imported!.stages.sop?.status).toBe("done");
    expect(imported!.stages.icm?.status).toBe("pending");
  });

  it("skips already-imported legacy records on re-migration", () => {
    const root = mkdtempSync(join(tmpdir(), "psmig2-"));
    const state = new StateDir(root);
    state.ensure();

    const legacyDir = join(root, "Company-brain", "pipelines");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "pipe_dup.json"), JSON.stringify({
      id: "pipe_dup",
      sop: "dup/sop",
      mode: "auto",
      stages: {},
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
    }));

    const store = new PipelineStore(state);
    // Pre-import the same id
    store.save({ id: "pipe_dup", sop: "dup/sop", mode: "auto", stages: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

    const result = store.migrateLegacyRecords(state);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("removes old pipelines via retention", () => {
    const root = mkdtempSync(join(tmpdir(), "psret-"));
    const state = new StateDir(root);
    state.ensure();
    const store = new PipelineStore(state);

    // Write an old record directly with old updatedAt (save() always sets now)
    fs.writeFileSync(store.file("old"), JSON.stringify({
      id: "old", sop: "old/sop", mode: "auto", stages: {},
      createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
    }));
    store.save({ id: "new", sop: "new/sop", mode: "auto", stages: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const result = store.retention(30);
    expect(result.removedPipelines).toBe(1);
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBeDefined();
  });
});