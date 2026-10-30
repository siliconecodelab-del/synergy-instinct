/**
 * Preset loading for pipelines (Phase 2).
 * Presets live under <state>/Company-brain/presets/<name>.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";

export interface PipelinePreset {
  name: string;
  department: string;
  classification: "Manual" | "Hybrid" | "Fully_Automated";
  tools: string[];
  steps: string;
}

function dir(state: StateDir): string {
  const d = state.path("Company-brain", "presets");
  mkdirSync(d, { recursive: true });
  return d;
}

function safeName(name: string): string | undefined {
  const v = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return v || undefined;
}

export function listPresets(state: StateDir): PipelinePreset[] {
  const d = dir(state);
  let entries: string[] = [];
  try { entries = readdirSync(d).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: PipelinePreset[] = [];
  for (const name of entries) {
    try {
      const p = JSON.parse(readFileSync(join(d, name), "utf8")) as PipelinePreset;
      if (p && p.name) out.push(p);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadPreset(state: StateDir, name: string): PipelinePreset | undefined {
  const key = safeName(name);
  if (!key) return undefined;
  const f = join(dir(state), `${key}.json`);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, "utf8")) as PipelinePreset; } catch { return undefined; }
}

export function savePreset(state: StateDir, preset: PipelinePreset): PipelinePreset {
  const key = safeName(preset.name);
  if (!key) throw new Error("preset name is required");
  const next = { ...preset, name: preset.name.trim() };
  writeFileSync(join(dir(state), `${key}.json`), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function deletePreset(state: StateDir, name: string): boolean {
  const key = safeName(name);
  if (!key) return false;
  const f = join(dir(state), `${key}.json`);
  if (!existsSync(f)) return false;
  try { unlinkSync(f); return true; } catch { return false; }
}