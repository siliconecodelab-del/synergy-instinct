/**
 * Minimal Open Knowledge Format (OKF) schema for Standard Operating Procedures (SOPs).
 *
 * An OKF SOP document is a markdown file with YAML frontmatter carrying the
 * structured metadata, followed by a markdown body containing the procedural
 * steps. This module defines the schema, validation, and serialization.
 */

export type ExecutionClassification = "Manual" | "Hybrid" | "Fully_Automated";

export type SOPStatus = "draft" | "published" | "archived";

export type ToolConnectionStatus = "connected" | "not_connected" | "not_configured";

export interface SOPFrontmatter {
  /** Human-readable title of the procedure. */
  title: string;
  /** Owning department, e.g. "GTM-playbook", "Research-and-Dev". */
  department: string;
  /** How the procedure is executed. Affects SOP structure. */
  execution_classification: ExecutionClassification;
  /** Brief summary of the SOP's goal. */
  core_objective: string;
  /** List of tools or skills needed, e.g. ["Slack", "CRM API"]. */
  required_tools_or_skills: string[];
  /** Connection status of each required tool: slug -> "connected" | "not_connected" | "not_configured". */
  required_tools_status?: Record<string, "connected" | "not_connected" | "not_configured">;
  /** ISO-8601 timestamp when the SOP was created. */
  created_at: string;
  /** Schema version this SOP conforms to. */
  version: string;
  /** Lifecycle status. */
  status: SOPStatus;
}

/** Minimal interface the SOP tool needs from ComposioApps to check tool availability. */
export interface ComposioLike {
  allToolkits: boolean;
  toolkitSlugs: string[];
  connectedToolkits(): Promise<{ slug: string; connected: boolean }[]>;
  connectLink(toolkit: string): Promise<string | undefined>;
}

export interface SOPStep {
  /** Step number within the procedure (1-based). */
  step: number;
  /** Human-readable description of what to do. */
  description: string;
  /** Who or what executes this step: a role, person, or tool/skill name. */
  owner?: string;
  /** Tools or skills referenced by this step. */
  tools?: string[];
  /** Whether this step is a checkpoint requiring sign-off before continuing. */
  checkpoint?: boolean;
}

export interface SOPBody {
  /** Trigger or entry condition: when this SOP should be invoked. */
  trigger?: string;
  /** Ordered list of procedural steps. */
  steps: SOPStep[];
  /** Exit criteria: what "done" looks like. */
  exit_criteria?: string;
  /** Optional notes, warnings, or exceptions. */
  notes?: string;
}

export interface SOPDocument {
  frontmatter: SOPFrontmatter;
  body: SOPBody;
}

/** Current OKF schema version for SOPs. */
export const OKF_SCHEMA_VERSION = "1.0.0";

/** Required frontmatter fields. */
export const OKF_REQUIRED_FIELDS: (keyof SOPFrontmatter)[] = [
  "title",
  "department",
  "execution_classification",
  "core_objective",
  "required_tools_or_skills",
  "created_at",
  "version",
  "status",
];

/** Valid execution classifications. */
export const OKF_EXECUTION_CLASSIFICATIONS: ExecutionClassification[] = [
  "Manual",
  "Hybrid",
  "Fully_Automated",
];

/** Valid SOP statuses. */
export const OKF_STATUSES: SOPStatus[] = ["draft", "published", "archived"];

/** Validation error. */
export interface OKFValidationError {
  field: string;
  message: string;
}

/**
 * Validate an SOP frontmatter against the OKF schema.
 * Returns an array of validation errors (empty when valid).
 */
export function validateSOPFrontmatter(
  fm: unknown,
): OKFValidationError[] {
  const errors: OKFValidationError[] = [];

  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    errors.push({ field: "frontmatter", message: "must be an object" });
    return errors;
  }

  const f = fm as Record<string, unknown>;

  for (const field of OKF_REQUIRED_FIELDS) {
    if (!(field in f) || f[field] === undefined || f[field] === "") {
      errors.push({ field, message: "is required" });
    }
  }

  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    errors.push({ field: "title", message: "must be a non-empty string" });
  }

  if (typeof f.department !== "string" || f.department.trim().length === 0) {
    errors.push({ field: "department", message: "must be a non-empty string" });
  }

  if (
    typeof f.execution_classification !== "string" ||
    !OKF_EXECUTION_CLASSIFICATIONS.includes(
      f.execution_classification as ExecutionClassification,
    )
  ) {
    errors.push({
      field: "execution_classification",
      message: `must be one of ${OKF_EXECUTION_CLASSIFICATIONS.join(", ")}`,
    });
  }

  if (typeof f.core_objective !== "string" || f.core_objective.trim().length === 0) {
    errors.push({ field: "core_objective", message: "must be a non-empty string" });
  }

  if (!Array.isArray(f.required_tools_or_skills)) {
    errors.push({ field: "required_tools_or_skills", message: "must be an array" });
  } else {
    for (const [i, item] of f.required_tools_or_skills.entries()) {
      if (typeof item !== "string") {
        errors.push({
          field: `required_tools_or_skills[${i}]`,
          message: "must be a string",
        });
      }
    }
  }

  if (typeof f.created_at !== "string") {
    errors.push({ field: "created_at", message: "must be an ISO-8601 string" });
  } else if (isNaN(Date.parse(f.created_at))) {
    errors.push({ field: "created_at", message: "must be a valid ISO-8601 timestamp" });
  }

  if (typeof f.version !== "string" || f.version.trim().length === 0) {
    errors.push({ field: "version", message: "must be a non-empty string" });
  }

  if (
    typeof f.status !== "string" ||
    !OKF_STATUSES.includes(f.status as SOPStatus)
  ) {
    errors.push({ field: "status", message: `must be one of ${OKF_STATUSES.join(", ")}` });
  }

  if (f.required_tools_status !== undefined) {
    if (typeof f.required_tools_status !== "object" || Array.isArray(f.required_tools_status)) {
      errors.push({ field: "required_tools_status", message: "must be an object" });
    } else {
      for (const [key, value] of Object.entries(f.required_tools_status as Record<string, unknown>)) {
        if (value !== "connected" && value !== "not_connected" && value !== "not_configured") {
          errors.push({ field: `required_tools_status.${key}`, message: `must be one of connected, not_connected, not_configured` });
        }
      }
    }
  }

  return errors;
}

/**
 * Serialize an SOPDocument to OKF markdown (frontmatter + body).
 */
export function serializeSOP(doc: SOPDocument): string {
  const { frontmatter, body } = doc;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${JSON.stringify(frontmatter.title)}`);
  lines.push(`department: ${JSON.stringify(frontmatter.department)}`);
  lines.push(`execution_classification: ${frontmatter.execution_classification}`);
  lines.push(`core_objective: ${JSON.stringify(frontmatter.core_objective)}`);
  lines.push(
    `required_tools_or_skills: ${JSON.stringify(frontmatter.required_tools_or_skills)}`,
  );
  lines.push(`created_at: ${frontmatter.created_at}`);
  lines.push(`version: ${frontmatter.version}`);
  lines.push(`status: ${frontmatter.status}`);
  if (frontmatter.required_tools_status) {
    lines.push(
      `required_tools_status: ${JSON.stringify(frontmatter.required_tools_status)}`,
    );
  }
  lines.push("---");
  lines.push("");

  lines.push("# " + frontmatter.title);
  lines.push("");

  if (body.trigger) {
    lines.push("## Trigger");
    lines.push("");
    lines.push(body.trigger);
    lines.push("");
  }

  lines.push("## Core Objective");
  lines.push("");
  lines.push(frontmatter.core_objective);
  lines.push("");

  lines.push("## Required Tools / Skills");
  lines.push("");
  if (frontmatter.required_tools_or_skills.length > 0) {
    for (const tool of frontmatter.required_tools_or_skills) {
      const status = frontmatter.required_tools_status?.[tool];
      if (status) {
        lines.push(`- ${tool} — ${status}`);
      } else {
        lines.push(`- ${tool}`);
      }
    }
  } else {
    lines.push("- None");
  }
  lines.push("");

  lines.push("## Procedural Steps");
  lines.push("");
  if (body.steps.length > 0) {
    for (const step of body.steps) {
      lines.push(`### Step ${step.step}`);
      lines.push("");
      lines.push(step.description);
      lines.push("");
      if (step.owner) {
        lines.push(`**Owner:** ${step.owner}`);
        lines.push("");
      }
      if (step.tools && step.tools.length > 0) {
        lines.push(`**Tools:** ${step.tools.join(", ")}`);
        lines.push("");
      }
      if (step.checkpoint) {
        lines.push(`**Checkpoint:** Yes — sign-off required before continuing.`);
        lines.push("");
      }
    }
  } else {
    lines.push("_No steps defined._");
    lines.push("");
  }

  if (body.exit_criteria) {
    lines.push("## Exit Criteria");
    lines.push("");
    lines.push(body.exit_criteria);
    lines.push("");
  }

  if (body.notes) {
    lines.push("## Notes");
    lines.push("");
    lines.push(body.notes);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse OKF markdown into an SOPDocument. Best-effort; frontmatter is parsed
 * from YAML-like key: value lines between `---` delimiters.
 */
export function parseSOP(markdown: string): SOPDocument | undefined {
  const lines = markdown.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return undefined;

  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd === -1) return undefined;

  const fmLines = lines.slice(1, fmEnd);
  const bodyLines = lines.slice(fmEnd + 1);

  const frontmatter: Record<string, unknown> = {};
  for (const line of fmLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    let value: unknown = rawValue;
    if (typeof rawValue === "string" && rawValue.startsWith("[") && rawValue.endsWith("]")) {
      try {
        value = JSON.parse(rawValue);
      } catch {
        // keep as string
      }
    }
    frontmatter[key] = value;
  }

  const bodyText = bodyLines.join("\n").trim();

  // Extract title from first H1
  const titleMatch = bodyText.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : String(frontmatter.title ?? "");

  // Parse steps from "### Step N" headings
  const steps: SOPStep[] = [];
  const stepRegex = /### Step (\d+)\n\n([\s\S]*?)(?=\n### Step|\n## |\Z)/g;
  let stepMatch: RegExpExecArray | null;
  while ((stepMatch = stepRegex.exec(bodyText)) !== null) {
    const stepNum = parseInt(stepMatch[1]!, 10);
    const stepText = stepMatch[2]!.trim();
    const ownerMatch = stepText.match(/\*\*Owner:\*\* (.+)/);
    const toolsMatch = stepText.match(/\*\*Tools:\*\* (.+)/);
    const checkpoint = stepText.includes("**Checkpoint:** Yes");
    steps.push({
      step: stepNum,
      description: stepText.replace(/\*\*Owner:\*\* [^\n]*/, "").replace(/\*\*Tools:\*\* [^\n]*/, "").trim(),
      owner: ownerMatch ? ownerMatch[1]!.trim() : undefined,
      tools: toolsMatch ? toolsMatch[1]!.split(",").map((t) => t.trim()) : undefined,
      checkpoint,
    });
  }

  steps.sort((a, b) => a.step - b.step);

  const fm = frontmatter as Record<string, string | string[] | undefined>;
  return {
    frontmatter: {
      title: String(fm.title ?? title),
      department: String(fm.department ?? ""),
      execution_classification: String(fm.execution_classification ?? "Manual") as ExecutionClassification,
      core_objective: String(fm.core_objective ?? ""),
      required_tools_or_skills: Array.isArray(fm.required_tools_or_skills)
        ? (fm.required_tools_or_skills as string[])
        : [],
      created_at: String(fm.created_at ?? new Date().toISOString()),
      version: String(fm.version ?? OKF_SCHEMA_VERSION),
      status: String(fm.status ?? "draft") as SOPStatus,
    },
    body: {
      steps,
      exit_criteria: undefined,
      notes: undefined,
    },
  };
}

/**
 * Build an SOPDocument from the generate_dynamic_sop tool parameters.
 * `execution_classification` shapes the step structure: Manual adds owners
 * and checkpoints; Hybrid annotates tool owners; Fully_Automated emphasizes
 * tool execution and automated checks.
 */
export function buildSOPDocument(params: {
  sop_title: string;
  target_department: string;
  execution_classification: ExecutionClassification;
  core_objective: string;
  required_tools_or_skills: string[];
  raw_procedural_steps: string;
  created_at?: string;
}): SOPDocument {
  const {
    sop_title,
    target_department,
    execution_classification,
    core_objective,
    required_tools_or_skills,
    raw_procedural_steps,
    created_at = new Date().toISOString(),
  } = params;

  const steps: SOPStep[] = [];

  // Parse raw_procedural_steps (markdown) into steps.
  // Each numbered list item or heading becomes a step.
  const stepLines = raw_procedural_steps.split(/\n+/);
  let stepIndex = 0;
  let currentDescription: string[] = [];

  for (const line of stepLines) {
    const trimmed = line.trim();
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      if (currentDescription.length > 0) {
        steps.push({
          step: ++stepIndex,
          description: currentDescription.join(" ").trim(),
          owner: execution_classification === "Manual" ? "Human operator" : undefined,
          tools:
            execution_classification !== "Manual"
              ? required_tools_or_skills.slice(0, 2)
              : undefined,
          checkpoint:
            execution_classification === "Manual" && stepIndex % 3 === 0,
        });
        currentDescription = [];
      }
      currentDescription.push(numberedMatch[2]!);
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      currentDescription.push(trimmed.slice(2).trim());
    } else if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      currentDescription.push(trimmed);
    }
  }
  if (currentDescription.length > 0) {
    steps.push({
      step: ++stepIndex,
      description: currentDescription.join(" ").trim(),
      owner: execution_classification === "Manual" ? "Human operator" : undefined,
      tools:
        execution_classification !== "Manual"
          ? required_tools_or_skills.slice(0, 2)
          : undefined,
      checkpoint:
        execution_classification === "Manual" && stepIndex % 3 === 0,
    });
  }

  if (steps.length === 0) {
    steps.push({
      step: 1,
      description: raw_procedural_steps.trim(),
      owner: execution_classification === "Manual" ? "Human operator" : undefined,
      tools:
        execution_classification !== "Manual"
          ? required_tools_or_skills.slice(0, 2)
          : undefined,
      checkpoint: execution_classification === "Manual",
    });
  }

  return {
    frontmatter: {
      title: sop_title,
      department: target_department,
      execution_classification,
      core_objective,
      required_tools_or_skills,
      created_at,
      version: OKF_SCHEMA_VERSION,
      status: "draft",
    },
    body: {
      steps,
      exit_criteria:
        execution_classification === "Fully_Automated"
          ? "All automated steps complete without error; output artifact verified."
          : execution_classification === "Hybrid"
            ? "All steps complete; human sign-off obtained at checkpoints."
            : "All steps complete; human operator confirms the objective is met.",
      notes:
        execution_classification === "Manual"
          ? "This SOP requires human execution at every step. Checkpoints require sign-off before continuing."
          : execution_classification === "Hybrid"
            ? "This SOP mixes human and automated steps. Automated steps reference tools in `required_tools_or_skills`."
            : "This SOP is fully automated. Human intervention is only required for exceptions.",
    },
  };
}
