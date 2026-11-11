/**
 * Telemetry export: converts agent audit logs and conversation traces into
 * structured JSONL for consumption by the DsPy evaluation pipeline.
 *
 * Each line is a JSON object with:
 *   - timestamp, conversationKey, principal, channel
 *   - tool: name of tool called (if any)
 *   - outcome: allow/deny/ask
 *   - input: tool arguments (sanitized)
 *   - response: agent response text (truncated)
 *   - durationMs: tool execution time
 *
 * Output: <stateDir>/eval/telemetry/YYYY-MM-DD.jsonl
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "./state.js";

export interface TelemetryEntry {
  timestamp: string;
  conversationKey: string;
  principal: string;
  tier: string;
  channel: string;
  tool: string | null;
  outcome: "allow" | "deny" | "ask" | "error" | null;
  input: Record<string, unknown> | null;
  responsePreview: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface TelemetryExportOptions {
  /** Only export entries after this ISO timestamp. */
  since?: string;
  /** Maximum entries per file. */
  maxEntries?: number;
}

export function telemetryDir(state: StateDir): string {
  return state.path("eval", "telemetry");
}

export function ensureTelemetryDir(state: StateDir): string {
  const dir = telemetryDir(state);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendTelemetry(state: StateDir, entry: TelemetryEntry): void {
  const dir = ensureTelemetryDir(state);
  const date = entry.timestamp.slice(0, 10);
  const file = join(dir, `${date}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readTelemetry(state: StateDir, date?: string): TelemetryEntry[] {
  const dir = telemetryDir(state);
  if (!existsSync(dir)) return [];

  const files = date
    ? [`${date}.jsonl`]
    : readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();

  const entries: TelemetryEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as TelemetryEntry);
      } catch {
        // Skip malformed lines
      }
    }
  }
  return entries;
}

export function exportTelemetrySummary(state: StateDir, since?: string): {
  totalEntries: number;
  byTool: Record<string, number>;
  byOutcome: Record<string, number>;
  byTier: Record<string, number>;
  errorRate: number;
} {
  const entries = readTelemetry(state);
  const filtered = since ? entries.filter((e) => e.timestamp >= since) : entries;

  const byTool: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let errors = 0;

  for (const e of filtered) {
    if (e.tool) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
    if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    byTier[e.tier] = (byTier[e.tier] ?? 0) + 1;
    if (e.error) errors++;
  }

  return {
    totalEntries: filtered.length,
    byTool,
    byOutcome,
    byTier,
    errorRate: filtered.length > 0 ? errors / filtered.length : 0,
  };
}
