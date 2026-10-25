import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDir } from "@open-instinct/core";
import { sopArchitectTool } from "../src/tool.js";

function tempStateDir(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "sop-tool-test-"));
  return new StateDir(root);
}

function cleanup(dir: StateDir): void {
  rmSync(dir.root, { recursive: true, force: true });
}

describe("sopArchitectTool", () => {
  it("generates a Manual SOP and writes it to disk", async () => {
    const state = tempStateDir();
    try {
      const tool = sopArchitectTool({ stateDir: state });

      const result = await tool.spec.execute(
        {
          sop_title: "New Hire Onboarding",
          target_department: "HR",
          execution_classification: "Manual",
          core_objective: "Onboard new hires effectively",
          required_tools_or_skills: ["Slack", "HRIS"],
          raw_procedural_steps:
            "1. Send welcome email\n2. Set up HRIS account\n3. Schedule orientation",
        },
        {} as any,
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("New Hire Onboarding");
      expect(text).toContain("written to");

      // Verify the file exists
      const fs = require("node:fs");
      const files = fs.readdirSync(state.root, { recursive: true });
      const sopFile = files.find((f) => f.includes("new-hire-onboarding.md"));
      expect(sopFile).toBeDefined();

      const content = readFileSync(join(state.root, sopFile), "utf8");
      expect(content).toContain("---");
      expect(content).toContain("execution_classification: Manual");
      expect(content).toContain("## Procedural Steps");
    } finally {
      cleanup(state);
    }
  });

  it("generates a Fully_Automated SOP", async () => {
    const state = tempStateDir();
    try {
      const tool = sopArchitectTool({ stateDir: state });

      const result = await tool.spec.execute(
        {
          sop_title: "Data Sync",
          target_department: "Engineering",
          execution_classification: "Fully_Automated",
          core_objective: "Sync data daily",
          required_tools_or_skills: ["CRM API"],
          raw_procedural_steps: "1. Fetch records\n2. Transform\n3. Load",
        },
        {} as any,
      );

      const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain("Fully_Automated");
    } finally {
      cleanup(state);
    }
  });

  it("fails when the SOP already exists", async () => {
    const state = tempStateDir();
    try {
      const tool = sopArchitectTool({ stateDir: state });

      const params = {
        sop_title: "Duplicate",
        target_department: "HR",
        execution_classification: "Manual",
        core_objective: "Test",
        required_tools_or_skills: [],
        raw_procedural_steps: "1. Step",
      };

      const first = await tool.spec.execute(params, {} as any);
      expect(first.isError).toBeUndefined();

      const second = await tool.spec.execute(params, {} as any);
      expect(second.isError).toBe(true);
      const text = (second as { content: Array<{ type: string; text: string }> }).content[0].text;
      expect(text).toContain("already exists");
    } finally {
      cleanup(state);
    }
  });

  it("validates required fields", async () => {
    const state = tempStateDir();
    try {
      const tool = sopArchitectTool({ stateDir: state });

      const result = await tool.spec.execute(
        {
          // missing sop_title
          target_department: "HR",
          execution_classification: "Manual",
          core_objective: "Test",
          required_tools_or_skills: [],
          raw_procedural_steps: "1. Step",
        },
        {} as any,
      );

      expect(result.isError).toBe(true);
    } finally {
      cleanup(state);
    }
  });
});
