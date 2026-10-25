import { describe, it, expect } from "vitest";
import {
  validateSOPFrontmatter,
  buildSOPDocument,
  serializeSOP,
  OKF_SCHEMA_VERSION,
  type ExecutionClassification,
} from "../src/sop-okf.js";

describe("OKF SOP validation", () => {
  const validFrontmatter = {
    title: "Test SOP",
    department: "GTM-playbook",
    execution_classification: "Manual" as ExecutionClassification,
    core_objective: "Test objective",
    required_tools_or_skills: ["Slack", "CRM API"],
    created_at: "2026-01-01T00:00:00Z",
    version: OKF_SCHEMA_VERSION,
    status: "draft",
  };

  it("accepts a valid frontmatter", () => {
    const errors = validateSOPFrontmatter(validFrontmatter);
    expect(errors).toEqual([]);
  });

  it("rejects missing required fields", () => {
    const errors = validateSOPFrontmatter({});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "title")).toBe(true);
    expect(errors.some((e) => e.field === "department")).toBe(true);
  });

  it("rejects invalid execution_classification", () => {
    const errors = validateSOPFrontmatter({
      ...validFrontmatter,
      execution_classification: "Invalid" as ExecutionClassification,
    });
    expect(errors.some((e) => e.field === "execution_classification")).toBe(true);
  });

  it("rejects invalid status", () => {
    const errors = validateSOPFrontmatter({
      ...validFrontmatter,
      status: "unknown" as any,
    });
    expect(errors.some((e) => e.field === "status")).toBe(true);
  });

  it("rejects empty title", () => {
    const errors = validateSOPFrontmatter({
      ...validFrontmatter,
      title: "",
    });
    expect(errors.some((e) => e.field === "title")).toBe(true);
  });

  it("rejects invalid created_at timestamp", () => {
    const errors = validateSOPFrontmatter({
      ...validFrontmatter,
      created_at: "not-a-date",
    });
    expect(errors.some((e) => e.field === "created_at")).toBe(true);
  });
});

describe("buildSOPDocument", () => {
  it("builds a Manual classification SOP with owners and checkpoints", () => {
    const doc = buildSOPDocument({
      sop_title: "Onboarding",
      target_department: "HR",
      execution_classification: "Manual",
      core_objective: "Onboard new hires",
      required_tools_or_skills: ["Slack", "HRIS"],
      raw_procedural_steps: "1. Send welcome email\n2. Set up accounts\n3. Schedule orientation",
    });

    expect(doc.frontmatter.title).toBe("Onboarding");
    expect(doc.frontmatter.department).toBe("HR");
    expect(doc.frontmatter.execution_classification).toBe("Manual");
    expect(doc.frontmatter.status).toBe("draft");
    expect(doc.frontmatter.version).toBe(OKF_SCHEMA_VERSION);
    expect(doc.body.steps.length).toBeGreaterThan(0);
    // Manual: every 3rd step is a checkpoint
    const hasCheckpoint = doc.body.steps.some((s) => s.checkpoint === true);
    expect(hasCheckpoint).toBe(true);
  });

  it("builds a Fully_Automated SOP without human owners", () => {
    const doc = buildSOPDocument({
      sop_title: "Data Sync",
      target_department: "Engineering",
      execution_classification: "Fully_Automated",
      core_objective: "Sync data daily",
      required_tools_or_skills: ["CRM API"],
      raw_procedural_steps: "1. Fetch records\n2. Transform\n3. Load",
    });

    expect(doc.frontmatter.execution_classification).toBe("Fully_Automated");
    // Fully_Automated: no human owners
    const hasHumanOwner = doc.body.steps.some((s) => s.owner === "Human operator");
    expect(hasHumanOwner).toBe(false);
    // Tools should be referenced
    const hasTools = doc.body.steps.some((s) => s.tools && s.tools.length > 0);
    expect(hasTools).toBe(true);
  });

  it("builds a Hybrid classification SOP", () => {
    const doc = buildSOPDocument({
      sop_title: "Release Process",
      target_department: "Engineering",
      execution_classification: "Hybrid",
      core_objective: "Release software",
      required_tools_or_skills: ["GitHub", "CI/CD"],
      raw_procedural_steps: "1. Create branch\n2. Run tests\n3. Deploy",
    });

    expect(doc.frontmatter.execution_classification).toBe("Hybrid");
  });
});

describe("serializeSOP", () => {
  it("produces valid OKF markdown with frontmatter", () => {
    const doc = buildSOPDocument({
      sop_title: "Test SOP",
      target_department: "GTM-playbook",
      execution_classification: "Manual",
      core_objective: "Test",
      required_tools_or_skills: ["Slack"],
      raw_procedural_steps: "1. Do step one\n2. Do step two",
    });

    const md = serializeSOP(doc);
    expect(md.startsWith("---")).toBe(true);
    expect(md).toContain("title: \"Test SOP\"");
    expect(md).toContain("department: \"GTM-playbook\"");
    expect(md).toContain("execution_classification: Manual");
    expect(md).toContain("status: draft");
    expect(md).toContain("## Procedural Steps");
    expect(md).toContain("### Step 1");
    expect(md).toContain("### Step 2");
  });
});
