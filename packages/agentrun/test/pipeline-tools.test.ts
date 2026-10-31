import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { pipelineStatusTool } from "../src/tool.js";
import { pipelineScheduleTool } from "../src/tool.js";
import { icmToDslTool } from "../src/tool.js";
import { nudgeGateTool } from "../src/tool.js";

describe("pipeline tools", () => {
  const stateDir = new StateDir(join(mkdtempSync(join(tmpdir(), "ptools-")), "state"));
  stateDir.ensure();

  it("pipeline_status list returns empty initially", async () => {
    const tool = pipelineStatusTool({ stateDir });
    const res = await tool.spec.execute({ action: "list" }, {} as any);
    expect(res.content[0].text).toContain("No pipelines");
  });

  it("pipeline_status cancel marks incomplete stages", async () => {
    const { PipelineStore } = await import("../src/pipeline-store.js");
    const ps = new PipelineStore(stateDir);
    ps.save({ id: "pipe_cancel", sop: "test/sop", mode: "auto", stages: { sop: { status: "done" }, icm: { status: "pending" } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const cancelRes = await pipelineStatusTool({ stateDir }).spec.execute({ action: "cancel", id: "pipe_cancel" }, {} as any);
    expect(cancelRes.content[0].text).toContain("cancelled");

    const getRes = await pipelineStatusTool({ stateDir }).spec.execute({ action: "get", id: "pipe_cancel" }, {} as any);
    const rec = JSON.parse(getRes.content[0].text);
    expect(rec.stages.icm.status).toBe("skipped");
    expect(rec.stages.icm.reason).toBe("cancelled by owner");
  });

  it("pipeline_status retention removes old records", async () => {
    const { PipelineStore } = await import("../src/pipeline-store.js");
    const ps = new PipelineStore(stateDir);
    // Write old record directly (save() always sets updatedAt=now)
    fs.writeFileSync(ps.file("old_pipe"), JSON.stringify({
      id: "old_pipe", sop: "old/sop", mode: "auto", stages: {},
      createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
    }));

    const retRes = await pipelineStatusTool({ stateDir }).spec.execute({ action: "retention", maxAgeDays: 30 }, {} as any);
    expect(retRes.content[0].text).toContain("removed 1 pipeline");
    expect(ps.get("old_pipe")).toBeUndefined();
  });

  it("pipeline_schedule unschedule works", async () => {
    const { PipelineStore } = await import("../src/pipeline-store.js");
    const ps = new PipelineStore(stateDir);
    ps.save({ id: "pipe_unsch", sop: "test/sop", mode: "auto", stages: {}, schedule: { cron: "0 9 * * *", jobId: "job1" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const unschedRes = await pipelineScheduleTool({ stateDir }).spec.execute({ action: "unschedule", id: "pipe_unsch" }, {} as any);
    expect(unschedRes.content[0].text).toContain("unscheduled");

    const getRes = await pipelineStatusTool({ stateDir }).spec.execute({ action: "get", id: "pipe_unsch" }, {} as any);
    const rec = JSON.parse(getRes.content[0].text);
    expect(rec.schedule).toBeNull();
  });

  it("nudge_gate record then check (same day blocked)", async () => {
    const recordRes = await nudgeGateTool({ stateDir }).spec.execute({ action: "record" }, {} as any);
    expect(recordRes.content[0].text).toBe("recorded");

    // After recording, same day check should be blocked (either by dedup or quiet hours)
    const blockedRes = await nudgeGateTool({ stateDir }).spec.execute({ action: "check" }, {} as any);
    expect(blockedRes.content[0].text).toContain("blocked");
  });

  it("icm_to_dsl converts a workspace", async () => {
    const fs = require("node:fs");
    const root = join(mkdtempSync(join(tmpdir(), "icmtool-")), "icm");
    fs.mkdirSync(join(root, "stages"), { recursive: true });
    fs.writeFileSync(join(root, "AGENTS.md"), "# Entry\nRoutes to stages/triage.md.\n");
    fs.writeFileSync(join(root, "stages", "triage.md"), "# Triage\nProcess messages.\n");

    const res = await icmToDslTool({ stateDir }).spec.execute({ icmRoot: root, name: "icm-wf" }, {} as any);
    expect(res.content[0].text).toContain("converted to AgentRun DSL workflow");
    expect(res.content[0].text).toContain("stages/triage.md");
    expect(res.content[0].text).toContain("Preflight:");
  });
});