import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDir } from "@open-instinct/core";
import {
  buildSOPArchifySpec,
  renderSOPVisualArtifact,
  summarizeRoleMapArtifact,
  resolveArchifyCli,
  resolveChrome,
  resolveFfmpeg,
} from "../src/sop-visualizer.js";
import { readSOPVisualPrefs, writeSOPVisualPrefs } from "../src/sop-visual-prefs.js";
import { buildSOPDocument, type SOPDocument } from "../src/sop-okf.js";
import { writeSOP, resolveSOPPath } from "../src/sop-generator.js";
import { sopVisualizeRoleMapTool } from "../src/tool.js";

function tempStateDir(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "sop-viz-test-"));
  const state = new StateDir(root);
  state.ensure();
  return state;
}

function cleanup(dir: StateDir): void {
  rmSync(dir.root, { recursive: true, force: true });
}

function hybridDoc(): SOPDocument {
  return buildSOPDocument({
    sop_title: "Lead Follow Up",
    target_department: "GTM-playbook",
    execution_classification: "Hybrid",
    core_objective: "Respond to inbound leads fast without losing the owner's voice.",
    required_tools_or_skills: ["Gmail", "HubSpot"],
    raw_procedural_steps:
      "1. Pull new lead from inbox\n2. Draft a tailored reply\n3. Owner reviews and approves the draft\n4. Send and log to CRM",
  });
}

describe("buildSOPArchifySpec", () => {
  it("emits a Schema v2 workflow spec with You / Agent / Tools lanes", () => {
    const spec = buildSOPArchifySpec(hybridDoc());

    expect(spec.schema_version).toBe(2);
    expect(spec.diagram_type).toBe("workflow");
    expect(spec.meta.visual_preset).toBe("signal-flow");
    expect(spec.meta.quality_profile).toBe("showcase");
    expect(spec.meta.animation).toBe("trace");
    expect(spec.meta.output).toMatch(/^apps\/sop-lead-follow-up\/index\.html$/);
    expect(spec.lanes.map((l) => l.id)).toEqual(["you", "agent", "tools"]);
    expect(spec.mainPath.length).toBeGreaterThan(2);
    expect(spec.cards?.map((c) => c.title)).toEqual([
      "Where You Fit",
      "Where the Agent Fits",
      "Tools & Owner Summary",
    ]);
  });

  it("holds checkpoint steps in the human lane and the rest in the agent lane (Hybrid)", () => {
    const spec = buildSOPArchifySpec(hybridDoc());
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));

    // Step 3 is the review checkpoint: it must sit in the `you` lane as a security node.
    const checkpoint = byId.get("step3");
    expect(checkpoint?.lane).toBe("you");
    expect(checkpoint?.type).toBe("security");

    // A non-checkpoint step runs in the agent lane.
    const draft = byId.get("step2");
    expect(draft?.lane).toBe("agent");

    // Required tools land in their own lane.
    const toolNodes = spec.nodes.filter((n) => n.lane === "tools");
    expect(toolNodes.map((n) => n.label).sort()).toEqual(["Gmail", "HubSpot"]);
    expect(new Set(toolNodes.map((n) => n.col)).size).toBe(toolNodes.length);
  });

  it("keeps every node on a unique lane/col cell and every edge resolvable", () => {
    const spec = buildSOPArchifySpec(hybridDoc());
    const cells = new Set<string>();
    for (const n of spec.nodes) {
      const cell = `${n.lane}\0${n.col}`;
      expect(cells.has(cell)).toBe(false);
      cells.add(cell);
      expect(spec.lanes.some((l) => l.id === n.lane)).toBe(true);
    }
    const ids = new Set(spec.nodes.map((n) => n.id));
    for (const e of spec.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    for (const id of spec.mainPath) expect(ids.has(id)).toBe(true);
  });

  it("lays out Manual SOPs with the human as executor and agent as support", () => {
    const doc = buildSOPDocument({
      sop_title: "Weekly Reconcile",
      target_department: "Finance",
      execution_classification: "Manual",
      core_objective: "Reconcile accounts weekly.",
      required_tools_or_skills: ["QuickBooks"],
      raw_procedural_steps: "1. Export statements\n2. Match transactions\n3. Sign off",
    });
    const spec = buildSOPArchifySpec(doc);
    const steps = spec.nodes.filter((n) => n.tag?.startsWith("Step"));
    expect(steps.every((n) => n.lane === "you")).toBe(true);
    expect(spec.nodes.some((n) => n.id === "cue")).toBe(true);
    expect(spec.nodes.some((n) => n.id === "scribe")).toBe(true);
    expect(spec.lanes.find((l) => l.id === "agent")).toBeTruthy();
  });

  it("lays out Fully_Automated SOPs with the agent end-to-end and a human exception branch", () => {
    const doc = buildSOPDocument({
      sop_title: "Nightly Backups",
      target_department: "Engineering-and-Dev",
      execution_classification: "Fully_Automated",
      core_objective: "Keep backups fresh without human involvement.",
      required_tools_or_skills: ["S3"],
      raw_procedural_steps: "1. Snapshot database\n2. Upload to cold storage\n3. Verify checksum",
    });
    const spec = buildSOPArchifySpec(doc);
    const steps = spec.nodes.filter((n) => n.tag?.startsWith("Step"));
    expect(steps.every((n) => n.lane === "agent")).toBe(true);

    const exception = spec.nodes.find((n) => n.id === "exception");
    expect(exception?.lane).toBe("you");
    expect(exception?.type).toBe("security");
    const escalation = spec.edges.find((e) => e.to === "exception");
    expect(escalation?.role).toBe("error");
    expect(spec.lanes[0]?.variant).toBe("exception");
  });

  it("passes archify's own workflow validator when the CLI is available", async () => {
    const cli = resolveArchifyCli();
    if (!cli) {
      expect(true).toBe(true); // vendored CLI absent (e.g. slim checkout) — covered elsewhere
      return;
    }
    const dir = tempStateDir();
    try {
      const specPath = join(dir.root, "candidate.json");
      writeFileSync(specPath, JSON.stringify(buildSOPArchifySpec(hybridDoc()), null, 2));
      const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(
          process.execPath,
          [cli, "validate", "workflow", specPath, "--json"],
          { encoding: "utf8", timeout: 60_000 },
          (err, stdout) => resolve({ code: err ? 1 : 0, stdout }),
        );
      });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { ok?: boolean; gates?: Record<string, string> };
      expect(report.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  }, 90_000);
});

describe("renderSOPVisualArtifact", () => {
  it("always writes the candidate spec and a standalone frame page", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "web",
        tools: { archifyBin: null, chromeBin: null, ffmpegBin: null },
      });

      expect(existsSync(artifact.specPath)).toBe(true);
      expect(artifact.specWorkspacePath).toBe("sop-maps/lead-follow-up.candidate.json");
      expect(artifact.html?.workspacePath).toBe("apps/sop-lead-follow-up/index.html");
      expect(artifact.html?.renderer).toBe("fallback");
      const html = readFileSync(artifact.html!.absolutePath, "utf8");
      expect(html).toContain("Role Map");
      expect(html).toContain("Where You Fit");
      // Frame mode is what Chrome screenshots for the GIF.
      expect(html).toContain("frame=");
    } finally {
      cleanup(state);
    }
  });

  it("degrades gracefully when Chrome and FFmpeg are unavailable", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "all",
        tools: { archifyBin: null, chromeBin: null, ffmpegBin: null },
      });
      expect(artifact.gif).toBeUndefined();
      expect(artifact.mp4).toBeUndefined();
      expect(artifact.html).toBeTruthy();
      expect(artifact.pdf).toBeTruthy(); // text-only playbook still renders
      expect(artifact.warnings.join("\n")).toContain("Chrome/Chromium not found");
    } finally {
      cleanup(state);
    }
  });

  const chrome = resolveChrome();
  const ffmpeg = resolveFfmpeg();

  it.runIf(chrome && ffmpeg)(
    "renders the full pipeline: archify/fallback web, PNG frames, GIF under 10 MB, PDF",
    async () => {
      const state = tempStateDir();
      try {
        const artifact = await renderSOPVisualArtifact(hybridDoc(), state, { format: "all" });

        expect(artifact.html).toBeTruthy();
        expect(artifact.html!.renderer).toBe("archify"); // vendored CLI present in this repo
        expect(statSync(artifact.html!.absolutePath).size).toBeGreaterThan(10_000);

        expect(artifact.png).toBeTruthy();
        expect(existsSync(artifact.png!.absolutePath)).toBe(true);

        expect(artifact.gif).toBeTruthy();
        expect(artifact.gif!.bytes).toBeGreaterThan(0);
        expect(artifact.gif!.bytes).toBeLessThan(8 * 1024 * 1024); // iMessage inline limit is 10 MB
        expect(artifact.gif!.workspacePath).toBe("sop-maps/lead-follow-up.gif");

        expect(artifact.pdf).toBeTruthy();
        // The playbook must be exactly one page (image + steps + role map).
        expect(artifact.pdf!.pages).toBe(1);
        expect(artifact.pdf!.bytes).toBeGreaterThan(1000);
      } finally {
        cleanup(state);
      }
    },
    240_000,
  );
});

describe("buildSOPArchifySpec — edge cases", () => {
  it("handles an SOP with zero steps", () => {
    const doc = buildSOPDocument({
      sop_title: "Empty SOP",
      target_department: "Test",
      execution_classification: "Manual",
      core_objective: "Test edge case.",
      required_tools_or_skills: [],
      raw_procedural_steps: "",
    });
    const spec = buildSOPArchifySpec(doc);
    expect(spec.schema_version).toBe(2);
    expect(spec.nodes.length).toBeGreaterThan(0); // at least cue/scribe nodes
    expect(spec.mainPath.length).toBeGreaterThan(0);
  });

  it("handles an SOP with a single step", () => {
    const doc = buildSOPDocument({
      sop_title: "Single Step SOP",
      target_department: "Test",
      execution_classification: "Hybrid",
      core_objective: "Test single step.",
      required_tools_or_skills: ["Gmail"],
      raw_procedural_steps: "1. Do the thing",
    });
    const spec = buildSOPArchifySpec(doc);
    const steps = spec.nodes.filter((n) => n.tag?.startsWith("Step"));
    expect(steps.length).toBe(1);
    // No edges from step nodes (only one)
    const stepToStepEdges = spec.edges.filter((e) => e.from.startsWith("step") && e.to.startsWith("step"));
    expect(stepToStepEdges.length).toBe(0);
  });

  it("handles an SOP with more than 6 steps (overflow grouping)", () => {
    const doc = buildSOPDocument({
      sop_title: "Long SOP",
      target_department: "Test",
      execution_classification: "Hybrid",
      core_objective: "Test overflow.",
      required_tools_or_skills: ["Gmail", "HubSpot", "Slack", "Notion", "Jira", "Zoom", "Extra"],
      raw_procedural_steps: "1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five\n6. Step six\n7. Step seven\n8. Step eight",
    });
    const spec = buildSOPArchifySpec(doc);
    const toolNodes = spec.nodes.filter((n) => n.lane === "tools");
    // Tools should be capped at 6
    expect(toolNodes.length).toBeLessThanOrEqual(6);
    // Every tool node has unique lane/col
    const cells = new Set(toolNodes.map((n) => `${n.lane}\0${n.col}`));
    expect(cells.size).toBe(toolNodes.length);
  });

  it("places all steps in agent lane for Fully_Automated", () => {
    const doc = buildSOPDocument({
      sop_title: "Auto SOP",
      target_department: "Test",
      execution_classification: "Fully_Automated",
      core_objective: "Test auto.",
      required_tools_or_skills: [],
      raw_procedural_steps: "1. Do A\n2. Do B\n3. Do C",
    });
    const spec = buildSOPArchifySpec(doc);
    const steps = spec.nodes.filter((n) => n.tag?.startsWith("Step"));
    expect(steps.every((n) => n.lane === "agent")).toBe(true);
    expect(spec.nodes.some((n) => n.id === "exception")).toBe(true);
  });
});

describe("renderSOPVisualArtifact — graceful degradation matrix", () => {
  it("degrades when only Chrome is missing (no frames, text-only PDF)", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "all",
        tools: { archifyBin: resolveArchifyCli(), chromeBin: null, ffmpegBin: resolveFfmpeg() },
      });
      expect(artifact.gif).toBeUndefined();
      expect(artifact.mp4).toBeUndefined();
      expect(artifact.png).toBeUndefined();
      expect(artifact.pdf).toBeTruthy();
      expect(artifact.warnings.join("\n")).toContain("Chrome/Chromium not found");
    } finally {
      cleanup(state);
    }
  }, 30_000);

  it("degrades when only FFmpeg is missing (frames captured, no GIF/MP4)", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "all",
        tools: { archifyBin: resolveArchifyCli(), chromeBin: resolveChrome(), ffmpegBin: null },
      });
      expect(artifact.gif).toBeUndefined();
      expect(artifact.mp4).toBeUndefined();
      expect(artifact.png).toBeTruthy(); // frames captured
      expect(artifact.pdf).toBeTruthy();
      expect(artifact.warnings.join("\n")).toContain("FFmpeg not found");
    } finally {
      cleanup(state);
    }
  }, 60_000);

  it("falls back to built-in renderer when Archify CLI is missing", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "web",
        tools: { archifyBin: null, chromeBin: null, ffmpegBin: null },
      });
      expect(artifact.html).toBeTruthy();
      expect(artifact.html!.renderer).toBe("fallback");
      const html = readFileSync(artifact.html!.absolutePath, "utf8");
      expect(html).toContain("Role Map");
      expect(html).toContain("frame=");
    } finally {
      cleanup(state);
    }
  });

  it("PDF renders without image when Chrome is unavailable (text-only)", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "pdf",
        tools: { archifyBin: null, chromeBin: null, ffmpegBin: null },
      });
      expect(artifact.pdf).toBeTruthy();
      // Text-only PDF should still be 1 page for a 4-step SOP
      expect(artifact.pdf!.pages).toBeGreaterThanOrEqual(1);
      expect(artifact.pdf!.pages).toBeLessThanOrEqual(2);
      expect(artifact.warnings.join("\n")).toContain("PDF rendered without the map image");
    } finally {
      cleanup(state);
    }
  });
});

describe("summarizeRoleMapArtifact", () => {
  it("returns exact next tool calls for send_file and ample_deploy", async () => {
    const state = tempStateDir();
    try {
      const artifact = await renderSOPVisualArtifact(hybridDoc(), state, {
        format: "all",
        tools: { archifyBin: null, chromeBin: null, ffmpegBin: null },
      });
      const text = summarizeRoleMapArtifact(hybridDoc(), artifact);
      expect(text).toContain('send_file {"path":"sop-maps/lead-follow-up.pdf"');
      expect(text).toContain('ample_deploy {"path":"apps/sop-lead-follow-up"}');
      expect(text).toContain("sop-maps/lead-follow-up.candidate.json");
      expect(text).toContain("Notes:");
    } finally {
      cleanup(state);
    }
  });
});

describe("SOP visual prefs", () => {
  it("defaults to gif and persists owner changes", () => {
    const state = tempStateDir();
    try {
      expect(readSOPVisualPrefs(state).format).toBe("gif");
      writeSOPVisualPrefs(state, { format: "off" });
      expect(readSOPVisualPrefs(state).format).toBe("off");
      writeSOPVisualPrefs(state, { format: "pdf" });
      expect(readSOPVisualPrefs(state).format).toBe("pdf");
    } finally {
      cleanup(state);
    }
  });
});

describe("sopVisualizeRoleMapTool", () => {
  it("errors on a missing SOP", async () => {
    const state = tempStateDir();
    try {
      const tool = sopVisualizeRoleMapTool({ stateDir: state });
      const result = await tool.spec.execute(
        { sop_title: "Does Not Exist", target_department: "HR" },
        {} as any,
      );
      expect(result.isError).toBe(true);
      expect(String((result as { content: Array<{ text: string }> }).content[0]?.text)).toContain("SOP not found");
    } finally {
      cleanup(state);
    }
  });

  it("honors set_as_default and the off default", async () => {
    const state = tempStateDir();
    try {
      const tool = sopVisualizeRoleMapTool({ stateDir: state });

      const off = await tool.spec.execute({ sop_title: "X", target_department: "HR", format: "off", set_as_default: true }, {} as any);
      expect(off.isError).toBeUndefined();
      expect(readSOPVisualPrefs(state).format).toBe("off");

      const skipped = await tool.spec.execute({ sop_title: "X", target_department: "HR" }, {} as any);
      const text = (skipped as { content: Array<{ text: string }> }).content[0].text;
      expect(skipped.isError).toBeUndefined();
      expect(text).toContain("off");
      expect(text).toContain("Nothing was rendered");
    } finally {
      cleanup(state);
    }
  });

  it("renders a stored SOP and reports delivery calls", async () => {
    const state = tempStateDir();
    try {
      writeSOP(state, hybridDoc());
      const tool = sopVisualizeRoleMapTool({ stateDir: state });
      const result = await tool.spec.execute(
        { sop_title: "Lead Follow Up", target_department: "GTM-playbook", format: "web" },
        {} as any,
      );
      expect(result.isError).toBeUndefined();
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain('Role Map rendered for "Lead Follow Up" (Hybrid)');
      expect(text).toContain('ample_deploy {"path":"apps/sop-lead-follow-up"}');
      expect(existsSync(resolveSOPPath(state, "GTM-playbook", "Lead Follow Up"))).toBe(true);
    } finally {
      cleanup(state);
    }
  }, 120_000);
});
