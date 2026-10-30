/**
 * Code-level quiet-hour enforcement and nudge deduplication.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";

export interface NudgeState {
  lastNudgeAt: string | null;
}

export function readNudgeState(state: StateDir): NudgeState {
  const f = state.path("agentrun", "nudge-state.json");
  if (!existsSync(f)) return { lastNudgeAt: null };
  try {
    return JSON.parse(readFileSync(f, "utf8")) as NudgeState;
  } catch {
    return { lastNudgeAt: null };
  }
}

export function writeNudgeState(state: StateDir, s: NudgeState): void {
  const dir = state.path("agentrun");
  mkdirSync(dir, { recursive: true });
  writeFileSync(state.path("agentrun", "nudge-state.json"), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

export interface NudgeCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Returns whether a nudge may be sent now.
 * - At most one nudge per calendar day.
 * - No nudges during quiet hours (default 22:00-07:00).
 */
export function canNudge(now: Date = new Date(), lastNudgeAt: string | null = null, quietStart = 22, quietEnd = 7): NudgeCheck {
  const hour = now.getHours();
  const inQuiet = quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)
    : (hour >= quietStart && hour < quietEnd);
  if (inQuiet) return { allowed: false, reason: "quiet hours" };

  if (lastNudgeAt) {
    const last = new Date(lastNudgeAt);
    const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
    if (sameDay) return { allowed: false, reason: "already nudged today" };
  }
  return { allowed: true };
}