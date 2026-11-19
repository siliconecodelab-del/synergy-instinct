/**
 * Platform-override tool. Allows agents (owners) to set, view, and clear
 * per-agent overrides of platform-approved defaults.
 *
 * Overrides let an individual agent deviate from a platform-wide decision
 * (e.g., using a different execution mode or tool description) without
 * affecting other agents.
 */
import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolResultLike } from "@open-instinct/core";
import type { StateDir } from "@open-instinct/core";
import { createPlatformOverrideManager } from "@open-instinct/core";

export function platformOverrideTool(deps: {
  stateDir: StateDir;
}): RegisteredTool {
  const { stateDir } = deps;

  // We need platformApprovals to resolve global defaults, but for override
  // management we only need the override store. We'll create the manager
  // with a minimal platformApprovals stub for list/set/clear operations.
  const manager = createPlatformOverrideManager(stateDir, {
    pending: () => [],
    get: () => undefined,
    create: () => ({} as any),
    resolve: () => ({} as any),
    markNotified: () => {},
  } as any);

  return defineTool({
    name: "platform_override",
    label: "Platform Override",
    description:
      "Manage per-agent overrides of platform-approved defaults. Actions: " +
      "list (show active overrides), set (override a platform-approved default), " +
      "clear (remove an override, reverting to global default).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("set"),
        Type.Literal("clear"),
      ]),
      target: Type.Optional(
        Type.Union([
          Type.Literal("agent_prompt"),
          Type.Literal("sop_content"),
          Type.Literal("execution_mode"),
        ])
      ),
      capability: Type.Optional(Type.String({ description: "Capability being overridden (e.g. 'agent.prompt.change')." })),
      overriddenValue: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "The overridden value to use instead of the global default." })),
      reason: Type.Optional(Type.String({ description: "Human-readable reason for the override." })),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (a) => `platform_override ${(a as { action?: string }).action ?? ""}`,
    },
    execute: async (args) => {
      const a = args as {
        action: "list" | "set" | "clear";
        target?: "agent_prompt" | "sop_content" | "execution_mode";
        capability?: string;
        overriddenValue?: Record<string, unknown>;
        reason?: string;
      };

      if (a.action === "list") {
        const overrides = manager.listOverrides();
        if (overrides.length === 0) {
          return { content: [{ type: "text", text: "No active platform overrides." }] };
        }
        const lines = ["Active platform overrides:", ""];
        for (const o of overrides) {
          lines.push(`  Target: ${o.target}`);
          lines.push(`  Capability: ${o.capability}`);
          lines.push(`  Reason: ${o.reason}`);
          lines.push(`  Overridden value: ${JSON.stringify(o.overriddenValue)}`);
          lines.push(`  Created: ${o.createdAt}`);
          lines.push(`  Updated: ${o.updatedAt}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (a.action === "set") {
        if (!a.target || !a.capability) {
          return { content: [{ type: "text", text: "target and capability are required for set." }], isError: true };
        }
        if (!a.overriddenValue) {
          return { content: [{ type: "text", text: "overriddenValue is required for set." }], isError: true };
        }
        manager.setOverride(a.target, a.capability, a.overriddenValue, a.reason ?? "No reason provided");
        return { content: [{ type: "text", text: `Override set for ${a.target}/${a.capability}.` }] };
      }

      if (a.action === "clear") {
        if (!a.target || !a.capability) {
          return { content: [{ type: "text", text: "target and capability are required for clear." }], isError: true };
        }
        const removed = manager.removeOverride(a.target, a.capability);
        if (!removed) {
          return { content: [{ type: "text", text: `No active override found for ${a.target}/${a.capability}.` }] };
        }
        return { content: [{ type: "text", text: `Override cleared for ${a.target}/${a.capability}. Reverting to global default.` }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${a.action}` }], isError: true };
    },
  });
}
