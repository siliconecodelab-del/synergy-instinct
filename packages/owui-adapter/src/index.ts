/**
 * OpenAI-compatible adapter for Open WebUI → Instinct agent bridge.
 *
 * Exposes:
 *   POST /v1/chat/completions  — OpenAI-compatible chat endpoint
 *   GET  /v1/models             — List available models (queried from Supabase)
 *   GET  /health                — Health check
 *
 * Internally calls Maritime's /chat endpoint for the configured agent.
 *
 * Auth model:
 *   - If Open WebUI forwards a user ID (X-User-Id / x-user-id / x-webui-user-id),
 *     the adapter verifies the user owns the requested instinct agent via Supabase.
 *   - If no user ID is forwarded, falls back to the shared ADAPTER_TOKEN for
 *     backward compatibility.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { MaritimeClient } from "./maritime.js";
import {
  type OpenAIChatRequest,
  type OpenAIChatResponse,
  type OpenAIChatChunk,
  openAIToInstinct,
  instinctToOpenAI,
  instinctToOpenAIChunk,
  extractConversationId,
} from "./translator.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const ADAPTER_TOKEN = process.env.ADAPTER_TOKEN || "";
const MARITIME_API_URL = process.env.MARITIME_API_URL || "https://api.maritime.sh";
const MARITIME_API_KEY = process.env.MARITIME_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Cache of MaritimeClient instances by external ID
const clientCache = new Map<string, MaritimeClient>();

function getMaritimeClient(externalId: string): MaritimeClient {
  let client = clientCache.get(externalId);
  if (!client) {
    client = new MaritimeClient({
      baseUrl: MARITIME_API_URL,
      apiKey: MARITIME_API_KEY,
      agentId: "",
      externalId,
    });
    clientCache.set(externalId, client);
  }
  return client;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Extract the Open WebUI user ID from forwarded headers.
 * Open WebUI forwards user info via headers such as X-User-Id,
 * x-webui-user-id, or x-user-id when ENABLE_FORWARD_USER_INFO_HEADERS is set.
 */
function getForwardedUserId(req: http.IncomingMessage): string | undefined {
  const headers = req.headers;
  const candidateKeys = [
    "x-user-id",
    "x-webui-user-id",
    "x-open-webui-user-id",
    "x-forwarded-user",
  ];
  for (const key of candidateKeys) {
    const val = headers[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (Array.isArray(val) && val[0]?.trim()) return val[0].trim();
  }
  return undefined;
}

/**
 * Validate the shared adapter token (backward-compat path).
 */
function validateAdapterToken(req: http.IncomingMessage): boolean {
  if (!ADAPTER_TOKEN) return true; // No token configured = open
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1] === ADAPTER_TOKEN) return true;
  }
  const instinctToken = req.headers["x-instinct-token"];
  if (typeof instinctToken === "string" && instinctToken === ADAPTER_TOKEN) return true;
  return false;
}

/**
 * Verify that the given user owns the requested instinct agent by querying
 * Supabase instinct_agent_adapters. Returns true if authorized, false otherwise.
 */
async function verifyUserOwnsAgent(
  userId: string,
  instinctUserId: string,
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // No Supabase configured — fall back to shared token auth
    return true;
  }
  try {
    const url = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/instinct_agent_adapters`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ instinct_user_id: string; user_id: string }>;
    return rows.some(
      (r) => r.instinct_user_id === instinctUserId && r.user_id === userId,
    );
  } catch {
    return false;
  }
}

/**
 * Authorize the request. Returns { authorized, reason }.
 * Priority:
 *   1. If a forwarded user ID is present, verify ownership via Supabase.
 *   2. Otherwise, fall back to shared ADAPTER_TOKEN.
 */
async function authorizeRequest(
  req: http.IncomingMessage,
  instinctUserId: string,
): Promise<{ authorized: boolean; reason: string }> {
  const forwardedUserId = getForwardedUserId(req);

  if (forwardedUserId) {
    const owns = await verifyUserOwnsAgent(forwardedUserId, instinctUserId);
    if (owns) {
      return { authorized: true, reason: "user_owns_agent" };
    }
    return {
      authorized: false,
      reason: `user ${forwardedUserId} does not own agent ${instinctUserId}`,
    };
  }

  // Fall back to shared token
  if (validateAdapterToken(req)) {
    return { authorized: true, reason: "adapter_token" };
  }
  return { authorized: false, reason: "invalid_token" };
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request" } });
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return sendJson(res, 400, { error: { message: "messages array is required", type: "invalid_request" } });
  }

  const openaiReq = body as import("./translator.js").OpenAIChatRequest;
  const instinctReq = openAIToInstinct(openaiReq);
  const model = openaiReq.model || "instinct-agent-default";
  const stream = openaiReq.stream ?? false;

  // Extract external ID from model name (e.g., "instinct-agent-usr_abc123" → "usr_abc123")
  const externalId = extractConversationId(model, openaiReq.user);
  if (!externalId || externalId === "default") {
    return sendJson(res, 400, { error: { message: "Model must be instinct-agent-{userId}", type: "invalid_request" } });
  }

  // ── Per-user authorization ──────────────────────────────────────────
  const auth = await authorizeRequest(req, externalId);
  if (!auth.authorized) {
    return sendJson(res, 403, {
      error: { message: `Access denied: ${auth.reason}`, type: "auth_error" },
    });
  }

  const maritimeClient = getMaritimeClient(externalId);

  try {
    const agentResp = await maritimeClient.chat(
      instinctReq.message,
      instinctReq.conversation_id || externalId,
      instinctReq.source || "open-webui",
    );

    const openaiResp = instinctToOpenAI(agentResp, model, instinctReq.message);

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const chunkId = openaiResp.id;
      const text = openaiResp.choices[0]?.message?.content ?? "";
      const words = text.split(/(\s+)/);

      for (let i = 0; i < words.length; i++) {
        const chunk = instinctToOpenAIChunk(words[i] ?? "", model, chunkId, false);
        res.write(chunk);
      }

      // Send final chunk with finish_reason
      const finalChunk = instinctToOpenAIChunk("", model, chunkId, true);
      res.write(finalChunk);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      sendJson(res, 200, openaiResp);
    }
  } catch (err) {
    console.error(`[adapter] Chat error: ${(err as Error).message}`);
    return sendJson(res, 500, {
      error: { message: `Agent communication failed: ${(err as Error).message}`, type: "server_error" },
    });
  }
}

async function handleModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Models list is read-only; allow with shared token for discovery.
  // Per-model access is enforced at chat time.
  if (!validateAdapterToken(req)) {
    return sendJson(res, 401, { error: { message: "Invalid or missing adapter token", type: "auth_error" } });
  }

  const now = Math.floor(Date.now() / 1000);
  const data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }> = [];

  // Query Supabase for all ready adapter rows
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const url = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/instinct_agent_adapters?select=instinct_user_id&status=eq.ready`;
      const res2 = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      });
      if (res2.ok) {
        const rows = (await res2.json()) as Array<{ instinct_user_id: string }>;
        for (const row of rows) {
          data.push({
            id: `instinct-agent-${row.instinct_user_id}`,
            object: "model",
            created: now,
            owned_by: "instinct-agent",
          });
        }
      }
    } catch {
      // Supabase query failed — return empty list
    }
  }

  sendJson(res, 200, { object: "list", data });
}

async function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  sendJson(res, 200, { status: "ok", adapters: clientCache.size, supabase: Boolean(SUPABASE_URL) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (method === "GET" && path === "/health") {
      await handleHealth(req, res);
    } else if (
      method === "POST" &&
      (path === "/v1/chat/completions" || path === "/chat/completions")
    ) {
      await handleChatCompletions(req, res);
    } else if (
      method === "GET" &&
      (path === "/v1/models" || path === "/models")
    ) {
      await handleModels(req, res);
    } else {
      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    }
  } catch (err) {
    console.error(`[adapter] Unhandled error: ${(err as Error).message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: "Internal server error", type: "server_error" } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[adapter] OpenAI-compatible adapter listening on :${PORT}`);
  console.log(`[adapter] Multi-tenant: models queried from Supabase`);
  console.log(`[adapter] Supabase URL: ${SUPABASE_URL || "(not set)"}`);
});

export { server };