import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDir } from "@open-instinct/core";
import { writeSOP, resolveSOPPath, listSOPs, kebabCase } from "../src/sop-generator.js";
import { buildSOPDocument } from "../src/sop-okf.js";

function tempStateDir(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "sop-test-"));
  return new StateDir(root);
}

function cleanup(dir: StateDir): void {
  rmSync(dir.root, { recursive: true, force: true });
}

describe("kebabCase", () => {
  it("converts to kebab-case", () => {
    expect(kebabCase("GTM-playbook")).toBe("gtm-playbook");
    expect(kebabCase("Research and Dev")).toBe("research-and-dev");
    expect(kebabCase("My SOP Title")).toBe("my-sop-title");
    expect(kebabCase("  Multiple   Spaces  ")).toBe("multiple-spaces");
  });
});

describe("writeSOP", () => {
  it("writes an SOP file and returns its path", () => {
    const state = tempStateDir();
    try {
      const doc = buildSOPDocument({
        sop_title: "My SOP",
        target_department: "GTM-playbook",
        execution_classification: "Manual",
        core_objective: "Test objective",
        required_tools_or_skills: ["Slack"],
        raw_procedural_steps: "1. Step one\n2. Step two",
      });

      const result = writeSOP(state, doc);
      expect(result.created).toBe(true);
      expect(result.path).toContain("Company-brain");
      expect(result.path).toContain("SOPs");
      expect(result.path).toContain("gtm-playbook");
      expect(result.path.endsWith("my-sop.md")).toBe(true);
    } finally {
      cleanup(state);
    }
  });

  it("creates nested directories", () => {
    const state = tempStateDir();
    try {
      const doc = buildSOPDocument({
        sop_title: "Deploy",
        target_department: "Engineering",
        execution_classification: "Fully_Automated",
        core_objective: "Deploy app",
        required_tools_or_skills: ["CI/CD"],
        raw_procedural_steps: "1. Build\n2. Deploy",
      });

      const result = writeSOP(state, doc);
      // Verify file exists on disk
      const fs = require("node:fs");
      expect(fs.existsSync(result.path)).toBe(true);
    } finally {
      cleanup(state);
    }
  });

  it("refuses to overwrite an existing SOP", () => {
    const state = tempStateDir();
    try {
      const doc = buildSOPDocument({
        sop_title: "Duplicate",
        target_department: "HR",
        execution_classification: "Manual",
        core_objective: "Test",
        required_tools_or_skills: [],
        raw_procedural_steps: "1. Step",
      });

      writeSOP(state, doc);
      expect(() => writeSOP(state, doc)).toThrow(/already exists/);
    } finally {
      cleanup(state);
    }
  });

  it("resolveSOPPath builds the expected path", () => {
    const state = tempStateDir();
    try {
      const path = resolveSOPPath(state, "GTM-playbook", "My SOP");
      expect(path).toContain("Company-brain/SOPs/gtm-playbook/my-sop.md");
    } finally {
      cleanup(state);
    }
  });

  it("listSOPs returns saved files", () => {
    const state = tempStateDir();
    try {
      expect(listSOPs(state)).toEqual([]);

      const doc1 = buildSOPDocument({
        sop_title: "SOP A",
        target_department: "HR",
        execution_classification: "Manual",
        core_objective: "A",
        required_tools_or_skills: [],
        raw_procedural_steps: "1. A",
      });
      writeSOP(state, doc1);

      const doc2 = buildSOPDocument({
        sop_title: "SOP B",
        target_department: "Engineering",
        execution_classification: "Hybrid",
        core_objective: "B",
        required_tools_or_skills: ["GitHub"],
        raw_procedural_steps: "1. B",
      });
      writeSOP(state, doc2);

      const sops = listSOPs(state);
      expect(sops.length).toBe(2);
      expect(sops.some((p) => p.includes("hr/sop-a.md"))).toBe(true);
      expect(sops.some((p) => p.includes("engineering/sop-b.md"))).toBe(true);
    } finally {
      cleanup(state);
    }
  });
});
