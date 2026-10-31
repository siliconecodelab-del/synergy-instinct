/**
 * Code-level persistence for pipeline runs.
 *
 * Mirrors `WorkflowStore`: one JSON file per pipeline under
 * `<state>/agentrun/pipelines/`. Replaces the older file-based records under
 * `/data/Company-brain/pipelines/` (migrated on first use).
 *
 * Concurrency: every save/remove acquires an exclusive per-record lock file
 * (`<id>.lock`) so concurrent turns cannot clobber each other.
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

/** Legacy record shape (pre-Store, under /data/Company-brain/pipelines/). */
export interface LegacyPipelineRecord {
  id?: string;
  sop?: string;
  mode?: string;
  stages?: Record<string, unknown>;
  lastPrompt?: string;
  lastRun?: string | null;
  schedule?: PipelineSchedule | null;
  createdAt?: string;
  updatedAt?: string;
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

  private lockFile(id: string): string {
    return join(this.dir, `${id}.lock`);
  }

  /** Acquire an exclusive lock for a record id. Returns a releaser. */
  acquireLock(id: string): { release: () => void } {
    const lock = this.lockFile(id);
    // Spin briefly waiting for the lock to clear (max ~2s).
    for (let i = 0; i < 40; i++) {
      if (!existsSync(lock)) {
        try {
          writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" });
          return { release: () => { try { unlinkSync(lock); } catch { /* ignore */ } } };
        } catch {
          // File created between existsSync and writeFileSync; retry.
        }
      }
      // Busy-wait 50ms
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }
    }
    throw new Error(`could not acquire lock for pipeline ${id} within timeout`);
  }

  /** Migrate legacy pipeline records from /data/Company-brain/pipelines/ into this store. */
  migrateLegacyRecords(state: StateDir): { imported: number; skipped: number } {
    const legacyDir = state.path("Company-brain", "pipelines");
    if (!existsSync(legacyDir)) return { imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;

    try {
      const entries = readdirSync(legacyDir).filter((n) => n.endsWith(".json"));
      for (const name of entries) {
        try {
          const raw = readFileSync(join(legacyDir, name), "utf8");
          const legacy = JSON.parse(raw) as LegacyPipelineRecord;
          const id = legacy.id || name.replace(/\.json$/, "");
          const existing = this.get(id);
          if (existing) {
            skipped++;
            continue;
          }
          const record: PipelineRecord = {
            id,
            sop: legacy.sop || id,
            mode: (legacy.mode === "guided" ? "guided" : "auto"),
            stages: {},
            lastPrompt: legacy.lastPrompt,
            lastRun: legacy.lastRun ?? null,
            schedule: legacy.schedule ?? null,
            createdAt: legacy.createdAt || new Date().toISOString(),
            updatedAt: legacy.updatedAt || new Date().toISOString(),
          };
          // Normalize legacy stages if they exist as a record
          if (legacy.stages && typeof legacy.stages === "object") {
            for (const [k, v] of Object.entries(legacy.stages)) {
              if (k === "sop" || k === "icm" || k === "trace" || k === "dsl") {
                record.stages[k] = v as PipelineStageRecord;
              }
            }
          }
          this.save(record);
          imported++;
        } catch {
          skipped++;
        }
      }
    } catch {
      // legacy dir unreadable; skip migration
    }

    return { imported, skipped };
  }

  /** Clean up old pipeline records beyond maxAgeDays. Returns count removed. */
  retention(maxAgeDays: number): { removedPipelines: number } {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removedPipelines = 0;

    try {
      const entries = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
      for (const name of entries) {
        try {
          const rec = this.get(name.replace(/\.json$/, ""));
          if (rec && new Date(rec.updatedAt).getTime() < cutoff) {
            this.remove(rec.id);
            removedPipelines++;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    return { removedPipelines };
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
    const { release } = this.acquireLock(record.id);
    try {
      const now = new Date().toISOString();
      const next: PipelineRecord = { ...record, updatedAt: now };
      if (!next.createdAt) next.createdAt = now;
      const tmp = `${this.file(next.id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.file(next.id));
      return next;
    } finally {
      release();
    }
  }

  remove(id: string): boolean {
    const { release } = this.acquireLock(id);
    try {
      const f = this.file(id);
      if (!existsSync(f)) return false;
      try {
        unlinkSync(f);
        return true;
      } catch {
        return false;
      }
    } finally {
      release();
    }
  }
}