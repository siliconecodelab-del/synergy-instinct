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

export type ExecutionMode = "sop" | "icm" | "workflow_dsl" | null;

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
  /** Which execution mode was used for this tool call (null if not applicable). */
  executionMode: ExecutionMode;
  /** Task type classification for execution-mode comparison (e.g. "lead-follow-up", "weekly-reconcile"). */
  taskType: string | null;
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



export interface ExecutionModeComparison {
  taskType: string;
  modes: Record<string, {
    executions: number;
    successRate: number;
    avgDurationMs: number;
    errorRate: number;
    humanEditRate: number;
  }>;
  recommendedMode: string | null;
  confidence: number;
}

export function compareExecutionModes(state: StateDir, since?: string): ExecutionModeComparison[] {
  const entries = readTelemetry(state);
  const filtered = since ? entries.filter((e) => e.timestamp >= since) : entries;

  // Group by task type, then by execution mode
  const byTask: Record<string, Record<string, TelemetryEntry[]>> = {};
  for (const e of filtered) {
    if (!e.taskType || !e.executionMode) continue;
    if (!byTask[e.taskType]) byTask[e.taskType] = {};
    if (!byTask[e.taskType]![e.executionMode]) byTask[e.taskType]![e.executionMode] = [];
    byTask[e.taskType]![e.executionMode]!.push(e);
  }

  const comparisons: ExecutionModeComparison[] = [];
  for (const [taskType, modes] of Object.entries(byTask)) {
    const modeStats: Record<string, { executions: number; successRate: number; avgDurationMs: number; errorRate: number; humanEditRate: number }> = {};

    for (const [mode, entries] of Object.entries(modes)) {
      const total = entries.length;
      const successes = entries.filter((e) => e.outcome === "allow").length;
      const errors = entries.filter((e) => e.outcome === "error").length;
      const durations = entries.map((e) => e.durationMs).filter((d): d is number => d !== null);
      const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

      modeStats[mode] = {
        executions: total,
        successRate: total > 0 ? successes / total : 0,
        avgDurationMs: avgDuration,
        errorRate: total > 0 ? errors / total : 0,
        humanEditRate: 0, // Enriched from approvals data
      };
    }

    // Recommend the mode with highest success rate, then lowest error rate, then lowest duration
    let recommended: string | null = null;
    let bestScore = -1;
    let confidence = 0;

    for (const [mode, stats] of Object.entries(modeStats)) {
      if (stats.executions < 3) continue; // Need at least 3 executions
      const score = stats.successRate * 0.5 + (1 - stats.errorRate) * 0.3 + (stats.avgDurationMs > 0 ? 1 / (stats.avgDurationMs + 1) : 0) * 0.2;
      if (score > bestScore) {
        bestScore = score;
        recommended = mode;
        // Confidence based on number of executions and consistency
        confidence = Math.min(0.95, 0.5 + (stats.executions / 20) * 0.3 + (stats.successRate - 0.5) * 0.2);
      }
    }

    comparisons.push({
      taskType,
      modes: modeStats,
      recommendedMode: recommended,
      confidence,
    });
  }

  return comparisons;
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
