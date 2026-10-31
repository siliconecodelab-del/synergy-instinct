import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTraceResult } from "../src/workflow-tracer.js";

describe("workflow-tracer", () => {
  it("reads a passing trace.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    writeFileSync(join(dir, "trace.json"), JSON.stringify({
      root: "/tmp/ws",
      task: "triage email",
      pending: false,
      checks: [{ name: "Route", pass: true, note: "ok" }],
    }));
    const r = readTraceResult(dir);
    expect(r).toBeDefined();
    expect(r!.pending).toBe(false);
    expect(r!.checks[0].pass).toBe(true);
  });

  it("marks pending traces", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    writeFileSync(join(dir, "trace.json"), JSON.stringify({ root: "/tmp/ws", task: "t", pending: true, checks: [] }));
    const r = readTraceResult(dir);
    expect(r!.pending).toBe(true);
  });

  it("returns undefined for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    expect(readTraceResult(dir)).toBeUndefined();
  });
});