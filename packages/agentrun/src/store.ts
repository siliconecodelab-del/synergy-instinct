/**
 * Workflow file store for Open Instinct + AgentRun.
 *
 * Workflow JSON documents live under `<data>/workflows/`. Each file is one
 * workflow, named by its file stem. This is the agent's personal workflow
 * library: the agent can save drafts it authors and load them later to run.
 */
import { StateDir } from "@open-instinct/core";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export class WorkflowStore {
  private readonly stateDir: StateDir;

  constructor(stateDir: StateDir) {
    this.stateDir = stateDir;
  }

  private dir(): string {
    const dir = this.stateDir.path("workflows");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Save a workflow document under `<data>/workflows/<name>.json`. */
  save(name: string, workflow: unknown): void {
    const file = join(this.dir(), `${name}.json`);
    writeFileSync(file, JSON.stringify(workflow, null, 2) + "\n", "utf8");
  }

  /** Load a saved workflow by name. Returns undefined when not found. */
  load(name: string): unknown | undefined {
    const file = join(this.dir(), `${name}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  /** List all saved workflow names. */
  list(): string[] {
    const dir = this.dir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => basename(e, ".json"))
      .sort();
  }

  /** Remove a saved workflow by name. Returns true when removed. */
  remove(name: string): boolean {
    const file = join(this.dir(), `${name}.json`);
    if (!existsSync(file)) return false;
    try {
      require("node:fs").unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
