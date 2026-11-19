/**
 * Platform-approval override store. Per-agent overrides of platform-level
 * platform-approval decisions. Stored under <state>/platform-overrides.json.
 *
 * Each override records that a specific agent (identified by its stateDir)
 * has chosen to deviate from the global platform-approved default for a given
 * (target, capability) pair.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "./state.js";

const FILE = "platform-overrides.json";

export interface PlatformOverride {
  /** Unique id for this override record. */
  id: string;
  /** Target being overridden: agent_prompt, sop_content, execution_mode. */
  target: "agent_prompt" | "sop_content" | "execution_mode";
  /** Capability being overridden (e.g. "agent.prompt.change"). */
  capability: string;
  /** The overridden value the agent wants instead of the global default. */
  overriddenValue: Record<string, unknown>;
  /** Human-readable reason for the override. */
  reason: string;
  /** When the override was created. */
  createdAt: string;
  /** When the override was last updated. */
  updatedAt: string;
  /** Whether the override is currently active. */
  active: boolean;
}

export interface PlatformOverrideStore {
  /** List all active overrides for this agent's stateDir. */
  list(): PlatformOverride[];
  /** Get a specific override by target + capability. */
  get(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): PlatformOverride | undefined;
  /** Create or update an override. */
  set(override: Omit<PlatformOverride, "id" | "createdAt" | "updatedAt"> & { id?: string }): PlatformOverride;
  /** Remove an override (revert to global default). */
  remove(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): boolean;
}

export function createPlatformOverrideStore(state: StateDir): PlatformOverrideStore {
  const filePath = state.path(FILE);

  function load(): PlatformOverride[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf8");
      return JSON.parse(raw) as PlatformOverride[];
    } catch {
      return [];
    }
  }

  function save(list: PlatformOverride[]): void {
    const dir = state.path();
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(list, null, 2) + "\n", "utf8");
  }

  return {
    list(): PlatformOverride[] {
      return load().filter((a) => a.active);
    },

    get(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): PlatformOverride | undefined {
      return load().find((a) => a.active && a.target === target && a.capability === capability);
    },

    set(override: Omit<PlatformOverride, "id" | "createdAt" | "updatedAt"> & { id?: string }): PlatformOverride {
      const list = load();
      const now = new Date().toISOString();
      const existingIndex = list.findIndex(
        (a) => a.target === override.target && a.capability === override.capability
      );

      const record: PlatformOverride = {
        id: override.id ?? `override-${Date.now()}`,
        target: override.target,
        capability: override.capability,
        overriddenValue: override.overriddenValue,
        reason: override.reason,
        createdAt: now,
        updatedAt: now,
        active: true,
      };

      if (existingIndex >= 0) {
        const existing = list[existingIndex];
        if (!existing) return record; // should not happen
        record.createdAt = existing.createdAt;
        list[existingIndex] = record;
      } else {
        list.push(record);
      }

      save(list);
      return { ...record };
    },

    remove(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): boolean {
      const list = load();
      const index = list.findIndex((a) => a.active && a.target === target && a.capability === capability);
      if (index < 0) return false;
      const existing = list[index];
      if (!existing) return false;
      list[index] = { ...existing, active: false, updatedAt: new Date().toISOString() };
      save(list);
      return true;
    },
  };
}