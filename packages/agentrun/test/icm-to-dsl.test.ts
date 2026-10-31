import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { icmToDsl, saveDslWorkflow } from "../src/icm-to-dsl.js";

describe("icmToDsl", () => {
  it("converts ICM workspace with entry file and stages to DSL workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "icm-"));
    const stagesDir = join(root, "stages");
    mkdirSync(stagesDir, { recursive: true });

    writeFileSync(join(root, "AGENTS.md"), `# Entry\nRoutes to stages/triage.md for processing.\n`);
    writeFileSync(join(stagesDir, "triage.md"), `# Triage Stage\nProcess inbound messages.\n`);

    const result = icmToDsl(root, { name: "test-icm" });
    expect(result.workflow.v).toBe(2);
    expect(result.workflow.name).toBe("test-icm");
    expect(result.entryFile).toBe("AGENTS.md");
    expect(result.stages).toContain("stages/triage.md");
    expect(result.icmRoot).toBe(root);

    // The root should be a chain with one agent node per stage
    const rootNode = result.workflow.root as any;
    expect(rootNode.node).toBe("chain");
    expect(rootNode.steps.length).toBe(1);
    expect(rootNode.steps[0].node).toBe("agent");
    expect(rootNode.steps[0].label).toBe("Triage Stage");
  });

  it("uses single agent node when no stages found", () => {
    const root = mkdtempSync(join(tmpdir(), "icm2-"));
    writeFileSync(join(root, "AGENTS.md"), `# Entry\nNo stage references here.\n`);

    const result = icmToDsl(root);
    const rootNode = result.workflow.root as any;
    expect(rootNode.node).toBe("agent");
    expect(result.stages.length).toBe(0);
  });

  it("saves DSL workflow to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "icm3-"));
    const stagesDir = join(root, "stages");
    mkdirSync(stagesDir, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), `# Entry\nRoutes to stages/triage.md.\n`);
    writeFileSync(join(stagesDir, "triage.md"), `# Triage\nProcess messages.\n`);

    const result = icmToDsl(root, { name: "save-test" });
    const stateDir = new StateDir(root);
    stateDir.ensure();
    const saved = saveDslWorkflow(stateDir, result);
    expect(saved.path).toContain("agentrun/dsls/save-test.json");
    expect(saved.workflow.name).toBe("save-test");

    // Verify file exists and is valid JSON
    const fs = require("node:fs");
    const content = fs.readFileSync(saved.path, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.v).toBe(2);
    expect(parsed.name).toBe("save-test");
  });
});