import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { readPipelinePrefs, writePipelinePrefs } from "../src/pipeline-prefs.js";

describe("pipeline-prefs", () => {
  it("defaults to auto mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-"));
    const state = new StateDir(root);
    state.ensure();
    const prefs = readPipelinePrefs(state);
    expect(prefs.mode).toBe("auto");
  });

  it("sets and reads guided mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pp2-"));
    const state = new StateDir(root);
    state.ensure();
    const set = writePipelinePrefs(state, { mode: "guided" });
    expect(set.mode).toBe("guided");
    const get = readPipelinePrefs(state);
    expect(get.mode).toBe("guided");
  });

  it("persists across StateDir instances", () => {
    const root = mkdtempSync(join(tmpdir(), "pp3-"));
    const state1 = new StateDir(root);
    state1.ensure();
    writePipelinePrefs(state1, { mode: "guided" });
    const state2 = new StateDir(root);
    const prefs = readPipelinePrefs(state2);
    expect(prefs.mode).toBe("guided");
  });
});