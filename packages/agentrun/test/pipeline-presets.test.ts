import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { listPresets, loadPreset, savePreset, deletePreset, type PipelinePreset } from "../src/pipeline-presets.js";

describe("pipeline-presets", () => {
  it("lists empty when no presets", () => {
    const root = mkdtempSync(join(tmpdir(), "preset-"));
    const state = new StateDir(root);
    state.ensure();
    expect(listPresets(state)).toEqual([]);
  });

  it("save, load, list, delete round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "preset2-"));
    const state = new StateDir(root);
    state.ensure();

    const preset: PipelinePreset = {
      name: "test-preset",
      department: "GTM-playbook",
      classification: "Hybrid",
      tools: ["gmail", "notion"],
      steps: "1. Check inbox. 2. Log to Notion.",
    };
    const saved = savePreset(state, preset);
    expect(saved.name).toBe("test-preset");

    const list = listPresets(state);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("test-preset");

    const loaded = loadPreset(state, "test-preset");
    expect(loaded).toBeDefined();
    expect(loaded!.tools).toEqual(["gmail", "notion"]);

    const deleted = deletePreset(state, "test-preset");
    expect(deleted).toBe(true);
    expect(loadPreset(state, "test-preset")).toBeUndefined();
    expect(listPresets(state)).toEqual([]);
  });

  it("sanitizes preset names", () => {
    const root = mkdtempSync(join(tmpdir(), "preset3-"));
    const state = new StateDir(root);
    state.ensure();

    const preset: PipelinePreset = {
      name: "My Preset!!",
      department: "GTM-playbook",
      classification: "Manual",
      tools: [],
      steps: "test",
    };
    const saved = savePreset(state, preset);
    expect(saved.name).toBe("My Preset!!"); // original name preserved
    // File is saved under sanitized key
    const loaded = loadPreset(state, "My Preset!!");
    expect(loaded).toBeDefined();
  });
});