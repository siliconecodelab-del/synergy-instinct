/**
 * SOP Content Optimizer: analyzes a user's SOP execution history and suggests
 * improvements to step descriptions, checkpoint definitions, tool mappings,
 * and role map. Uses telemetry data to detect friction, errors, and
 * graduation candidates. All changes require HITL approval before applying.
 *
 * Decision engine classifies each signal as:
 *   - SOP_CONTENT: step descriptions, checkpoints, tool mappings (owner approves)
 *   - AGENT_PROMPT: tool descriptions, nudge templates (platform team approves)
 *   - BOTH: when both SOP and prompt contribute to the issue
 *   - NONE: no significant signal
 *
 * Risk assessment:
 *   - SOP_CONTENT: MEDIUM risk (affects user's business process)
 *   - AGENT_PROMPT: HIGH risk (affects all users' agent behavior)
 *   - BOTH: HIGH risk
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";


import { readTelemetry, type TelemetryEntry } from "@open-instinct/core";
import { parseSOP, buildSOPRoleMap, type SOPDocument } from "./sop-okf.js";
import { resolveSOPPath } from "./sop-generator.js";
import { kebabCase } from "./sop-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OptimizationTarget = "SOP_CONTENT" | "AGENT_PROMPT" | "BOTH" | "NONE";

export interface StepMetrics {
  step: number;
  description: string;
  owner: string | undefined;
  checkpoint: boolean;
  tools: string[];
  executionCount: number;
  errorCount: number;
  errorRate: number;
  editRate: number; // human edits at checkpoint / executions
  skipRate: number; // times step was skipped / executions
  avgDurationMs: number;
}

export interface OptimizationSignal {
  target: "agent_prompt" | "sop_content" | "execution_mode";
  capability: string;
  metric: string;
  value: number;
  threshold: number;
  confidence: number; // 0-1
  description: string;
  suggestion: string;
}

export interface OptimizationProposal {
  sopTitle: string;
  targetDepartment: string;
  analysisWindowDays: number;
  totalExecutions: number;
  stepMetrics: StepMetrics[];
  signals: OptimizationSignal[];
  suggestions: OptimizationSuggestion[];
  graduationCandidate: boolean;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  approver: "owner" | "platform_team" | "auto";
}

export interface OptimizationSuggestion {
  type: "rewrite_step" | "remove_step" | "remove_checkpoint" | "graduate" | "fix_tool_mapping" | "rewrite_tool_description" | "connect_tool" | "add_checkpoint";
  target: "agent_prompt" | "sop_content" | "execution_mode";
  capability: string;
  step?: number;
  current: string;
  suggested: string;
  confidence: number;
  reason: string;
  autoApply: boolean;
}

export interface OptimizationOutcome {
  proposalId: string;
  sopTitle: string;
  targetDepartment: string;
  appliedAt: string;
  changes: string[];
  metricsBefore: Record<string, number>;
  metricsAfter: Record<string, number> | null;
  improvement: number | null;
}

export interface SOPVersion {
  version: number;
  timestamp: string;
  content: string;
  changes: string[];
  proposalId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  STEP_EDIT_RATE: 0.5,       // >50% edits → suggest rewrite
  STEP_SKIP_RATE: 0.3,       // >30% skips → suggest removal
  TOOL_ERROR_RATE: 0.2,      // >20% errors → fix tool mapping
  CHECKPOINT_UNEDITED: 5,    // 5+ unedited approvals → graduation candidate
  CHECKPOINT_ALWAYS_EDITED: 0.8, // >80% edits → suggest removing checkpoint
  TOOL_SELECTION_ACCURACY: 0.8,  // <80% → agent prompt issue
  MIN_EXECUTIONS: 3,         // Need at least 3 executions for meaningful analysis
};

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function analyzeSOP(
  doc: SOPDocument,
  telemetry: TelemetryEntry[],
  windowDays: number = 30,
): OptimizationProposal {
  const frontmatter = doc.frontmatter;
  const steps = [...(doc.body.steps ?? [])].sort((a, b) => a.step - b.step);

  // Filter telemetry to this SOP
  const sopKey = `${kebabCase(frontmatter.department)}/${kebabCase(frontmatter.title)}`;
  const sopTelemetry = telemetry.filter((e) => {
    const input = e.input as Record<string, unknown> | null;
    const tool = e.tool ?? "";
    // Match by SOP title in input or by tool calls related to this SOP
    if (input?.sop_title === frontmatter.title) return true;
    if (input?.sopTitle === frontmatter.title) return true;
    if (tool && (tool.includes("sop") || tool.includes("pipeline"))) {
      // Check if the conversation is about this SOP
      return true;
    }
    return false;
  });

  const totalExecutions = new Set(sopTelemetry.map((e) => e.conversationKey)).size;
  const effectiveExecutions = Math.max(totalExecutions, 1);

  // Calculate per-step metrics
  const stepMetrics: StepMetrics[] = steps.map((s) => {
    const stepTools = s.tools ?? [];
    const stepTelemetry = sopTelemetry.filter((e) => {
      const input = e.input as Record<string, unknown> | null;
      if (input?.step === s.step) return true;
      // Match by tool name
      if (stepTools.length > 0 && stepTools.includes(e.tool ?? "")) return true;
      return false;
    });

    const errorCount = stepTelemetry.filter((e) => e.outcome === "error").length;
    const executionCount = Math.max(stepTelemetry.length, 1);

    // Estimate edit rate from approvals (if available)
    const editRate = 0; // Will be enriched from approvals data
    const skipRate = stepTelemetry.length === 0 ? 1.0 : 0; // If no telemetry, step was skipped

    const durations = stepTelemetry
      .map((e) => e.durationMs)
      .filter((d): d is number => d !== null);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return {
      step: s.step,
      description: s.description,
      owner: s.owner,
      checkpoint: s.checkpoint ?? false,
      tools: stepTools,
      executionCount: stepTelemetry.length,
      errorCount,
      errorRate: errorCount / executionCount,
      editRate,
      skipRate,
      avgDurationMs: avgDuration,
    };
  });

  // Generate signals
  const signals: OptimizationSignal[] = [];

  // Check for high edit rate on checkpoint steps
  for (const sm of stepMetrics) {
    if (sm.checkpoint && sm.editRate > THRESHOLDS.STEP_EDIT_RATE) {
      signals.push({
        target: "sop_content",
        capability: "step.edit",
        metric: "step_edit_rate",
        value: sm.editRate,
        threshold: THRESHOLDS.STEP_EDIT_RATE,
        confidence: Math.min(0.95, sm.editRate + 0.1),
        description: `Step ${sm.step} checkpoint edited ${Math.round(sm.editRate * 100)}% of the time`,
        suggestion: `Rewrite Step ${sm.step} description to better match human expectations`,
      });
    }
  }

  // Check for skipped steps
  for (const sm of stepMetrics) {
    if (sm.skipRate > THRESHOLDS.STEP_SKIP_RATE && sm.executionCount > 0) {
      signals.push({
        target: "sop_content",
        capability: "step.skip",
        metric: "step_skip_rate",
        value: sm.skipRate,
        threshold: THRESHOLDS.STEP_SKIP_RATE,
        confidence: Math.min(0.9, sm.skipRate),
        description: `Step ${sm.step} was skipped in ${Math.round(sm.skipRate * 100)}% of executions`,
        suggestion: `Step ${sm.step} may be redundant — consider removing or making optional`,
      });
    }
  }

  // Check for tool errors
  for (const sm of stepMetrics) {
    if (sm.errorRate > THRESHOLDS.TOOL_ERROR_RATE && sm.executionCount >= THRESHOLDS.MIN_EXECUTIONS) {
      signals.push({
        target: "sop_content",
        capability: "tool.error",
        metric: "tool_error_rate",
        value: sm.errorRate,
        threshold: THRESHOLDS.TOOL_ERROR_RATE,
        confidence: Math.min(0.95, sm.errorRate + 0.2),
        description: `Step ${sm.step} tools failed ${Math.round(sm.errorRate * 100)}% of the time`,
        suggestion: `Fix tool mapping or connection for Step ${sm.step} tools: ${sm.tools.join(", ")}`,
      });
    }
  }

  // Check for disconnected tools
  const tools = frontmatter.required_tools_or_skills ?? [];
  const toolStatus = frontmatter.required_tools_status ?? {};
  for (const tool of tools) {
    if (toolStatus[tool] === "not_connected" || toolStatus[tool] === "not_configured") {
      signals.push({
        target: "sop_content",
        capability: "tool.disconnected",
        metric: "tool_disconnected",
        value: 1.0,
        threshold: 0.0,
        confidence: 1.0,
        description: `Tool "${tool}" is ${toolStatus[tool]?.replace(/_/g, " ") ?? "not connected"}`,
        suggestion: `Connect ${tool} or find an alternative`,
      });
    }
  }

  // Check graduation candidate
  const checkpointSteps = steps.filter((s) => s.checkpoint);
  const graduationCandidate = checkpointSteps.length > 0 && effectiveExecutions >= THRESHOLDS.CHECKPOINT_UNEDITED;

  if (graduationCandidate) {
    signals.push({
      target: "sop_content",
      capability: "graduation",
      metric: "graduation_candidate",
      value: effectiveExecutions,
      threshold: THRESHOLDS.CHECKPOINT_UNEDITED,
      confidence: 0.8,
      description: `SOP has been executed ${effectiveExecutions} times with checkpoint approvals`,
      suggestion: `Consider graduating from ${frontmatter.execution_classification} to Fully_Automated`,
    });
  }

  // Generate suggestions
  const suggestions: OptimizationSuggestion[] = [];

  for (const signal of signals) {
    if (signal.metric === "step_edit_rate") {
      const sm = stepMetrics.find((m) => m.step === parseInt(signal.description.match(/Step (\d+)/)?.[1] ?? "0"));
      if (sm) {
        suggestions.push({
          type: "rewrite_step",
          target: "sop_content",
          capability: "step.edit",
          step: sm.step,
          current: sm.description,
          suggested: `[Optimized] ${sm.description} (add specific tool parameters, expected output format, and error handling)`,
          confidence: signal.confidence,
          reason: signal.description,
          autoApply: false,
        });
      }
    }

    if (signal.metric === "step_skip_rate") {
      const sm = stepMetrics.find((m) => m.step === parseInt(signal.description.match(/Step (\d+)/)?.[1] ?? "0"));
      if (sm) {
        suggestions.push({
          type: "remove_step",
          target: "sop_content",
          capability: "step.skip",
          step: sm.step,
          current: sm.description,
          suggested: "[Remove this step — it is skipped in most executions]",
          confidence: signal.confidence,
          reason: signal.description,
          autoApply: false,
        });
      }
    }

    if (signal.metric === "tool_error_rate") {
      const sm = stepMetrics.find((m) => m.step === parseInt(signal.description.match(/Step (\d+)/)?.[1] ?? "0"));
      if (sm) {
        suggestions.push({
          type: "fix_tool_mapping",
          target: "sop_content",
          capability: "tool.error",
          step: sm.step,
          current: sm.tools.join(", ") || "none",
          suggested: `[Fix: verify tool connections for ${sm.tools.join(", ") || "none"}]`,
          confidence: signal.confidence,
          reason: signal.description,
          autoApply: false,
        });
      }
    }

    if (signal.metric === "tool_disconnected") {
      const tool = signal.description.match(/"([^"]+)"/)?.[1] ?? "";
      suggestions.push({
        type: "connect_tool",
        target: "sop_content",
        capability: "tool.disconnected",
        current: `${tool} (${toolStatus[tool]?.replace(/_/g, " ") ?? "not connected"})`,
        suggested: `Connect ${tool} or find an alternative`,
        confidence: 1.0,
        reason: signal.description,
        autoApply: false,
      });
    }

    if (signal.metric === "graduation_candidate") {
      suggestions.push({
        type: "graduate",
        target: "sop_content",
          capability: "graduation",
          current: frontmatter.execution_classification,
        suggested: "Fully_Automated",
        confidence: 0.8,
        reason: signal.description,
        autoApply: false,
      });
    }
  }

  // Determine risk level
  const hasSOPChanges = suggestions.some((s) => s.target === "sop_content");
  const hasPromptChanges = suggestions.some((s) => s.target === "agent_prompt");
  const riskLevel: "low" | "medium" | "high" =
    hasPromptChanges ? "high" : hasSOPChanges ? "medium" : "low";

  const requiresApproval = hasSOPChanges || hasPromptChanges;
  const approver: "owner" | "platform_team" | "auto" =
    hasPromptChanges ? "platform_team" : hasSOPChanges ? "owner" : "auto";

  return {
    sopTitle: frontmatter.title,
    targetDepartment: frontmatter.department,
    analysisWindowDays: windowDays,
    totalExecutions: effectiveExecutions,
    stepMetrics,
    signals,
    suggestions,
    graduationCandidate,
    riskLevel,
    requiresApproval,
    approver,
  };
}

// ---------------------------------------------------------------------------
// Outcome tracking
// ---------------------------------------------------------------------------

const VERSIONS_DIR = "sop-versions";

export function versionDir(stateDir: StateDir, sopTitle: string, department: string): string {
  const slug = kebabCase(`${department}-${sopTitle}`);
  return stateDir.path("eval", VERSIONS_DIR, slug);
}

export function saveVersion(
  stateDir: StateDir,
  sopTitle: string,
  department: string,
  content: string,
  changes: string[],
  proposalId: string | null,
): SOPVersion {
  const dir = versionDir(stateDir, sopTitle, department);
  mkdirSync(dir, { recursive: true });

  // Determine next version number
  let version = 1;
  const existing = listVersions(stateDir, sopTitle, department);
  if (existing.length > 0) {
    version = Math.max(...existing.map((v) => v.version)) + 1;
  }

  const sopVersion: SOPVersion = {
    version,
    timestamp: new Date().toISOString(),
    content,
    changes,
    proposalId,
  };

  const filePath = join(dir, `v${version}.json`);
  writeFileSync(filePath, JSON.stringify(sopVersion, null, 2) + "\n", { mode: 0o600 });

  return sopVersion;
}

export function listVersions(
  stateDir: StateDir,
  sopTitle: string,
  department: string,
): SOPVersion[] {
  const dir = versionDir(stateDir, sopTitle, department);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.startsWith("v") && f.endsWith(".json"));
  const versions: SOPVersion[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      versions.push(JSON.parse(content) as SOPVersion);
    } catch {
      // Skip malformed
    }
  }
  return versions.sort((a, b) => a.version - b.version);
}

export function saveOutcome(
  stateDir: StateDir,
  sopTitle: string,
  department: string,
  outcome: OptimizationOutcome,
): void {
  const dir = versionDir(stateDir, sopTitle, department);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `outcome-${outcome.proposalId}.json`);
  writeFileSync(filePath, JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
}

export function loadOutcomes(
  stateDir: StateDir,
  sopTitle: string,
  department: string,
): OptimizationOutcome[] {
  const dir = versionDir(stateDir, sopTitle, department);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.startsWith("outcome-") && f.endsWith(".json"));
  const outcomes: OptimizationOutcome[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      outcomes.push(JSON.parse(content) as OptimizationOutcome);
    } catch {
      // Skip malformed
    }
  }
  return outcomes.sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
}

// ---------------------------------------------------------------------------
// HITL approval integration
// ---------------------------------------------------------------------------

export function createApprovalRequest(
  stateDir: StateDir,
  proposal: OptimizationProposal,
  approvalId: string,
): {
  id: string;
  conversationKey: string;
  requestedBy: string;
  summary: string;
  capability: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  status: string;
} {
  const now = new Date();
  const expires = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours

  const suggestionsSummary = proposal.suggestions
    .map((s) => `${s.type}: ${s.reason}`)
    .join("; ");

  return {
    id: approvalId,
    conversationKey: `sop-optimize:${kebabCase(proposal.targetDepartment)}:${kebabCase(proposal.sopTitle)}`,
    requestedBy: "owner",
    summary: `SOP optimization for "${proposal.sopTitle}": ${suggestionsSummary}`,
    capability: "owner.relay",
    token: Math.random().toString(36).slice(2, 6).toUpperCase(),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    status: "pending",
  };
}
