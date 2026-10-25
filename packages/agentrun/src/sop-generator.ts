/**
 * SOP generator. Writes OKF-compliant SOP markdown files into the company
 * brain repository at:
 *
 *   <data>/Company-brain/SOPs/<department-kebab>/<sop-title-kebab>.md
 *
 * The generator creates intermediate directories, refuses to overwrite an
 * existing SOP (caller must confirm first), and returns the absolute path
 * of the written file.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";
import type { SOPDocument, ComposioLike, ToolConnectionStatus } from "./sop-okf.js";
import { serializeSOP } from "./sop-okf.js";

/** The company brain root directory relative to the state dir. */
export const COMPANY_BRAIN_ROOT = "Company-brain";

/** The SOPs directory under the company brain root. */
export const SOPS_DIR = "SOPs";

/** Convert a string to a kebab-case directory/file name segment. */
export function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-+$)/g, "")
    .replace(/-+/g, "-");
}

/** Resolve the full path for an SOP file. */
export function resolveSOPPath(
  stateDir: StateDir,
  department: string,
  sopTitle: string,
): string {
  const deptDir = kebabCase(department);
  const fileName = `${kebabCase(sopTitle)}.md`;
  return stateDir.path(COMPANY_BRAIN_ROOT, SOPS_DIR, deptDir, fileName);
}

/** List all existing SOP files under the company brain SOPs directory. */
export function listSOPs(stateDir: StateDir): string[] {
  const sopsRoot = stateDir.path(COMPANY_BRAIN_ROOT, SOPS_DIR);
  if (!existsSync(sopsRoot)) return [];

  const result: string[] = [];
  const deptDirs = readdirSync(sopsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dept of deptDirs) {
    const deptPath = join(sopsRoot, dept);
    const files = readdirSync(deptPath).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      result.push(join(dept, file));
    }
  }
  return result.sort();
}

/**
 * Write an SOP document to disk. Fails if the target file already exists
 * (to prevent accidental overwrites — the caller must delete or confirm
 * before retrying).
 */
export function writeSOP(
  stateDir: StateDir,
  doc: SOPDocument,
): { path: string; created: boolean } {
  const targetPath = resolveSOPPath(
    stateDir,
    doc.frontmatter.department,
    doc.frontmatter.title,
  );

  if (existsSync(targetPath)) {
    throw new Error(
      `SOP already exists at ${targetPath}. Delete or rename the existing file before writing again.`,
    );
  }

  const dir = stateDir.path(
    COMPANY_BRAIN_ROOT,
    SOPS_DIR,
    kebabCase(doc.frontmatter.department),
  );
  mkdirSync(dir, { recursive: true });

  const markdown = serializeSOP(doc);
  writeFileSync(targetPath, markdown, "utf8");

  return { path: targetPath, created: true };
}

/**
 * Check which of the SOP's required tools are connected via Composio.
 * Returns a map of tool slug -> connection status.
 * When `composio` is absent (no COMPOSIO_API_KEY), all tools are "not_configured".
 */
export async function checkToolAvailability(
  doc: SOPDocument,
  composio?: ComposioLike,
): Promise<Record<string, ToolConnectionStatus>> {
  const status: Record<string, ToolConnectionStatus> = {};

  if (!composio) {
    for (const tool of doc.frontmatter.required_tools_or_skills) {
      status[tool] = "not_configured";
    }
    return status;
  }

  const connected = await composio.connectedToolkits();
  const connectedSet = new Set(connected.map((c) => c.slug.toLowerCase()));
  const configuredSet = new Set(composio.toolkitSlugs.map((s) => s.toLowerCase()));

  for (const tool of doc.frontmatter.required_tools_or_skills) {
    const slug = tool.trim().toLowerCase();
    if (connectedSet.has(slug)) {
      status[tool] = "connected";
    } else if (configuredSet.has(slug) || composio.allToolkits) {
      status[tool] = "not_connected";
    } else {
      status[tool] = "not_configured";
    }
  }

  return status;
}

/**
 * Update an SOPDocument's frontmatter with tool connection status.
 * Returns the updated document.
 */
export function updateSOPToolStatus(
  doc: SOPDocument,
  status: Record<string, ToolConnectionStatus>,
): SOPDocument {
  return {
    ...doc,
    frontmatter: {
      ...doc.frontmatter,
      required_tools_status: status,
    },
  };
}

/**
 * Get the OAuth connect link for a tool, if available.
 * Returns undefined when the tool is already connected or not configured.
 */
export async function getToolConnectLink(
  tool: string,
  composio: ComposioLike,
): Promise<string | undefined> {
  const slug = tool.trim().toLowerCase();
  const connected = await composio.connectedToolkits();
  const alreadyConnected = connected.some((c) => c.slug.toLowerCase() === slug);
  if (alreadyConnected) return undefined;
  if (!composio.allToolkits && !composio.toolkitSlugs.map((s) => s.toLowerCase()).includes(slug)) {
    return undefined;
  }
  return composio.connectLink(tool);
}
