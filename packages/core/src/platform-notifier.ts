/**
 * Slack notification channel for platform-team HITL approvals.
 * Uses Slack incoming webhook to post approval requests with interactive buttons.
 * Button clicks are handled by the /platform/webhooks/slack endpoint.
 */
import type { PlatformApproval } from "./platform-approvals.js";

export interface SlackChannelConfig {
  webhookUrl: string;
  channel?: string;
}

export class SlackChannel {
  private readonly webhookUrl: string;
  private readonly channel: string;

  constructor(config: SlackChannelConfig) {
    this.webhookUrl = config.webhookUrl;
    this.channel = config.channel ?? "#platform-approvals";
  }

  async send(approval: PlatformApproval): Promise<{ ref: string; sent: boolean }> {
    const payload = {
      channel: this.channel,
      username: "Instinct Platform",
      icon_emoji: ":robot_face:",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🤖 Platform Approval Required", emoji: true },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Change:*\\n${approval.summary}` },
            { type: "mrkdwn", text: `*Target:*\\n${approval.target}` },
            { type: "mrkdwn", text: `*Capability:*\\n${approval.capability}` },
            { type: "mrkdwn", text: `*Requested by:*\\n${approval.requestedBy}` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Token:* \`${approval.token}\`  |  *Expires:* ${approval.expiresAt}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✅ Approve", emoji: true },
              style: "primary",
              action_id: "platform_approve",
              value: approval.token,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "❌ Deny", emoji: true },
              style: "danger",
              action_id: "platform_deny",
              value: approval.token,
            },
          ],
        },
      ],
    };

    try {
      const resp = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        return { ref: "", sent: false };
      }
      // Slack webhooks return "ok" text, not a message ID. Use timestamp as ref.
      const ref = `${Date.now()}`;
      return { ref, sent: true };
    } catch {
      return { ref: "", sent: false };
    }
  }

  async resolve(ref: string, action: "approve" | "deny", resolvedBy: string, token: string): Promise<void> {
    // Slack webhooks are one-way; resolution is tracked server-side.
    // If using Slack Bolt app, we'd update the original message here.
    // For webhook-only mode, we send a follow-up message.
    const emoji = action === "approve" ? "✅" : "❌";
    const payload = {
      channel: this.channel,
      username: "Instinct Platform",
      icon_emoji: ":robot_face:",
      text: `${emoji} Platform approval ${token} ${action}d by ${resolvedBy}.`,
    };
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort notification
    }
  }
}
