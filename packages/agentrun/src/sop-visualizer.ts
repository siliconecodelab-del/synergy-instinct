/**
 * SOP visualizer — compiles an OKF `SOPDocument` into a Schema v2 Archify
 * `workflow` specification (the "Role Map": where the human fits vs. where the
 * agent fits within the SOP) and renders deliverable artifacts from it:
 *
 *   web  — interactive standalone HTML (Archify `finalize` when the CLI is
 *          available; otherwise the built-in zero-dependency renderer)
 *   gif  — animated inline map for iMessage (Chrome headless frame capture +
 *          FFmpeg two-pass palette, kept well under the 10 MB inline limit)
 *   mp4  — the same timeline as a compact MP4
 *   pdf  — one-page playbook with the map PNG embedded (core's PDF renderer)
 *
 * The compile step is pure and deterministic from the document. Rendering
 * degrades gracefully: a missing binary (Archify CLI, Chrome/Chromium, FFmpeg)
 * skips or downgrades the formats that need it and records a warning instead
 * of failing the whole artifact. All output lands inside the agent workspace:
 * `sop-maps/<slug>.*` and `apps/sop-<slug>/index.html`.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { renderMarkdownToPdf, pdfPageCount, type StateDir } from "@open-instinct/core";
import type { ExecutionClassification, SOPDocument, SOPStep, ToolConnectionStatus } from "./sop-okf.js";
import { buildSOPRoleMap } from "./sop-okf.js";
import { kebabCase } from "./sop-generator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which artifact(s) to render. `all` = web + gif + mp4 + pdf. */
export type SOPVisualFormat = "web" | "gif" | "mp4" | "pdf" | "all";

/** Individual formats a render can produce. */
export type SOPRenderedFormat = "web" | "gif" | "mp4" | "pdf";

/** Card dot colors allowed by the Archify cards schema. */
type CardDot = "cyan" | "emerald" | "violet" | "amber" | "rose" | "orange" | "slate";

type NodeKind = "frontend" | "backend" | "database" | "cloud" | "security" | "messagebus" | "external";
type EdgeVariant = "default" | "emphasis" | "security" | "dashed";
type LaneVariant = "normal" | "exception";
type PhaseVariant = "default" | "emphasis" | "security" | "dashed";
type GroupVariant = "default" | "emphasis" | "security" | "dashed";
type NodeIcon = "start" | "decision" | "waiting" | "failure" | "person" | "clock" | "none";

export interface ArchifyWorkflowSpec {
  schema_version: 2;
  diagram_type: "workflow";
  meta: {
    title: string;
    subtitle?: string;
    output: string;
    animation: "trace" | "none";
    visual_preset: "classic" | "signal-flow" | "blueprint" | "editorial";
    quality_profile: "standard" | "showcase";
  };
  lanes: Array<{ id: string; label: string; variant?: LaneVariant }>;
  phases?: Array<{ id: string; label: string; fromCol: number; toCol: number; variant?: PhaseVariant }>;
  groups?: Array<{ id: string; label: string; lane: string; fromCol: number; toCol: number; variant?: GroupVariant }>;
  mainPath: string[];
  nodes: Array<{
    id: string;
    lane: string;
    col: number;
    type: NodeKind;
    label: string;
    sublabel?: string;
    tag?: string;
    icon?: NodeIcon;
  }>;
  edges: Array<{
    id?: string;
    from: string;
    to: string;
    label?: string;
    variant?: EdgeVariant;
    role?: "main" | "branch" | "async" | "return" | "error";
  }>;
  cards?: Array<{ dot: CardDot; title: string; items: string[] }>;
}

export interface SOPVisualRenderOptions {
  format?: SOPVisualFormat;
  /**
   * Renderer binaries, injectable for tests. `null` forces that renderer to be
   * skipped; omitted resolves from the environment (env var, skills dir, PATH).
   */
  tools?: {
    archifyBin?: string | null;
    chromeBin?: string | null;
    ffmpegBin?: string | null;
  };
}

export interface SOPVisualArtifact {
  /** kebab-case slug shared by every artifact of this SOP. */
  slug: string;
  /** Absolute path of the compiled Archify candidate (evidence). */
  specPath: string;
  /** Workspace-relative path of the compiled Archify candidate. */
  specWorkspacePath: string;
  html?: { absolutePath: string; workspacePath: string; renderer: "archify" | "fallback" };
  png?: { absolutePath: string; workspacePath: string };
  gif?: { absolutePath: string; workspacePath: string; bytes: number };
  mp4?: { absolutePath: string; workspacePath: string; bytes: number };
  pdf?: { absolutePath: string; workspacePath: string; bytes: number; pages: number };
  /** Number of timeline frames the animation walks through (steps + overview). */
  frames: number;
  /** Non-fatal notes: skipped formats, degraded output, missing binaries. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clip to `max` ASCII-ish units on a word boundary with an ellipsis. */
function clip(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return head.replace(/[ ,;:.]+$/, "") + "…";
}

/** kebab slug for file/folder names, with a safe fallback. */
export function sopSlug(title: string): string {
  return kebabCase(title || "") || "untitled";
}

function chunkSteps(steps: SOPStep[], maxChunks: number): SOPStep[][] {
  if (steps.length <= maxChunks) return steps.map((s) => [s]);
  const size = Math.ceil(steps.length / maxChunks);
  const chunks: SOPStep[][] = [];
  for (let i = 0; i < steps.length; i += size) chunks.push(steps.slice(i, i + size));
  // A final uneven remainder must not create a chunk beyond maxChunks: the
  // ceil-based size above guarantees ceil(n / size) <= maxChunks, but clamp
  // anyway so a pathological input can never overflow the column grid.
  while (chunks.length > maxChunks) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1]!.push(...last);
  }
  return chunks;
}

function humanStep(step: SOPStep, classification: ExecutionClassification): boolean {
  if (classification === "Manual") return true;
  if (classification === "Fully_Automated") return false;
  return Boolean(step.checkpoint) || Boolean(step.owner?.toLowerCase().includes("human"));
}

function normalizeTool(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Plan: lanes, columns, node placement (shared by spec + fallback renderer)
// ---------------------------------------------------------------------------

const LANE_LABELS: Record<ExecutionClassification, { you: string; agent: string }> = {
  Manual: { you: "You (Human — Executor & Judge)", agent: "Agent (Pacer & Scribe)" },
  Hybrid: { you: "You (Human — Taste & Approval Gate)", agent: "Agent (0–80% Mechanical Prep)" },
  Fully_Automated: { you: "You (Human — Exception Escalation Only)", agent: "Agent (End-to-End Autopilot)" },
};

interface StepGroup {
  id: string;
  lane: "you" | "agent";
  col: number;
  checkpoint: boolean;
  steps: SOPStep[];
  step: SOPStep;
}

interface SOPVisualPlan {
  spec: ArchifyWorkflowSpec;
  classification: ExecutionClassification;
  slug: string;
  groups: StepGroup[];
}

function buildPlan(doc: SOPDocument): SOPVisualPlan {
  const frontmatter = doc.frontmatter;
  const classification = frontmatter.execution_classification;
  const steps = [...(doc.body.steps ?? [])].sort((a, b) => a.step - b.step);
  const roleMap = doc.body.role_map ?? buildSOPRoleMap(classification, steps, frontmatter.title);
  const tools = (frontmatter.required_tools_or_skills ?? []).filter((t) => normalizeTool(t).length > 0);
  const status: Record<string, ToolConnectionStatus> = frontmatter.required_tools_status ?? {};
  const slug = sopSlug(frontmatter.title);

  const lanes: ArchifyWorkflowSpec["lanes"] = [
    { id: "you", label: LANE_LABELS[classification].you },
    { id: "agent", label: LANE_LABELS[classification].agent },
  ];
  if (classification === "Fully_Automated") lanes[0]!.variant = "exception";
  if (tools.length > 0) lanes.push({ id: "tools", label: "Connected Tools & MCP" });

  // Trigger: the human sets the intent except under Full Automation, where the
  // run starts on schedule/request and the human lane is escalation-only.
  const triggerId = "trigger";
  const trigger: ArchifyWorkflowSpec["nodes"][number] = {
    id: triggerId,
    lane: classification === "Fully_Automated" ? "agent" : "you",
    col: 0,
    type: "frontend",
    label: "Trigger / Intent",
    sublabel: classification === "Fully_Automated" ? "on schedule or ask" : "you set the intent",
    icon: "start",
  };

  // Step groups → columns. Col 0 is the trigger; the Fully_Automated human
  // lane keeps col 5 for the exception node, so its steps use cols 1..4.
  const maxStepCols = classification === "Fully_Automated" ? 4 : 5;
  const chunks = steps.length > 0 ? chunkSteps(steps, maxStepCols) : [];
  const groups: StepGroup[] = chunks.map((chunk, idx) => {
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    const checkpoint = chunk.some((s) => s.checkpoint);
    let lane: "you" | "agent";
    if (classification === "Manual") lane = "you";
    else if (classification === "Fully_Automated") lane = "agent";
    else if (checkpoint) lane = "you";
    else {
      const humanish = chunk.filter((s) => s.owner?.toLowerCase().includes("human")).length;
      lane = humanish > 0 && humanish * 2 >= chunk.length ? "you" : "agent";
    }
    return {
      id: chunk.length === 1 ? `step${first.step}` : `step${first.step}-${last.step}`,
      lane,
      col: idx + 1,
      checkpoint,
      steps: chunk,
      step: first,
    };
  });

  // A Hybrid SOP with no explicit human step still ends on the owner's desk
  // (mirrors buildSOPRoleMap): the final group becomes the approval gate.
  if (classification === "Hybrid" && groups.length > 0 && !groups.some((g) => g.lane === "you")) {
    groups[groups.length - 1]!.lane = "you";
    groups[groups.length - 1]!.checkpoint = true;
  }

  // Defensive: an SOP with zero steps still renders a runnable map.
  if (groups.length === 0) {
    groups.push({
      id: "step1",
      lane: classification === "Fully_Automated" ? "agent" : "you",
      col: 1,
      checkpoint: false,
      steps: [],
      step: { step: 1, description: "Run the procedure" },
    });
  }

  const stepRoleSublabel = (g: StepGroup): string => {
    if (g.lane === "you") return g.checkpoint ? "your sign-off" : "you run this";
    const toolNames = [...new Set(g.steps.flatMap((s) => s.tools ?? []).map((t) => t.trim()).filter(Boolean))];
    if (toolNames.length > 0) return clip(`via ${toolNames.join(" + ")}`, 30);
    if (classification === "Manual") return "I pace & log";
    return "agent runs";
  };

  const nodes: ArchifyWorkflowSpec["nodes"] = [trigger];
  for (const g of groups) {
    nodes.push({
      id: g.id,
      lane: g.lane,
      col: g.col,
      type: g.lane === "you" ? (g.checkpoint ? "security" : "frontend") : "backend",
      label: clip(g.step.description || `Step ${g.step.step}`, 24),
      sublabel: stepRoleSublabel(g),
      tag:
        g.steps.length > 1
          ? `Steps ${g.steps[0]!.step}–${g.steps[g.steps.length - 1]!.step}`
          : `Step ${g.step.step}`,
      icon: g.lane === "you" && g.checkpoint ? "decision" : undefined,
    });
  }

  // Manual SOPs: the agent lane carries parallel support work (cue-up + scribe).
  const addManualSupport = classification === "Manual";
  if (addManualSupport) {
    nodes.push({ id: "cue", lane: "agent", col: 1, type: "backend", label: "Cue up context", sublabel: "before you start" });
    nodes.push({ id: "scribe", lane: "agent", col: 5, type: "database", label: "Log sign-off", sublabel: "checklist + receipts" });
  }

  // Fully_Automated SOPs: the human lane holds only the escalation node.
  const addException = classification === "Fully_Automated";
  if (addException) {
    nodes.push({ id: "exception", lane: "you", col: 5, type: "security", label: "Exception", sublabel: "escalates to you", tag: "on error", icon: "failure" });
  }

  // Tools lane: one node per required tool (capped), each in its own column so
  // two tool nodes can never overlap in the same lane/col cell.
  const toolNodes: Array<{ id: string; tool: string; col: number }> = [];
  const usedCols = new Set<number>();
  const placeTool = (tool: string, preferred: number | undefined): number | undefined => {
    const order = [preferred, 1, 2, 3, 4, 5, 0].filter((c): c is number => c !== undefined);
    for (const col of new Set(order)) {
      if (!usedCols.has(col)) {
        usedCols.add(col);
        return col;
      }
    }
    return undefined;
  };
  const uniqueTools = tools.length <= 6 ? tools : tools.slice(0, 5);
  const overflowTools = tools.length <= 6 ? [] : tools.slice(5);
  // The tools lane is independent of the step columns: every tool node gets its
  // own cell so two tool nodes can never overlap (the renderer rejects that).

  // First group referencing each tool owns its dashed tool edge (keeps every
  // tool edge forward or vertical; the renderer never needs a back-route).
  const toolOwner = new Map<string, StepGroup>();
  for (const g of groups) {
    for (const t of g.steps.flatMap((s) => s.tools ?? [])) {
      const key = normalizeTool(t);
      if (key && !toolOwner.has(key)) toolOwner.set(key, g);
    }
  }

  if (tools.length > 0) {
    for (const tool of uniqueTools) {
      const owner = toolOwner.get(normalizeTool(tool));
      const col = placeTool(tool, owner ? owner.col : undefined);
      if (col === undefined) continue;
      const id = `tool_${sopSlug(tool) || "t"}`.replace(/-/g, "_");
      toolNodes.push({ id, tool, col });
      const st = status[tool] ?? status[tool.trim()] ?? undefined;
      nodes.push({
        id,
        lane: "tools",
        col,
        type: "cloud",
        label: clip(tool, 24),
        sublabel: st ? clip(st.replace(/_/g, " "), 16) : "required tool",
        icon: st === "connected" ? undefined : "waiting",
      });
    }
    if (overflowTools.length > 0) {
      const col = placeTool("more", undefined);
      if (col !== undefined) {
        const id = "tool_more";
        toolNodes.push({ id, tool: "", col });
        nodes.push({
          id,
          lane: "tools",
          col,
          type: "cloud",
          label: `+${overflowTools.length} more tools`,
          sublabel: clip(overflowTools.join(", "), 34),
          icon: "waiting",
        });
      }
    }
  }

  // ------------------------------------------------------------------ edges
  const edges: ArchifyWorkflowSpec["edges"] = [];
  const ordered = [trigger, ...groups.map((g) => nodes.find((n) => n.id === g.id)!)];
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i]!;
    const b = ordered[i + 1];
    if (!b) break;
    const intoCheckpoint = b.tag?.startsWith("Step") && b.type === "security";
    const outOfCheckpoint = a.tag?.startsWith("Step") && a.type === "security";
    edges.push({
      from: a.id,
      to: b.id,
      role: "main",
      ...(intoCheckpoint ? { variant: "security" as EdgeVariant, label: "needs your approval" } : {}),
      ...(!intoCheckpoint && outOfCheckpoint ? { variant: "emphasis" as EdgeVariant, label: "approved" } : {}),
    });
  }

  if (addManualSupport) {
    const first = groups[0]!;
    edges.push({ from: triggerId, to: "cue", variant: "dashed", role: "async", label: "cue up context" });
    edges.push({ from: "cue", to: first.id, variant: "dashed", role: "async" });
    const checkpoints = groups.filter((g) => g.checkpoint);
    const scribeSources = checkpoints.length > 0 ? checkpoints : [groups[groups.length - 1]!];
    scribeSources.forEach((g) => {
      edges.push({
        from: g.id,
        to: "scribe",
        variant: "dashed",
        role: "async",
        ...(g === scribeSources[0] ? { label: "log sign-off" } : {}),
      });
    });
  }

  if (addException) {
    const last = groups[groups.length - 1]!;
    edges.push({ from: last.id, to: "exception", variant: "security", role: "error", label: "on exception" });
  }

  for (const tn of toolNodes) {
    if (!tn.tool) continue;
    const owner = toolOwner.get(normalizeTool(tn.tool));
    if (!owner) continue;
    if (tn.col < owner.col) continue; // congested placement: skip rather than route backwards
    edges.push({ from: owner.id, to: tn.id, variant: "dashed", role: "async" });
  }

  // ----------------------------------------------------------------- phases
  const maxCol = Math.max(...groups.map((g) => g.col), 1);
  const humanCols = groups.filter((g) => g.lane === "you").map((g) => g.col).sort((a, b) => a - b);
  const phases: NonNullable<ArchifyWorkflowSpec["phases"]> = [
    { id: "intent", label: "Intent", fromCol: 0, toCol: 0 },
  ];
  if (classification === "Manual") {
    phases.push({ id: "execute", label: "You execute — I pace & log", fromCol: 1, toCol: maxCol, variant: "emphasis" });
  } else if (classification === "Hybrid") {
    const minH = humanCols[0] ?? 1;
    const maxH = humanCols[humanCols.length - 1] ?? maxCol;
    if (minH > 1) phases.push({ id: "prep", label: "I prep (0–80%)", fromCol: 1, toCol: minH - 1 });
    phases.push({ id: "review", label: "Your approval gate", fromCol: minH, toCol: maxH, variant: "security" });
    if (maxH < maxCol) phases.push({ id: "finish", label: "I finish", fromCol: maxH + 1, toCol: maxCol });
  } else {
    phases.push({ id: "autopilot", label: "Autopilot — end-to-end", fromCol: 1, toCol: maxCol, variant: "emphasis" });
  }

  // ----------------------------------------------------------------- groups
  const groupsSpec: NonNullable<ArchifyWorkflowSpec["groups"]> = [];
  const span = (ids: number[]): { from: number; to: number } | undefined => {
    if (ids.length === 0) return undefined;
    const from = Math.min(...ids);
    const to = Math.max(...ids);
    return from <= to ? { from, to } : undefined;
  };
  if (addManualSupport) {
    const s = span([1, 5]);
    if (s) groupsSpec.push({ id: "support", label: "Pacer & scribe support", lane: "agent", fromCol: s.from, toCol: s.to, variant: "dashed" });
  }
  if (classification === "Hybrid") {
    const you = span(groups.filter((g) => g.lane === "you").map((g) => g.col));
    const agent = span(groups.filter((g) => g.lane === "agent").map((g) => g.col));
    if (you) groupsSpec.push({ id: "your_gate", label: "Your taste gate", lane: "you", fromCol: you.from, toCol: you.to, variant: "security" });
    if (agent) groupsSpec.push({ id: "agent_prep", label: "Agent prep & execution", lane: "agent", fromCol: agent.from, toCol: agent.to, variant: "dashed" });
  }
  if (classification === "Fully_Automated") {
    const agent = span(groups.map((g) => g.col));
    if (agent) groupsSpec.push({ id: "autopilot_span", label: "Runs without you", lane: "agent", fromCol: agent.from, toCol: agent.to, variant: "emphasis" });
  }

  // ------------------------------------------------------------------ cards
  const toolSummary = tools.length > 0
    ? tools.map((t) => {
        const st = status[t] ?? status[t.trim()];
        return `${t}${st ? ` (${st.replace(/_/g, " ")})` : ""}`;
      }).join(", ")
    : "No external tools required";
  const cards: NonNullable<ArchifyWorkflowSpec["cards"]> = [
    { dot: "cyan", title: "Where You Fit", items: [clip(roleMap.humanScope, 104), clip(roleMap.cadenceAndNudges, 104)] },
    { dot: "emerald", title: "Where the Agent Fits", items: [clip(roleMap.agentScope, 104)] },
    { dot: "violet", title: "Tools & Owner Summary", items: [clip(toolSummary, 104), clip(roleMap.userSummary, 104)] },
  ];

  const spec: ArchifyWorkflowSpec = {
    schema_version: 2,
    diagram_type: "workflow",
    meta: {
      title: frontmatter.title || "SOP Role Map",
      subtitle: `${classification} · ${frontmatter.department} — Where You Fit vs. Where the Agent Fits`,
      output: `apps/sop-${slug}/index.html`,
      animation: "trace",
      visual_preset: "signal-flow",
      quality_profile: "showcase",
    },
    lanes,
    phases,
    ...(groupsSpec.length > 0 ? { groups: groupsSpec } : {}),
    mainPath: [triggerId, ...groups.map((g) => g.id)],
    nodes,
    edges,
    cards,
  };

  return { spec, classification, slug, groups };
}

/**
 * Compile an SOPDocument into a Schema v2 Archify `workflow` specification:
 * You / Agent / Tools swimlanes, phases per execution classification, the
 * mainPath trace, and Role Map summary cards.
 */
export function buildSOPArchifySpec(doc: SOPDocument): ArchifyWorkflowSpec {
  return buildPlan(doc).spec;
}

// ---------------------------------------------------------------------------
// Renderer binary resolution
// ---------------------------------------------------------------------------

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function isFile(p: string | undefined): boolean {
  return Boolean(p && existsSync(p) && statSync(p).isFile());
}

/** Locate the Archify CLI: explicit override, skills dirs, then repo-relative. */
export function resolveArchifyCli(): string | undefined {
  const envBin = process.env.ARCHIFY_BIN ?? process.env.INSTINCT_ARCHIFY_BIN;
  if (envBin) return isFile(envBin) ? envBin : undefined;
  const candidates: string[] = [];
  if (process.env.INSTINCT_SKILLS_DIR) candidates.push(join(process.env.INSTINCT_SKILLS_DIR, "archify", "bin", "archify.mjs"));
  candidates.push("/app/skills/archify/bin/archify.mjs");
  try {
    // packages/agentrun/{src,dist}/sop-visualizer.js → ../../../skills/archify
    candidates.push(fileURLToPath(new URL("../../../skills/archify/bin/archify.mjs", import.meta.url)));
  } catch {
    /* not a file URL */
  }
  candidates.push(join(homedir(), ".agents", "skills", "archify", "bin", "archify.mjs"));
  return candidates.find(isFile);
}

/** Locate Chrome/Chromium for headless frame capture (mirrors Archify's search). */
export function resolveChrome(): string | undefined {
  const env = process.env;
  const explicit = env.SOP_CHROME_BIN ?? env.CHROME_PATH ?? env.ARCHIFY_CHROME;
  if (explicit) return isFile(explicit) ? explicit : undefined;
  const fixed: string[] = [];
  const onPath: string[] = [];
  if (process.platform === "darwin") {
    fixed.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
    onPath.push("chromium", "google-chrome");
  } else if (process.platform === "win32") {
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)) {
      fixed.push(join(root!, "Google", "Chrome", "Application", "chrome.exe"));
    }
    onPath.push("chrome", "google-chrome", "msedge");
  } else {
    onPath.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  for (const candidate of fixed) if (isFile(candidate)) return candidate;
  for (const name of onPath) {
    const found = findOnPath(name);
    if (found) return found;
  }
  return undefined;
}

function findOnPath(command: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Locate FFmpeg: explicit override, then PATH. */
export function resolveFfmpeg(): string | undefined {
  const envBin = process.env.FFMPEG_BIN ?? process.env.SOP_FFMPEG_BIN;
  if (envBin) return isFile(envBin) ? envBin : undefined;
  return findOnPath("ffmpeg");
}

// ---------------------------------------------------------------------------
// Fallback HTML renderer (zero-dependency, frame-capable)
// ---------------------------------------------------------------------------

/**
 * Build the self-contained swimlane page used when the Archify CLI is absent
 * and as the deterministic frame source for GIF/MP4/PNG capture.
 *
 * `#frame=<k>` renders a static timeline state (k = 0 → overview) with all
 * animation disabled, so headless screenshots are reproducible; without a
 * frame hash it renders the interactive page (light/dark toggle, comet trace,
 * replay).
 */
function buildFallbackHtml(plan: SOPVisualPlan): string {
  const spec = plan.spec;
  const title = escapeHtml(spec.meta.title);
  const subtitle = escapeHtml(spec.meta.subtitle ?? "");
  const chipClass = plan.classification === "Manual" ? "chip-manual" : plan.classification === "Hybrid" ? "chip-hybrid" : "chip-auto";
  const payload = escapeScriptJson({ ...spec, lanes: spec.lanes, groups: spec.groups ?? [], phases: spec.phases ?? [] });
  const stepIds = JSON.stringify(plan.groups.map((g) => g.id));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Role Map</title>
<style>
:root{
  --bg:#0a1120; --band:#0f1a2e; --band-edge:#1c2c46; --card:#101b30; --card-edge:#1e2f4c;
  --text:#e6edf7; --muted:#93a4bf; --edge:#5b6b85; --edge-soft:#33415c;
  --you:#f59e0b; --agent:#22d3ee; --tools:#a78bfa; --sec:#fb7185; --err:#f87171; --ok:#34d399;
}
html[data-theme="light"]{
  --bg:#f6f8fc; --band:#eaeff7; --band-edge:#d4dcea; --card:#ffffff; --card-edge:#d9e1ee;
  --text:#12203a; --muted:#5a6c8a; --edge:#7d8daa; --edge-soft:#c4cede;
  --you:#b45309; --agent:#0e7490; --tools:#6d28d9; --sec:#e11d48; --err:#dc2626; --ok:#059669;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Liberation Sans",sans-serif}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#frame *{animation:none!important;transition:none!important}
.hd{position:absolute;left:28px;top:22px;right:28px;display:flex;align-items:center;gap:12px}
.hd h1{font-size:22px;margin:0;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%}
.chip{font-size:11px;font-weight:700;letter-spacing:.8px;padding:5px 10px;border-radius:999px;white-space:nowrap}
.chip-manual{background:rgba(245,158,11,.14);color:var(--you);border:1px solid var(--you)}
.chip-hybrid{background:rgba(34,211,238,.12);color:var(--agent);border:1px solid var(--agent)}
.chip-auto{background:rgba(52,211,153,.12);color:var(--ok);border:1px solid var(--ok)}
.sub{position:absolute;left:29px;top:56px;font-size:12.5px;color:var(--muted);max-width:76%;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lane{position:absolute;left:28px;right:28px;border:1px solid var(--band-edge);border-radius:14px;background:var(--band)}
.lane.exception{border:1.5px dashed var(--err)}
.lane-label{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:172px;font-size:12.5px;
  font-weight:700;line-height:1.35;color:var(--muted)}
.lane-tag{display:inline-block;font-size:10px;letter-spacing:1.4px;font-weight:800;color:var(--muted);opacity:.75;margin-bottom:4px}
.n{position:absolute;width:146px;height:74px;border-radius:12px;border:2px solid var(--edge);
  background:var(--card);padding:8px 10px;display:flex;flex-direction:column;justify-content:center;gap:3px;
  transition:box-shadow .3s,opacity .3s,border-color .3s}
.n .tag{position:absolute;top:-9px;left:9px;font-size:9.5px;font-weight:800;letter-spacing:.5px;
  background:var(--bg);border:1px solid var(--edge);border-radius:999px;padding:1px 7px;color:var(--muted)}
.n .lb{font-size:13.5px;font-weight:700;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.n .sl{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.n.you{border-color:var(--you)} .n.agent{border-color:var(--agent)} .n.tools{border-color:var(--tools)}
.n.sec{border-color:var(--sec);background:linear-gradient(180deg,rgba(251,113,133,.10),var(--card))}
.n.act{box-shadow:0 0 0 3px rgba(255,255,255,.06),0 0 26px rgba(34,211,238,.35)}
.n.you.act{box-shadow:0 0 0 3px rgba(245,158,11,.18),0 0 26px rgba(245,158,11,.40)}
.n.sec.act{box-shadow:0 0 0 3px rgba(251,113,133,.20),0 0 26px rgba(251,113,133,.45)}
.n.future{opacity:.30}
.n.done{opacity:1}
svg.edges{position:absolute;left:0;top:0;overflow:visible}
svg.edges path{fill:none;stroke:var(--edge);stroke-width:2}
svg.edges path.dash{stroke-dasharray:7 6;stroke:var(--edge-soft)}
svg.edges path.sec{stroke:var(--sec)} svg.edges path.emph{stroke-width:2.6}
svg.edges path.err{stroke:var(--err)} svg.edges path.vio{stroke:var(--tools)}
svg.edges path.dim{opacity:.18}
svg.edges text{fill:var(--muted);font-size:10.5px;font-weight:600}
svg.comet path{fill:none;stroke:#fff;stroke-width:3.4;stroke-linecap:round;opacity:.85;
  stroke-dasharray:12 988;animation:cm 3.4s linear infinite}
@keyframes cm{from{stroke-dashoffset:0}to{stroke-dashoffset:-1000}}
.cards{position:absolute;left:28px;right:28px;display:flex;gap:14px}
.card{flex:1;min-width:0;background:var(--card);border:1px solid var(--card-edge);border-radius:12px;padding:11px 13px}
.card h3{margin:0 0 7px;font-size:12px;letter-spacing:.4px;display:flex;align-items:center;gap:7px}
.card .dot{width:9px;height:9px;border-radius:50%;flex:none}
.card ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}
.card li{font-size:11px;line-height:1.45;color:var(--muted)}
.card li b{color:var(--text);font-weight:600}
.controls{position:absolute;right:30px;top:24px;display:flex;gap:8px}
.controls button{font:600 12px/1 inherit;color:var(--text);background:var(--card);border:1px solid var(--card-edge);
  border-radius:999px;padding:7px 13px;cursor:pointer}
#frame .controls{display:none}
#frame .sub{top:56px}
</style></head>
<body><div id="stage"></div>
<script>
var SPEC = ${payload};
var STEP_IDS = ${stepIds};
var CLASS = ${JSON.stringify(plan.classification)};
(function(){
  var COL_W=166, NODE_W=146, NODE_H=74, LANE_H=132, PAD=28, LABEL_W=196, HDR=92, GAP=10, CARD_H=150;
  var LANE_ID = {}; SPEC.lanes.forEach(function(l,i){ LANE_ID[l.id]=i; });
  var W = PAD*2 + LABEL_W + COL_W*6;
  var H = HDR + GAP + LANE_H*SPEC.lanes.length + 16 + CARD_H;
  var frameMode = /[#&]frame=/.test(location.hash);
  if(frameMode) document.documentElement.id='frame';
  var stage=document.getElementById('stage');
  stage.style.width=W+'px'; stage.style.height=H+'px';

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function colX(c){ return PAD + LABEL_W + c*COL_W + COL_W/2; }
  function laneY(i){ return HDR + GAP + i*LANE_H; }
  function nodeRect(n){
    return { x: colX(n.col)-NODE_W/2, y: laneY(LANE_ID[n.lane])+(LANE_H-NODE_H)/2, w:NODE_W, h:NODE_H,
             cx: colX(n.col), cy: laneY(LANE_ID[n.lane])+LANE_H/2 };
  }
  var byId={}; SPEC.nodes.forEach(function(n){ byId[n.id]=n; });

  var html='';
  html += '<div class="hd"><h1>'+esc(SPEC.meta.title)+'</h1><span class="chip '+
    (CLASS==='Manual'?'chip-manual':CLASS==='Hybrid'?'chip-hybrid':'chip-auto')+'">'+esc(CLASS.replace('_',' ')).toUpperCase()+'</span></div>';
  html += '<div class="sub">'+esc(SPEC.meta.subtitle||'')+'</div>';
  SPEC.lanes.forEach(function(l,i){
    var laneLabeL = esc(l.label).replace(/^(You|Agent) /, '<span class="lane-tag">$1</span><br>');
    html += '<div class="lane'+(l.variant==='exception'?' exception':'')+'" style="top:'+laneY(i)+'px;height:'+LANE_H+'px">'+
      '<div class="lane-label">'+laneLabeL+'</div></div>';
  });
  var svg='<svg class="edges" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+
    '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'+
    '<path d="M0,1 L9,5 L0,9 z" style="fill:var(--edge)"/></marker></defs>';
  SPEC.edges.forEach(function(e,i){
    var a=byId[e.from], b=byId[e.to]; if(!a||!b) return;
    var ra=nodeRect(a), rb=nodeRect(b), d;
    if(Math.abs(ra.cx-rb.cx)<1){
      if(rb.y>ra.y) d='M '+ra.cx+' '+(ra.y+ra.h)+' L '+rb.cx+' '+rb.y;
      else d='M '+ra.cx+' '+ra.y+' L '+rb.cx+' '+(rb.y+rb.h);
    } else if(rb.x>ra.x){
      var mx=(ra.x+ra.w+rb.x)/2;
      d='M '+(ra.x+ra.w)+' '+ra.cy+' H '+mx+' V '+rb.cy+' H '+rb.x;
    } else {
      d='M '+ra.cx+' '+ra.cy+' L '+rb.cx+' '+rb.cy;
    }
    var cls=[]; if(e.variant==='dashed') cls.push('dash'); if(e.variant==='security') cls.push('sec');
    if(e.variant==='emphasis') cls.push('emph'); if(e.role==='error') cls.push('err');
    if(e.role==='async' && e.variant!=='dashed') cls.push('dash');
    svg += '<path id="e'+i+'" d="'+d+'" class="'+cls.join(' ')+'" marker-end="url(#ar)"/>';
    if(e.label){
      var mid = Math.abs(ra.cx-rb.cx)<1 ? {x:ra.cx+8,y:(ra.cy+rb.cy)/2} : {x:(ra.x+ra.w+rb.x)/2, y:(ra.cy+rb.cy)/2-7};
      svg += '<text id="t'+i+'" x="'+mid.x+'" y="'+mid.y+'" text-anchor="middle">'+esc(e.label)+'</text>';
    }
  });
  svg += '<path id="comet" pathLength="1000" d="" style="display:none"/></svg>';
  html += svg;
  var stepIdx={}; STEP_IDS.forEach(function(id,i){ stepIdx[id]=i; });
  SPEC.nodes.forEach(function(n){
    var r=nodeRect(n);
    var laneClass = n.lane==='tools' ? 'tools' : n.lane;
    var sec = n.type==='security' ? ' sec' : '';
    html += '<div class="n '+laneClass+sec+'" id="n_'+n.id+'" style="left:'+r.x+'px;top:'+r.y+'px">'+
      (n.tag?'<span class="tag">'+esc(n.tag)+'</span>':'')+
      '<span class="lb">'+esc(n.label)+'</span>'+
      (n.sublabel?'<span class="sl">'+esc(n.sublabel)+'</span>':'')+'</div>';
  });
  var cards=SPEC.cards||[];
  html += '<div class="cards" style="top:'+(H-CARD_H+6)+'px">';
  cards.forEach(function(c){
    html += '<div class="card"><h3><span class="dot" style="background:var(--'+
      (c.dot==='cyan'?'agent':c.dot==='emerald'?'ok':c.dot==='violet'?'tools':c.dot==='rose'?'sec':'you')+')"></span>'+esc(c.title)+'</h3><ul>'+
      c.items.map(function(it){ return '<li>'+esc(it)+'</li>'; }).join('')+'</ul></div>';
  });
  html += '</div>';
  html += '<div class="controls"><button id="replay">▶ replay</button><button id="theme">☀ light</button></div>';
  stage.innerHTML = html;

  // Main-path comet for the interactive page (skipped in frame mode).
  if(!frameMode && STEP_IDS.length>1){
    var pts=[byId[SPEC.mainPath[0]]];
    SPEC.mainPath.forEach(function(id){ var n=byId[id]; if(n) pts.push(n); });
    var d='M '+pts.map(function(n){ var r=nodeRect(n); return r.cx+' '+r.cy; }).join(' L ');
    var cm=document.getElementById('comet'); cm.setAttribute('d',d); cm.style.display='';
  }

  function setFrame(k){
    STEP_IDS.forEach(function(id,i){
      var el=document.getElementById('n_'+id); if(!el) return;
      el.classList.remove('act','done','future');
      if(k===0) el.classList.add('done');
      else if(i<k-1) el.classList.add('done');
      else if(i===k-1) el.classList.add('act');
      else el.classList.add('future');
    });
    SPEC.edges.forEach(function(e,i){
      var p=document.getElementById('e'+i), t=document.getElementById('t'+i); if(!p) return;
      var toIdx = stepIdx[e.to];
      var dim = k>0 && toIdx!==undefined && toIdx>=k;
      p.classList.toggle('dim',dim); if(t) t.style.opacity = dim?0.18:1;
    });
  }
  setFrame(0);
  if(frameMode){
    var m=location.hash.match(/frame=(\\d+)/);
    setFrame(m?Math.max(0,Math.min(STEP_IDS.length,parseInt(m[1],10))):0);
  }

  var timer=null, pos=0;
  document.getElementById('replay').addEventListener('click',function(){
    if(timer){ clearInterval(timer); timer=null; this.textContent='▶ replay'; return; }
    this.textContent='⏸ pause'; var btn=this; pos=0;
    timer=setInterval(function(){
      setFrame(pos); pos++;
      if(pos>STEP_IDS.length){ clearInterval(timer); timer=null; btn.textContent='▶ replay'; pos=0; }
    },650);
  });
  document.getElementById('theme').addEventListener('click',function(){
    var light = document.documentElement.getAttribute('data-theme')==='light';
    document.documentElement.setAttribute('data-theme', light?'dark':'light');
    this.textContent = light?'☀ light':'☾ dark';
  });

  function fit(){
    var vw=window.innerWidth||1280, vh=window.innerHeight||720;
    var s=Math.min(vw/W, vh/H, 1.4);
    var tx=(vw-W*s)/2, ty=(vh-H*s)/2;
    stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
  }
  fit(); window.addEventListener('resize',fit);
})();
</script></body></html>`;
}

function escapeHtml(text: string): string {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON safe to inline inside a <script> block. */
function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, "");
}

// ---------------------------------------------------------------------------
// Frame capture + FFmpeg assembly
// ---------------------------------------------------------------------------

async function captureFrames(opts: {
  htmlPath: string;
  chrome: string;
  framesDir: string;
  count: number;
  profileDir: string;
  width: number;
  height: number;
}): Promise<{ paths: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const paths: string[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  for (let k = 0; k < opts.count; k += 1) {
    const out = join(opts.framesDir, `f${String(k).padStart(3, "0")}.png`);
    const url = `${pathToFileURL(opts.htmlPath).href}#frame=${k}`;
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1",
      `--user-data-dir=${opts.profileDir}`,
      `--window-size=${opts.width},${opts.height}`,
      "--virtual-time-budget=900",
      `--screenshot=${out}`,
      url,
    ];
    if (uid === 0 || process.env.SOP_CHROME_NO_SANDBOX === "1") args.unshift("--no-sandbox");
    const res = await run(opts.chrome, args, { timeoutMs: 45_000 });
    if (res.code !== 0 || !existsSync(out)) {
      warnings.push(`frame ${k} capture failed (${res.code === 0 ? "no output" : `exit ${res.code}`}); screenshot: ${clip(res.stderr.trim().split("\n").slice(-1)[0] ?? "", 140)}`);
      break;
    }
    paths.push(out);
  }
  return { paths, warnings };
}

/**
 * Repeat captured frames into a paced sequence (intro hold → one beat per
 * step → outro hold) so FFmpeg's frame-rate alone produces the rhythm.
 */
function writeSequence(dir: string, framePaths: string[], counts: number[]): string {
  const seqDir = join(dir, "seq");
  rmSync(seqDir, { recursive: true, force: true });
  mkdirSync(seqDir, { recursive: true });
  let n = 0;
  framePaths.forEach((src, i) => {
    const repeat = Math.max(1, counts[i] ?? 8);
    for (let r = 0; r < repeat; r += 1) {
      copyFileSync(src, join(seqDir, `s${String(n).padStart(4, "0")}.png`));
      n += 1;
    }
  });
  return seqDir;
}

async function assembleGif(ffmpeg: string, seqDir: string, outPath: string, scale: number): Promise<CmdResult> {
  return run(
    ffmpeg,
    [
      "-y", "-framerate", "12", "-i", join(seqDir, "s%04d.png"),
      "-vf", `fps=12,scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      outPath,
    ],
    { timeoutMs: 90_000 },
  );
}

async function assembleMp4(ffmpeg: string, seqDir: string, outPath: string, scale: number): Promise<CmdResult> {
  return run(
    ffmpeg,
    [
      "-y", "-framerate", "12", "-i", join(seqDir, "s%04d.png"),
      "-vf", `scale=${scale}:-1:flags=lanczos`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      outPath,
    ],
    { timeoutMs: 90_000 },
  );
}

// ---------------------------------------------------------------------------
// PDF playbook
// ---------------------------------------------------------------------------

/**
 * One-page playbook markdown. Every section is budgeted against the page
 * content box (612−2×56 = 500pt): tables render in Courier 9pt (~5.4pt/char
 * → ≤ ~92 chars per row before wrapping), prose in Helvetica 11pt. Wide
 * tables, `##` header blocks, and per-step tool columns are the things that
 * historically pushed this to page 2 — keep them out.
 */
function buildPlaybookMarkdown(doc: SOPDocument, plan: SOPVisualPlan, pngWorkspacePath: string | undefined): string {
  const frontmatter = doc.frontmatter;
  const roleMap = doc.body.role_map ?? buildSOPRoleMap(frontmatter.execution_classification, doc.body.steps ?? [], frontmatter.title);
  const status = frontmatter.required_tools_status ?? {};
  const steps = [...(doc.body.steps ?? [])].sort((a, b) => a.step - b.step);

  const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + "…" : text);
  /** Collapse an owner label to `You` / `Agent`, else a short clipped label. */
  const shortOwner = (owner: string | undefined, fallback: string): string => {
    const raw = (owner ?? "").trim();
    if (!raw) return fallback;
    if (/\b(you|human|owner|person|me|i|my)\b/i.test(raw)) return "You";
    if (/\b(agent|ai|assistant|automat|bot|system|skill|model)\b/i.test(raw)) return "Agent";
    return clip(raw.replace(/\|/g, "/"), 16);
  };

  const lines: string[] = [];
  // Short alt text: the caption line is real vertical space on a 1-page budget.
  if (pngWorkspacePath) lines.push(`![Role Map](${pngWorkspacePath})`, "");
  lines.push(`**Classification:** ${frontmatter.execution_classification} · **Department:** ${frontmatter.department}`, "");
  lines.push(`**Core objective:** ${frontmatter.core_objective}`, "");
  lines.push("## Where You Fit vs. Where the Agent Fits", "");
  lines.push(`- **Your Scope (Human):** ${roleMap.humanScope}`);
  lines.push(`- **Where the Agent Fits:** ${roleMap.agentScope}`);
  lines.push(`- **When You Hear From Me:** ${roleMap.cadenceAndNudges}`);
  lines.push(`- **Summary for Owner:** ${roleMap.userSummary}`, "");
  lines.push("## Procedural Steps", "");
  if (steps.length > 0) {
    // No Tools column: tools are one summary line below, and each dropped
    // column is ~18 chars of row budget the action text gets to keep.
    lines.push("| # | Action | Owner | OK |", "|---|---|---|---|");
    for (const s of steps) {
      const fallback = plan.classification === "Fully_Automated" ? "Agent" : plan.classification === "Manual" ? "You" : "—";
      const owner = shortOwner(s.owner, fallback);
      const action = clip(s.description.replace(/\|/g, "/").replace(/\s+/g, " ").trim(), 44);
      const ckpt = s.checkpoint ? "Yes" : "—";
      lines.push(`| ${s.step} | ${action} | ${owner} | ${ckpt} |`);
    }
  } else {
    lines.push("_No steps defined._");
  }
  lines.push("");
  // Tools as one line instead of a status table (saves a header + 2+ rows).
  const tools = frontmatter.required_tools_or_skills ?? [];
  if (tools.length > 0) {
    const toolLine = tools
      .map((t) => `${t} (${(status[t] ?? "unknown").replace(/_/g, " ")})`)
      .join(", ");
    lines.push(`**Required tools:** ${toolLine}`, "");
  }
  // Inline labels instead of `##` heading blocks (each header costs ~2 lines).
  if (doc.body.exit_criteria) lines.push(`**Exit:** ${doc.body.exit_criteria}`, "");
  if (doc.body.notes) lines.push(`**Notes:** ${doc.body.notes}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Workspace-relative POSIX path (what `send_file` expects). */
function wsRel(workspaceDir: string, abs: string): string {
  const rel = relative(workspaceDir, abs);
  return rel.split(sep).join("/");
}

/**
 * Render the visual Role Map artifacts for an SOPDocument. Returns the written
 * paths (absolute + workspace-relative) and the exact next tool calls the
 * agent needs to deliver them. Never throws for a missing renderer binary —
 * downgrades and records a warning instead.
 */
export async function renderSOPVisualArtifact(
  doc: SOPDocument,
  stateDir: StateDir,
  options: SOPVisualRenderOptions = {},
): Promise<SOPVisualArtifact> {
  const format = options.format ?? "all";
  const wanted: SOPRenderedFormat[] = format === "all" ? ["web", "gif", "mp4", "pdf"] : [format];

  const plan = buildPlan(doc);
  const { spec, slug, groups } = plan;
  const workspaceDir = stateDir.path("workspace");
  const mapsDir = stateDir.path("workspace", "sop-maps");
  const appDir = stateDir.path("workspace", "apps", `sop-${slug}`);
  mkdirSync(mapsDir, { recursive: true });

  const artifact: SOPVisualArtifact = { slug, specPath: "", specWorkspacePath: "", frames: groups.length + 1, warnings: [] };
  const wantWeb = wanted.includes("web");
  const wantFrames = wanted.includes("gif") || wanted.includes("mp4") || wanted.includes("pdf");

  // 1. Compile the candidate (evidence for Archify and for debugging).
  const specPath = join(mapsDir, `${slug}.candidate.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
  artifact.specPath = specPath;
  artifact.specWorkspacePath = wsRel(workspaceDir, specPath);

  const resolveTool = (key: "archifyBin" | "chromeBin" | "ffmpegBin", fallback: () => string | undefined): string | undefined => {
    const override = options.tools?.[key];
    if (override === null) return undefined;
    if (typeof override === "string") return isFile(override) ? override : undefined;
    return fallback();
  };

  // 2. Frame source HTML — always the built-in renderer, so frames are
  //    deterministic regardless of whether Archify renders the web link.
  const fallbackHtml = buildFallbackHtml(plan);
  const framesHtmlPath = join(mapsDir, `${slug}.map.html`);
  if (wantWeb || wantFrames) {
    if (wantFrames) writeFileSync(framesHtmlPath, fallbackHtml, "utf8");
  }

  // 3. Web link: Archify when the CLI is available, else the fallback page.
  if (wantWeb) {
    const archify = resolveTool("archifyBin", resolveArchifyCli);
    let rendered = false;
    if (archify) {
      mkdirSync(appDir, { recursive: true });
      const outRel = `apps/sop-${slug}/index.html`;
      const res = await run(process.execPath, [archify, "finalize", "workflow", specPath, outRel, "--quality", "showcase", "--json"], {
        cwd: workspaceDir,
        timeoutMs: 120_000,
      });
      const outFile = join(workspaceDir, outRel);
      if (res.code === 0 && existsSync(outFile)) {
        rendered = true;
        artifact.html = { absolutePath: outFile, workspacePath: wsRel(workspaceDir, outFile), renderer: "archify" };
      } else {
        artifact.warnings.push(`Archify finalize failed (exit ${res.code}); rendering the built-in page instead: ${clip(res.stderr.trim().split("\n").slice(-1)[0] ?? res.stdout.trim().slice(-160), 160)}`);
      }
    } else {
      artifact.warnings.push("Archify CLI not found; rendering the built-in swimlane page.");
    }
    if (!rendered) {
      mkdirSync(appDir, { recursive: true });
      const outFile = join(appDir, "index.html");
      writeFileSync(outFile, fallbackHtml, "utf8");
      artifact.html = { absolutePath: outFile, workspacePath: wsRel(workspaceDir, outFile), renderer: "fallback" };
    }
  }

  // 4. Frames (Chrome headless) for gif/mp4/pdf.
  let framePaths: string[] = [];
  const chrome = wantFrames ? resolveTool("chromeBin", resolveChrome) : undefined;
  const profileDir = join(tmpdir(), `sop-viz-chrome-${slug}-${process.pid}`);
  const framesDir = join(mapsDir, `.frames-${slug}`);
  if (wantFrames) {
    if (!chrome) {
      artifact.warnings.push("Chrome/Chromium not found — animated GIF/MP4 skipped and the PDF will omit the map image. Set SOP_CHROME_BIN to enable them.");
    } else if (existsSync(framesHtmlPath)) {
      rmSync(framesDir, { recursive: true, force: true });
      mkdirSync(framesDir, { recursive: true });
      mkdirSync(profileDir, { recursive: true });
      const capture = await captureFrames({
        htmlPath: framesHtmlPath,
        chrome,
        framesDir,
        count: groups.length + 1,
        profileDir,
        width: 1280,
        height: 720,
      });
      framePaths = capture.paths;
      artifact.warnings.push(...capture.warnings);
      if (framePaths.length > 0 && framePaths.length < groups.length + 1) {
        artifact.warnings.push(`Only ${framePaths.length}/${groups.length + 1} frames captured; continuing with what is available.`);
      }
      if (framePaths.length === 0) {
        artifact.warnings.push("No frames could be captured; GIF/MP4/PDF image skipped.");
        framePaths = [];
      }
    }
  }

  // 5. PNG snapshot (overview frame) for the PDF.
  if (framePaths.length > 0 && wanted.includes("pdf")) {
    const pngPath = join(mapsDir, `${slug}.png`);
    copyFileSync(framePaths[0]!, pngPath);
    artifact.png = { absolutePath: pngPath, workspacePath: wsRel(workspaceDir, pngPath) };
  }

  // 6. GIF / MP4 assembly.
  const ffmpeg = wanted.includes("gif") || wanted.includes("mp4") ? resolveTool("ffmpegBin", resolveFfmpeg) : undefined;
  if (framePaths.length >= 2 && (wanted.includes("gif") || wanted.includes("mp4"))) {
    if (!ffmpeg) {
      artifact.warnings.push("FFmpeg not found — GIF/MP4 skipped. Install ffmpeg (or set FFMPEG_BIN) to enable them.");
    } else {
      const seqDir = writeSequence(
        join(mapsDir, `.seq-${slug}`),
        framePaths,
        // intro hold → 8 frames (~0.67 s) per step → outro hold
        framePaths.map((_, i) => (i === 0 || i === framePaths.length - 1 ? 15 : 8)),
      );
      if (wanted.includes("gif")) {
        const gifPath = join(mapsDir, `${slug}.gif`);
        let res = await assembleGif(ffmpeg, seqDir, gifPath, 960);
        if (res.code === 0 && existsSync(gifPath)) {
          let bytes = statSync(gifPath).size;
          if (bytes > 8 * 1024 * 1024) {
            // iMessage inlines up to ~10 MB; retry at a smaller width before giving up.
            res = await assembleGif(ffmpeg, seqDir, gifPath, 720);
            bytes = statSync(gifPath).size;
          }
          if (res.code === 0 && bytes <= 8 * 1024 * 1024) {
            artifact.gif = { absolutePath: gifPath, workspacePath: wsRel(workspaceDir, gifPath), bytes };
          } else {
            artifact.warnings.push(`GIF too large for inline iMessage (${Math.round(bytes / 1024)} KB); skipped.`);
            rmSync(gifPath, { force: true });
          }
        } else {
          artifact.warnings.push(`FFmpeg GIF assembly failed: ${clip(res.stderr.trim().split("\n").slice(-1)[0] ?? "", 150)}`);
        }
      }
      if (wanted.includes("mp4")) {
        const mp4Path = join(mapsDir, `${slug}.mp4`);
        const res = await assembleMp4(ffmpeg, seqDir, mp4Path, 960);
        if (res.code === 0 && existsSync(mp4Path)) {
          artifact.mp4 = { absolutePath: mp4Path, workspacePath: wsRel(workspaceDir, mp4Path), bytes: statSync(mp4Path).size };
        } else {
          artifact.warnings.push(`FFmpeg MP4 assembly failed: ${clip(res.stderr.trim().split("\n").slice(-1)[0] ?? "", 150)}`);
        }
      }
      rmSync(join(mapsDir, `.seq-${slug}`), { recursive: true, force: true });
    }
  }

  // 7. PDF playbook (map PNG embedded when one was captured).
  if (wanted.includes("pdf")) {
    try {
      const markdown = buildPlaybookMarkdown(doc, plan, artifact.png?.workspacePath);
      const pdf = await renderMarkdownToPdf(markdown, {
        // The embedded map PNG already shows the SOP title; the 24pt title
        // block costs ~60pt and is what pushes the playbook onto page 2.
        // Only add it when the image is missing (text-only fallback).
        title: artifact.png ? undefined : `Role Map — ${doc.frontmatter.title}`,
        resolveImage: (src) => {
          const raw = src.trim();
          const abs = isAbsolute(raw) ? raw : join(workspaceDir, raw);
          return existsSync(abs) ? abs : undefined;
        },
      });
      const pdfPath = join(mapsDir, `${slug}.pdf`);
      writeFileSync(pdfPath, pdf);
      artifact.pdf = { absolutePath: pdfPath, workspacePath: wsRel(workspaceDir, pdfPath), bytes: pdf.length, pages: pdfPageCount(pdf) };
      if (!artifact.png) artifact.warnings.push("PDF rendered without the map image (no Chrome snapshot available).");
    } catch (err) {
      artifact.warnings.push(`PDF render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 8. Cleanup temp capture state.
  rmSync(framesDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });

  return artifact;
}

/**
 * Tool output: the generated workspace paths plus the exact next tool calls
 * (`send_file` for the default inline artifact, `ample_deploy` for the
 * interactive link) so the agent can deliver the Role Map in one turn.
 */
export function summarizeRoleMapArtifact(doc: SOPDocument, artifact: SOPVisualArtifact): string {
  const title = doc.frontmatter.title;
  const classification = doc.frontmatter.execution_classification;
  const lines: string[] = [`Role Map rendered for "${title}" (${classification}).`, "", "Generated (workspace-relative paths):"];

  const size = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;
  if (artifact.html) lines.push(`  - web: ${artifact.html.workspacePath} (renderer: ${artifact.html.renderer})`);
  if (artifact.gif) lines.push(`  - gif: ${artifact.gif.workspacePath} (${size(artifact.gif.bytes)})`);
  if (artifact.mp4) lines.push(`  - mp4: ${artifact.mp4.workspacePath} (${size(artifact.mp4.bytes)})`);
  if (artifact.pdf) lines.push(`  - pdf: ${artifact.pdf.workspacePath} (${artifact.pdf.pages} page(s), ${size(artifact.pdf.bytes)})`);
  if (artifact.png) lines.push(`  - png: ${artifact.png.workspacePath}`);
  lines.push(`  - spec: ${artifact.specWorkspacePath}`);

  // Default delivery: the inline animation first, then the interactive link.
  const caption = `Role Map for ${title} — where you fit vs. where I fit.`;
  const primary = artifact.gif ?? artifact.mp4 ?? artifact.pdf;
  const calls: string[] = [];
  if (primary) {
    const kind = artifact.gif ? "gif" : artifact.mp4 ? "mp4" : "pdf";
    calls.push(`send_file ${JSON.stringify({ path: primary.workspacePath, caption })}  // inline ${kind} (default)`);
  }
  if (artifact.html) {
    const folder = dirname(artifact.html.workspacePath);
    calls.push(`ample_deploy ${JSON.stringify({ path: folder })}  // then share the returned URL as the interactive link`);
  }

  lines.push("", "Next tool calls (deliver now, in this same turn):");
  if (calls.length === 0) {
    lines.push("  (nothing renderable was produced — see Notes and tell the owner what is missing)");
  } else {
    calls.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }

  const offers: string[] = [];
  if (primary !== artifact.pdf && artifact.pdf) {
    offers.push(`send_file ${JSON.stringify({ path: artifact.pdf.workspacePath, caption: `One-page playbook for ${title}` })} (PDF)`);
  }
  if (offers.length > 0) lines.push(`Offer in the same message: ${offers.join(", ")}.`);

  if (artifact.warnings.length > 0) {
    lines.push("", "Notes:");
    for (const w of artifact.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
