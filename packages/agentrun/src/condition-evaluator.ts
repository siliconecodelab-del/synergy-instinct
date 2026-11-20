/**
 * Condition evaluator for scheduled cron entries.
 *
 * Condition expressions are simple boolean predicates evaluated before a cron
 * fires. If the condition returns false, the cron is skipped for that cycle
 * (nextRunAt still advances, so it will try again on the next schedule).
 *
 * Supported expressions:
 *   always                          -> always true
 *   pending_approvals_older_than(4h) > 0   -> count of pending approvals older than the duration
 *   pending_approvals_older_than(4h) == 0  -> inverse
 *   unconnected_tools_in_sop("sop-title") > 0   -> count of required tools not connected for an SOP
 *   sop_last_modified_days_ago("sop-title") > 30 -> days since SOP was last modified
 *   pipeline_overdue("pipeline-name") == true   -> pipeline schedule is past due
 *   pipeline_overdue("pipeline-name") == false  -> inverse
 *
 * Duration syntax: 4h, 30m, 7d, 1w
 */
import { StateDir, ApprovalStore, AuditLog } from "@open-instinct/core";
import { PipelineStore } from "./pipeline-store.js";
import { listSOPs } from "./sop-generator.js";
import { parseSOP } from "./sop-okf.js";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface ConditionEvaluatorDeps {
  stateDir: StateDir;
  pipelineStore: PipelineStore;
  approvalStore: ApprovalStore;
  auditLog: AuditLog;
}

/** Parse a duration like "4h", "30m", "7d", "1w" into milliseconds. */
function parseDurationMs(s: string): number {
  const m = /^(\d+)(m|h|d|w)$/.exec(s.trim());
  if (!m) throw new Error(`condition: invalid duration "${s}"`);
  const n = Number(m[1]!);
  switch (m[2]!) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    default: throw new Error(`condition: invalid duration unit "${m[2]}"`);
  }
}

/** Evaluate a condition expression against current state. Returns true if the cron should fire. */
export async function evaluateCondition(
  expr: string,
  deps: ConditionEvaluatorDeps,
): Promise<boolean> {
  const e = expr.trim();
  if (e === "always" || e === "true") return true;
  if (e === "never" || e === "false") return false;

  // pending_approvals_older_than(4h) > 0  (or == 0, < 1, etc.)
  const m1 = /^pending_approvals_older_than\(([^)]+)\)\s*(>=|>|<=|<|==|!=)\s*(\d+)$/.exec(e);
  if (m1) {
    const durationMs = parseDurationMs(m1[1]!);
    const cutoff = Date.now() - durationMs;
    const pending = deps.approvalStore.pending();
    const count = pending.filter((a) => Date.parse(a.createdAt) <= cutoff).length;
    return compare(count, m1[2]!, Number(m1[3]!));
  }

  // unconnected_tools_in_sop("sop-title") > 0
  const m2 = /^unconnected_tools_in_sop\("([^"]+)"\)\s*(>=|>|<=|<|==|!=)\s*(\d+)$/.exec(e);
  if (m2) {
    const sopTitle = m2[1]!;
    const count = countUnconnectedToolsInSop(deps.stateDir, sopTitle);
    return compare(count, m2[2]!, Number(m2[3]!));
  }

  // sop_last_modified_days_ago("sop-title") > 30
  const m3 = /^sop_last_modified_days_ago\("([^"]+)"\)\s*(>=|>|<=|<|==|!=)\s*(\d+)$/.exec(e);
  if (m3) {
    const sopTitle = m3[1]!;
    const days = daysSinceSopModified(deps.stateDir, sopTitle);
    return compare(days, m3[2]!, Number(m3[3]!));
  }

  // pipeline_overdue("name") == true  (or == false)
  const m4 = /^pipeline_overdue\("([^"]+)"\)\s*==\s*(true|false)$/.exec(e);
  if (m4) {
    const pipelineName = m4[1]!;
    const expected = m4[2]! === "true";
    const pipeline = deps.pipelineStore.bySop(pipelineName) ?? deps.pipelineStore.list().find((p) => p.sop === pipelineName);
    if (!pipeline) return !expected; // no pipeline -> not overdue
    const isOverdue = isPipelineOverdue(pipeline);
    return isOverdue === expected;
  }

  throw new Error(`condition: unknown expression "${expr}"`);
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return false;
  }
}

function countUnconnectedToolsInSop(stateDir: StateDir, sopTitle: string): number {
  const sops = listSOPs(stateDir);
  const rel = sops.find((r: string) => {
    try {
      const content = readFileSync(join(stateDir.path("Company-brain", "SOPs", r)), "utf8");
      const doc = parseSOP(content);
      return doc?.frontmatter.title === sopTitle;
    } catch {
      return false;
    }
  });
  if (!rel) return 0;
  try {
    const content = readFileSync(join(stateDir.path("Company-brain", "SOPs", rel)), "utf8");
    const doc = parseSOP(content);
    if (!doc) return 0;
    const required = doc.frontmatter.required_tools_or_skills ?? [];
    return required.length; // conservative: count all required as potentially unconnected
  } catch {
    return 0;
  }
}

function daysSinceSopModified(stateDir: StateDir, sopTitle: string): number {
  const sops = listSOPs(stateDir);
  const rel = sops.find((r: string) => {
    try {
      const content = readFileSync(join(stateDir.path("Company-brain", "SOPs", r)), "utf8");
      const doc = parseSOP(content);
      return doc?.frontmatter.title === sopTitle;
    } catch {
      return false;
    }
  });
  if (!rel) return 999; // SOP not found -> treat as very old
  try {
    const fullPath = join(stateDir.path("Company-brain", "SOPs", rel));
    if (!existsSync(fullPath)) return 999;
    const stat = statSync(fullPath);
    const days = (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
    return Math.floor(days);
  } catch {
    return 999;
  }
}

function isPipelineOverdue(pipeline: { schedule?: { cron: string; tz?: string } | null; lastRun?: string | null }): boolean {
  if (!pipeline.schedule) return false;
  if (!pipeline.lastRun) return true; // never run -> overdue
  const lastRun = new Date(pipeline.lastRun).getTime();
  const now = Date.now();
  // Simple heuristic: if more than 2 days since last run for a scheduled pipeline
  return now - lastRun > 2 * 24 * 60 * 60 * 1000;
}
