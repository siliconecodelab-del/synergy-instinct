/**
 * Idempotency scratchpad for AgentRun workflows.
 *
 * State-changing workflow steps (tool calls, node executions, judge decisions)
 * can be keyed by an idempotency key. Before executing, the runner checks the
 * scratchpad for an existing result; if found, it returns the cached result
 * instead of re-running. After executing, the result is recorded so a retry
 * reuses it — making workflow steps idempotent by default.
 *
 * Storage: <data>/agentrun/scratchpad/<hash>.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "@open-instinct/core";

/** Safe filename fragment from an idempotency key. */
function safeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface ScratchpadEntry<T = unknown> {
  key: string;
  createdAt: string;
  result: T;
}

/** Result of a claim: true when the key was freshly reserved, false when a result already exists. */
export type ClaimResult = { ok: true; fresh: true } | { ok: true; fresh: false; result: unknown } | { ok: false; reason: string };

export class Scratchpad {
  private readonly dir: string;

  constructor(stateDir: StateDir) {
    this.dir = stateDir.path("agentrun", "scratchpad");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(key: string): string {
    return join(this.dir, `${safeKey(key)}.json`);
  }

  /** Reserve a key before executing a state-changing step.
   * Returns `{fresh: true}` when no result exists yet (safe to proceed),
   * or `{fresh: false, result}` when a cached result already exists (skip execution). */
  claim<T = unknown>(key: string): ClaimResult {
    const file = this.file(key);
    if (existsSync(file)) {
      try {
        const entry = JSON.parse(readFileSync(file, "utf8")) as ScratchpadEntry<T>;
        if (entry.result !== null && entry.result !== undefined) {
          return { ok: true, fresh: false, result: entry.result };
        }
      } catch {
        // Corrupt entry: treat as unclaimed and overwrite below.
      }
    }
    writeFileSync(
      file,
      JSON.stringify({ key, createdAt: new Date().toISOString(), result: null }, null, 2) + "\n",
      "utf8",
    );
    return { ok: true, fresh: true };
  }

  /** Return the cached result for this key, or undefined when not recorded. */
  lookup<T = unknown>(key: string): T | undefined {
    const file = this.file(key);
    if (!existsSync(file)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as ScratchpadEntry<T>;
      return entry.result === null || entry.result === undefined ? undefined : (entry.result as T);
    } catch {
      return undefined;
    }
  }

  /** Record the result for this key. Overwrites any existing entry. */
  record<T = unknown>(key: string, result: T): void {
    writeFileSync(
      this.file(key),
      JSON.stringify({ key, createdAt: new Date().toISOString(), result }, null, 2) + "\n",
      "utf8",
    );
  }

  /** Remove the entry for this key. Returns true when removed. */
  clear(key: string): boolean {
    const file = this.file(key);
    if (!existsSync(file)) return false;
    try {
      require("node:fs").unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /** List all recorded keys. */
  list(): string[] {
    let entries: string[];
    try {
      entries = require("node:fs").readdirSync(this.dir);
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(require("node:fs").readFileSync(join(this.dir, e), "utf8")) as { key?: string };
        if (entry.key) keys.push(entry.key);
      } catch {
        // skip unreadable entries
      }
    }
    return keys.sort();
  }
}
