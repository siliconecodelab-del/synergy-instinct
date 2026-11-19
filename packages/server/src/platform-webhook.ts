/**
 * Platform webhook endpoints for Slack interactive button callbacks.
 * Handles approve/deny actions from Slack messages.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PlatformApprovalStore } from "@open-instinct/core";
import { SlackChannel } from "@open-instinct/core";
import type { StateDir } from "@open-instinct/core";

export interface PlatformWebhookDeps {
  stateDir: StateDir;
  slackWebhookUrl?: string;
  onResolved?: (token: string, action: "approve" | "deny", resolvedBy: string) => void;
}

export function handleSlackWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PlatformWebhookDeps,
): void {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body) as {
        type?: string;
        actions?: Array<{ action_id: string; value: string }>;
        user?: { name?: string; id?: string };
      };

      if (payload.type === "url_verification") {
        // Slack URL verification challenge
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: (payload as any).challenge }));
        return;
      }

      if (!payload.actions || payload.actions.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const action = payload.actions[0]!;
      const token = action.value;
      const actionId = action.action_id;
      const resolvedBy = payload.user?.name ?? payload.user?.id ?? "slack-user";

      const store = new PlatformApprovalStore(deps.stateDir);
      const approved = actionId === "platform_approve";

      const result = store.resolve(token, approved, resolvedBy);
      if (!result) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Approval not found or already resolved" }));
        return;
      }

      // Notify Slack channel of resolution
      if (deps.slackWebhookUrl) {
        const slack = new SlackChannel({ webhookUrl: deps.slackWebhookUrl });
        slack.resolve(result.notificationRefs["slack"] ?? "", approved ? "approve" : "deny", resolvedBy, token).catch(() => {});
      }

      // Callback for applying changes
      deps.onResolved?.(token, approved ? "approve" : "deny", resolvedBy);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: result.status }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
    }
  });
}

export function isPlatformWebhookPath(pathname: string): boolean {
  return pathname === "/platform/webhooks/slack";
}
