/**
 * Code-level persistence for pipeline runs.
 *
 * Mirrors `WorkflowStore`: one JSON file per pipeline under
 * `<state>/agentrun/pipelines/`. Replaces the older file-based records under
 * `/data/Company-brain/pipelines/` (migrated on first use).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";

export interface PipelineStageRecord {
  status: "pending" | "done" | "passed" | "failed" | "created" | "skipped";
  path?: string;
  root?: string;
  checks?: number;
  html?: string;
  name?: string;
  reason?: string;
  updatedAt?: string;
}

export interface PipelineSchedule {
  cron: string;
  jobId: string;
}

export interface PipelineRecord {
  id: string;
  sop: string;
  mode: "auto" | "guided";
  stages: {
    sop?: PipelineStageRecord;
    icm?: PipelineStageRecord;
    trace?: PipelineStageRecord;
    dsl?: PipelineStageRecord;
  };
  lastPrompt?: string;
  lastRun?: string | null;
  schedule?: PipelineSchedule | null;
  createdAt: string;
  updatedAt: string;
}

export class PipelineStore {
  readonly dir: string;

  constructor(state: StateDir) {
    this.dir = state.path("agentrun", "pipelines");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  get(id: string): PipelineRecord | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as PipelineRecord;
    } catch {
      return undefined;
    }
  }

  list(): PipelineRecord[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: PipelineRecord[] = [];
    for (const name of entries) {
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as PipelineRecord);
      } catch {
        // skip corrupt
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  bySop(sop: string): PipelineRecord | undefined {
    return this.list().find((r) => r.sop === sop);
  }

  save(record: PipelineRecord): PipelineRecord {
    const now = new Date().toISOString();
    const next: PipelineRecord = { ...record, updatedAt: now };
    if (!next.createdAt) next.createdAt = now;
    const tmp = `${this.file(next.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file(next.id));
    return next;
  }

  remove(id: string): boolean {
    const f = this.file(id);
    if (!existsSync(f)) return false;
    try {
      unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }
}