import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDir } from "@open-instinct/core";
import { sopArchitectTool, sopProactiveNudgeTool } from "../src/tool.js";
import { PipelineStore } from "../src/pipeline-store.js";

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
      expect(content).toContain("## Role Map: Where You Fit vs. Where the Agent Fits");
      expect(content).toContain("## Procedural Steps");
      expect(text).toContain("Role Map (Where You Fit vs. Where the Agent Fits):");

      // Verify PipelineStore was seeded with classification
      const ps = new PipelineStore(state);
      const rec = ps.bySop("hr/new-hire-onboarding");
      expect(rec).toBeDefined();
      expect(rec?.classification).toBe("Manual");
      expect(rec?.stages.sop?.status).toBe("done");
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

  it("sopProactiveNudgeTool scans, tracks checkpoint approvals, and graduates Hybrid -> Fully_Automated", async () => {
    const state = tempStateDir();
    try {
      const archTool = sopArchitectTool({ stateDir: state });
      const nudgeTool = sopProactiveNudgeTool({ stateDir: state });

      // 1. Create a Hybrid SOP
      await archTool.spec.execute(
        {
          sop_title: "Gmail Triage",
          target_department: "GTM-playbook",
          execution_classification: "Hybrid",
          core_objective: "Triage inbox and reply to VIPs",
          required_tools_or_skills: ["gmail"],
          raw_procedural_steps: "1. Fetch unread\n2. Draft VIP replies\n3. Review and approve VIP drafts\n4. Send replies",
        },
        {} as any,
      );

      // 2. Record 5 consecutive unedited approvals
      for (let i = 1; i <= 4; i++) {
        const r = await nudgeTool.spec.execute(
          {
            action: "record_checkpoint_approval",
            sop_title: "Gmail Triage",
            target_department: "GTM-playbook",
            edited: false,
          },
          {} as any,
        );
        expect(r.content[0].text).toContain(`consecutive unedited approvals: ${i}`);
      }

      const fifth = await nudgeTool.spec.execute(
        {
          action: "record_checkpoint_approval",
          sop_title: "Gmail Triage",
          target_department: "GTM-playbook",
          edited: false,
        },
        {} as any,
      );
      expect(fifth.content[0].text).toContain("Graduation Nudge Ready:");
      expect(fifth.content[0].text).toContain("graduate this SOP from Hybrid to Fully Automated");

      // 3. Graduate the SOP
      const gradRes = await nudgeTool.spec.execute(
        {
          action: "graduate",
          sop_title: "Gmail Triage",
          target_department: "GTM-playbook",
        },
        {} as any,
      );
      expect(gradRes.content[0].text).toContain("Graduated SOP \"Gmail Triage\" to Fully_Automated");
      expect(gradRes.content[0].text).toContain("Fully Automated");

      const ps = new PipelineStore(state);
      expect(ps.bySop("gtm-playbook/gmail-triage")?.classification).toBe("Fully_Automated");
    } finally {
      cleanup(state);
    }
  });
});
