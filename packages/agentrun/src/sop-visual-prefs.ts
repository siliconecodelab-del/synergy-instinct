/**
 * Owner preference: which visual Role Map format to auto-send after an SOP is
 * created or graduated (and whether to auto-send at all).
 * Persisted under <state>/agentrun/sop-visual-prefs.json (not in memory).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { StateDir } from "@open-instinct/core";

/** `off` turns off automatic generation/delivery; explicit `format` overrides still work. */
export type SOPVisualPrefFormat = "gif" | "mp4" | "pdf" | "web" | "all" | "off";

export interface SOPVisualPrefs {
  /** Format sent automatically after create/graduate. Default: `gif` (inline iMessage animation). */
  format: SOPVisualPrefFormat;
}

const DEFAULT: SOPVisualPrefs = { format: "gif" };

const FORMATS: SOPVisualPrefFormat[] = ["gif", "mp4", "pdf", "web", "all", "off"];

export function readSOPVisualPrefs(state: StateDir): SOPVisualPrefs {
  const f = state.path("agentrun", "sop-visual-prefs.json");
  if (!existsSync(f)) return { ...DEFAULT };
  try {
    const p = JSON.parse(readFileSync(f, "utf8")) as Partial<SOPVisualPrefs>;
    return { format: FORMATS.includes(p.format as SOPVisualPrefFormat) ? (p.format as SOPVisualPrefFormat) : DEFAULT.format };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeSOPVisualPrefs(state: StateDir, prefs: SOPVisualPrefs): SOPVisualPrefs {
  const dir = state.path("agentrun");
  mkdirSync(dir, { recursive: true });
  const next: SOPVisualPrefs = {
    format: FORMATS.includes(prefs.format) ? prefs.format : DEFAULT.format,
  };
  writeFileSync(state.path("agentrun", "sop-visual-prefs.json"), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}
