/**
 * Platform-team approval tool. Separate from owner approvals: gates changes
 * that affect ALL users (agent prompt changes, execution-mode routing).
 * Notifications go to Slack (and optionally Linear/email).
 */
import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolResultLike } from "@open-instinct/core";
import type { StateDir } from "@open-instinct/core";
import { PlatformApprovalStore } from "@open-instinct/core";
import { existsSync } from "node:fs";

export function platformApproveTool(deps: {
  stateDir: StateDir;
  slackWebhookUrl?: string;
}): RegisteredTool {
  const { stateDir, slackWebhookUrl } = deps;
  const store = new PlatformApprovalStore(stateDir);

  return defineTool({
    name: "platform_approve",
    label: "Platform Approval",
    description:
      "Review and resolve platform-team approval requests. Actions: " +
      "list (show pending approvals), approve (approve a pending request by token), " +
      "deny (deny a pending request by token), history (show resolved approvals).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("approve"),
        Type.Literal("deny"),
        Type.Literal("history"),
      ]),
      token: Type.Optional(Type.String({ description: "4-character approval token." })),
      resolved_by: Type.Optional(Type.String({ description: "Who is resolving (default: platform-team)." })),
    }),
    meta: {
      capabilities: ["converse"],
      group: "system",
      describe: (a) => `platform_approve ${(a as { action?: string }).action ?? ""} ${(a as { token?: string }).token ?? ""}`,
    },
    execute: async (args) => {
      const a = args as {
        action: "list" | "approve" | "deny" | "history";
        token?: string;
        resolved_by?: string;
      };

      if (a.action === "list") {
        const pending = store.pending();
        if (pending.length === 0) {
          return okResult("No pending platform approvals.");
        }
        const lines = [`Pending platform approvals (${pending.length}):`, ""];
        for (const p of pending) {
          lines.push(`  Token: ${p.token} | Target: ${p.target} | ${p.summary}`);
          lines.push(`    Capability: ${p.capability} | Expires: ${p.expiresAt}`);
          lines.push(`    Channels: ${p.channels.join(", ") || "none"}`);
          lines.push("");
        }
        return okResult(lines.join("\n"));
      }

      if (a.action === "history") {
        const all = store.pending(); // pending only for now
        // Also read resolved from file
        return okResult(`Pending: ${all.length}. Use 'list' for details.`);
      }

      if (!a.token) {
        return errResult("token is required for approve/deny.");
      }

      const resolvedBy = a.resolved_by ?? "platform-team";
      const approved = a.action === "approve";

      const result = store.resolve(a.token, approved, resolvedBy);
      if (!result) {
        return errResult(`Approval ${a.token} not found or already resolved.`);
      }

      if (result.status === "expired") {
        return errResult(`Approval ${a.token} has expired.`);
      }

      const lines = [
        `${approved ? "Approved" : "Denied"}: ${result.summary}`,
        `Resolved by: ${resolvedBy} at ${result.resolvedAt}`,
        `Target: ${result.target}`,
      ];

      if (approved) {
        lines.push("", "Next: apply the approved change (update tool descriptions, routing logic, etc.).");
      }

      return okResult(lines.join("\n"));
    },
  });
}

function okResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

function errResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}
