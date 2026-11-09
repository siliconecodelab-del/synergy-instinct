/**
 * Maritime API client for calling an instinct agent's /chat endpoint.
 */

export interface MaritimeConfig {
  baseUrl: string;       // https://api.maritime.sh
  apiKey: string;        // Maritime API key
  agentId: string;       // Maritime agent ID (resolved at runtime)
  externalId: string;    // Gateway user ID (used to find agent)
  chatToken?: string;    // INSTINCT_CHAT_TOKEN for agent auth
}

export class MaritimeClient {
  private config: MaritimeConfig;
  private resolvedAgentId: string | null = null;

  constructor(config: MaritimeConfig) {
    this.config = config;
  }

  /**
   * Resolve the Maritime agent ID from the external ID (gateway user ID).
   * Maritime agents are created with externalId = gateway user ID.
   */
  async resolveAgentId(): Promise<string> {
    if (this.resolvedAgentId) return this.resolvedAgentId;
    if (this.config.agentId) {
      this.resolvedAgentId = this.config.agentId;
      return this.resolvedAgentId;
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/api/agents?externalId=${encodeURIComponent(this.config.externalId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to resolve agent: ${res.status}`);
    }

    const data = (await res.json()) as any;
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const agent = items.find((a: any) => a.externalId === this.config.externalId && a.id);

    if (!agent) {
      throw new Error(`No Maritime agent found for externalId: ${this.config.externalId}`);
    }

    this.resolvedAgentId = agent.id as string;
    return this.resolvedAgentId as string;
  }

  async chat(message: string, conversationId: string, source: string = "open-webui"): Promise<{
    response: string;
    acked: boolean;
    conversationKey?: string;
    blocked?: string;
    pending?: string[];
  }> {
    const agentId = await this.resolveAgentId();
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(agentId)}/chat`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const body = {
      message,
      source,
      conversation_id: conversationId,
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Maritime chat failed: ${res.status} ${text.slice(0, 200)}`);
    }

    return (await res.json()) as {
      response: string;
      acked: boolean;
      conversationKey?: string;
      blocked?: string;
      pending?: string[];
    };
  }

  async health(): Promise<boolean> {
    try {
      const agentId = await this.resolveAgentId();
      const url = `${this.config.baseUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(agentId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Create a MaritimeClient from environment variables.
 */
export function createMaritimeClientFromEnv(): MaritimeClient {
  const baseUrl = process.env.MARITIME_API_URL || "https://api.maritime.sh";
  const apiKey = process.env.MARITIME_API_KEY || "";
  const externalId = process.env.MARITIME_EXTERNAL_ID || process.env.MARITIME_AGENT_ID || "";
  const chatToken = process.env.INSTINCT_CHAT_TOKEN;

  if (!externalId) {
    throw new Error("MARITIME_EXTERNAL_ID (or MARITIME_AGENT_ID) is required");
  }

  return new MaritimeClient({ baseUrl, apiKey, agentId: "", externalId, chatToken });
}