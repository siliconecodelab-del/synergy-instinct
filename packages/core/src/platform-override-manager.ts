/**
 * Platform-override manager. Resolves the effective configuration value for a
 * given (target, capability) pair by checking for a per-agent override first,
 * then falling back to the global platform-approved default.
 *
 * Usage:
 *   const manager = createPlatformOverrideManager(stateDir, platformApprovals);
 *   const effective = manager.resolve("execution_mode", "execution.mode.route");
 *   // effective.value -> the value to use
 *   effective.source === "override" || effective.source === "global"
 */
import type { StateDir } from "./state.js";
import { PlatformApprovalStore, type PlatformApproval } from "./platform-approvals.js";
import { createPlatformOverrideStore, type PlatformOverride } from "./platform-override-store.js";

export interface OverrideResolution {
  /** The effective value to use. */
  value: Record<string, unknown>;
  /** Where the value came from: "override" (local) or "global" (platform-approved). */
  source: "override" | "global";
  /** The override record if source is "override", otherwise undefined. */
  override: PlatformOverride | undefined;
  /** The global default if source is "override", otherwise undefined. */
  globalDefault: PlatformApproval | undefined;
}

export interface PlatformOverrideManager {
  /** Resolve the effective value for a (target, capability) pair. */
  resolve(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): OverrideResolution;
  /** List all active overrides for this agent. */
  listOverrides(): PlatformOverride[];
  /** Set an override for a (target, capability) pair. */
  setOverride(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string, overriddenValue: Record<string, unknown>, reason: string): void;
  /** Remove an override, reverting to the global default. */
  removeOverride(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): boolean;
}

export function createPlatformOverrideManager(
  stateDir: StateDir,
  platformApprovals: PlatformApprovalStore
): PlatformOverrideManager {
  const overrideStore = createPlatformOverrideStore(stateDir);

  return {
    resolve(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): OverrideResolution {
      const override = overrideStore.get(target, capability);
      const globalDefault = platformApprovals.findByTargetCapability(target, capability);

      if (override) {
        return {
          value: override.overriddenValue,
          source: "override",
          override,
          globalDefault,
        };
      }

      return {
        value: globalDefault ? globalDefault.payload : {},
        source: "global",
        override: undefined,
        globalDefault,
      };
    },

    listOverrides(): PlatformOverride[] {
      return overrideStore.list();
    },

    setOverride(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string, overriddenValue: Record<string, unknown>, reason: string): void {
      overrideStore.set({
        target,
        capability,
        overriddenValue,
        reason,
        active: true,
      });
    },

    removeOverride(target: "agent_prompt" | "sop_content" | "execution_mode", capability: string): boolean {
      return overrideStore.remove(target, capability);
    },
  };
}