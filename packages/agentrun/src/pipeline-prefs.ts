/**
 * Owner preference: auto vs. guided pipeline mode.
 * Persisted under <state>/agentrun/pipeline-prefs.json (not in memory).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { StateDir } from "@open-instinct/core";

export type PipelineMode = "auto" | "guided";

export interface PipelinePrefs {
  mode: PipelineMode;
}

const DEFAULT: PipelinePrefs = { mode: "auto" };

export function readPipelinePrefs(state: StateDir): PipelinePrefs {
  const f = state.path("agentrun", "pipeline-prefs.json");
  if (!existsSync(f)) return { ...DEFAULT };
  try {
    const p = JSON.parse(readFileSync(f, "utf8")) as Partial<PipelinePrefs>;
    return { mode: p.mode === "guided" ? "guided" : "auto" };
  } catch {
    return { ...DEFAULT };
  }
}

export function writePipelinePrefs(state: StateDir, prefs: PipelinePrefs): PipelinePrefs {
  const dir = state.path("agentrun");
  mkdirSync(dir, { recursive: true });
  const next: PipelinePrefs = { mode: prefs.mode === "guided" ? "guided" : "auto" };
  writeFileSync(state.path("agentrun", "pipeline-prefs.json"), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}