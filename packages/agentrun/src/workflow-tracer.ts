/**
 * Thin wrapper around the `workflow-tracer` Python script (stdlib only).
 *
 * The tracer records a cold walk of an ICM workspace. The actual walk is performed
 * by an agent (or a cold subagent) issuing `tree`/`read`/`scan`/`miss`/`done`
 * commands; this module locates the script, shells out to it, and reads back the
 * resulting `trace.json` so AgentRun can use the four verdicts as a pre-flight
 * check.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TracerCheck {
  name: string;
  pass: boolean;
  note: string;
}

export interface TracerResult {
  root: string;
  task: string;
  finished?: string;
  pending: boolean;
  checks: TracerCheck[];
  totals?: { reads: number; named: number; tokens: number; working: number; scans: number; misses: number; l2_at: number | null };
  htmlPath?: string;
}

export interface PreflightResult {
  passed: boolean;
  reason?: string;
  checks: TracerCheck[];
  htmlPath?: string;
}

/** Locate tracer.py, or undefined if it is not installed. */
export function resolveTracerScript(skillsDir?: string): string | undefined {
  const candidates: string[] = [];
  if (process.env.INSTINCT_SKILLS_DIR) {
    candidates.push(join(process.env.INSTINCT_SKILLS_DIR, "workflow-tracer", "scripts", "tracer.py"));
  }
  if (skillsDir) {
    candidates.push(join(skillsDir, "workflow-tracer", "scripts", "tracer.py"));
  }
  candidates.push("/app/skills/workflow-tracer/scripts/tracer.py");
  try {
    candidates.push(fileURLToPath(new URL("../../skills/workflow-tracer/scripts/tracer.py", import.meta.url)));
  } catch {
    // not a file URL; skip
  }
  return candidates.find((p) => existsSync(p));
}

/** Run a tracer subcommand. Resolves with stdout/stderr/code. */
export function runTracerCommand(
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("python3", [script, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Read trace.json from an output dir, or undefined if absent/unparseable. */
export function readTraceResult(outDir: string): TracerResult | undefined {
  try {
    const raw = readFileSync(join(outDir, "trace.json"), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const checks = Array.isArray(data.checks) ? (data.checks as TracerCheck[]) : [];
    return {
      root: String(data.root ?? ""),
      task: String(data.task ?? ""),
      finished: typeof data.finished === "string" ? data.finished : undefined,
      pending: data.pending === true,
      checks,
      totals: data.totals as TracerResult["totals"],
      htmlPath: existsSync(join(outDir, "trace.html")) ? join(outDir, "trace.html") : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Pre-flight check: ensure a completed trace exists for `icmRoot`/`task` and that
 * all four verdicts pass. If the trace is missing/pending, the run is not allowed
 * to proceed; the caller must run the trace first.
 */
export async function runPreflight(
  icmRoot: string,
  task: string,
  outDir: string,
  skillsDir?: string,
): Promise<PreflightResult> {
  const script = resolveTracerScript(skillsDir);
  if (!script) {
    return { passed: false, reason: "workflow-tracer script not found", checks: [] };
  }
  // Ensure the tree is scanned (idempotent).
  await runTracerCommand(script, ["tree", icmRoot, "-d", outDir]);

  const result = readTraceResult(outDir);
  if (!result) {
    return { passed: false, reason: "no trace result found (run the trace first)", checks: [] };
  }
  if (result.pending) {
    return { passed: false, reason: "trace is still pending (finish with `done`)", checks: result.checks };
  }
  const failed = result.checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    return {
      passed: false,
      reason: `preflight_failed: ${failed.map((c) => c.name).join(", ")}`,
      checks: result.checks,
      htmlPath: result.htmlPath,
    };
  }
  return { passed: true, checks: result.checks, htmlPath: result.htmlPath };
}