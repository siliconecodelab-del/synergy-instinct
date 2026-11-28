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
import { createAgentClientFromEnv, MaritimeClient } from "./maritime.js";
import type { AgentClient } from "./maritime.js";
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
const MODEL_ID = process.env.MODEL_ID || "instinct-agent-local";
const MARITIME_API_URL = process.env.MARITIME_API_URL || "https://api.maritime.sh";
const MARITIME_API_KEY = process.env.MARITIME_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENWEBUI_URL = process.env.OPENWEBUI_URL || "";
const OPENWEBUI_ADMIN_TOKEN = process.env.OPENWEBUI_ADMIN_TOKEN || "";

// Cache of agent client instances by external ID (local mode) or maritime agent id (prod mode)
const clientCache = new Map<string, AgentClient>();

function getAgentClient(externalId: string): AgentClient {
  // In local mode, the client is the same for all externalIds (single local agent)
  const cacheKey = process.env.AGENT_CHAT_URL ? "local" : externalId;
  let client = clientCache.get(cacheKey);
  if (!client) {
    if (process.env.AGENT_CHAT_URL) {
      client = createAgentClientFromEnv();
    } else {
      // Production mode: create MaritimeClient with the externalId from the model name
      const baseUrl = process.env.MARITIME_API_URL || "https://api.maritime.sh";
      const apiKey = process.env.MARITIME_API_KEY || "";
      const chatToken = process.env.INSTINCT_CHAT_TOKEN;
      client = new MaritimeClient({ baseUrl, apiKey, agentId: "", externalId, chatToken });
    }
    clientCache.set(cacheKey, client);
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

  const agentClient = getAgentClient(externalId);

  try {
    const agentResp = await agentClient.chat(
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

  // In local mode (AGENT_CHAT_URL set), return the single configured model
  if (process.env.AGENT_CHAT_URL) {
    data.push({
      id: MODEL_ID,
      object: "model",
      created: now,
      owned_by: "instinct-agent",
    });
    sendJson(res, 200, { object: "list", data });
    return;
  }

  // In production mode, query Supabase for all ready adapter rows
  // ── Layer 1: Only return models whose agent still exists in Maritime ──
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
          const externalId = row.instinct_user_id;
          try {
            const agentUrl = `${MARITIME_API_URL.replace(/\/+$/, "")}/api/agents?externalId=${encodeURIComponent(externalId)}`;
            const agentRes = await fetch(agentUrl, {
              headers: { Authorization: `Bearer ${MARITIME_API_KEY}` },
            });
            if (agentRes.ok) {
              const agents = (await agentRes.json()) as any[];
              const exists = Array.isArray(agents) && agents.some((a: any) => a.externalId === externalId);
              if (exists) {
                data.push({
                  id: `instinct-agent-${externalId}`,
                  object: "model",
                  created: now,
                  owned_by: "instinct-agent",
                });
              } else {
                console.warn(`[adapter] Skipping ghost agent: ${externalId} (not found in Maritime)`);
              }
            } else {
              // Maritime check failed — include model anyway (fail-open for availability)
              data.push({
                id: `instinct-agent-${externalId}`,
                object: "model",
                created: now,
                owned_by: "instinct-agent",
              });
            }
          } catch {
            // Network error — include model anyway (fail-open for availability)
            data.push({
              id: `instinct-agent-${externalId}`,
              object: "model",
              created: now,
              owned_by: "instinct-agent",
            });
          }
        }
      }
    } catch {
      // Supabase query failed — return empty list
    }
  }

  sendJson(res, 200, { object: "list", data });
}

// ── Layer 4: Resync endpoint ────────────────────────────────────────
// Forces Open WebUI to sync all agent models from Supabase adapter table.
// Called by claim-machine/delete-machine after model changes to ensure
// Open WebUI's internal model DB is always in sync with adapter state.
async function handleModelResync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!validateAdapterToken(req)) {
    return sendJson(res, 401, { error: { message: "Invalid or missing adapter token", type: "auth_error" } });
  }

  if (!OPENWEBUI_URL || !OPENWEBUI_ADMIN_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, {
      error: { message: "Resync not configured — missing OpenWebUI/Supabase env vars", type: "server_error" },
    });
  }

  try {
    // 1. Fetch all adapter rows from Supabase
    const supaRes = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/instinct_agent_adapters?select=instinct_user_id,user_id&status=eq.ready`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      },
    );
    if (!supaRes.ok) {
      return sendJson(res, 500, {
        error: { message: `Failed to fetch adapter rows (${supaRes.status})`, type: "server_error" },
      });
    }
    const adapterRows = (await supaRes.json()) as Array<{ instinct_user_id: string; user_id: string }>;

    // 2. Build model list for Open WebUI sync
    const now = Math.floor(Date.now() / 1000);
    const models = adapterRows.map((row) => ({
      id: `instinct-agent-${row.instinct_user_id}`,
      base_model_id: `instinct-agent-${row.instinct_user_id}`,
      name: `Instinct Agent (${row.instinct_user_id})`,
      meta: {
        description: `Personal instinct agent for ${row.instinct_user_id}`,
        profile_image_url: null,
      },
      params: {},
      access_grants: [{ principal_type: "user", principal_id: row.user_id, permission: "read" }],
      is_active: true,
      updated_at: now,
      created_at: now,
    }));

    // 3. Sync all models to Open WebUI
    const syncRes = await fetch(`${OPENWEBUI_URL}/api/v1/models/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENWEBUI_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ models }),
    });

    if (!syncRes.ok) {
      const errText = await syncRes.text();
      return sendJson(res, syncRes.status, {
        error: { message: `Open WebUI sync failed (${syncRes.status}): ${errText.slice(0, 200)}`, type: "server_error" },
      });
    }

    const syncData = (await syncRes.json()) as unknown;
    sendJson(res, 200, {
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: m.created_at, owned_by: "instinct-agent" })),
      synced: models.length,
      raw: syncData,
    });
  } catch (err) {
    console.error(`[adapter] Resync error: ${(err as Error).message}`);
    return sendJson(res, 500, {
      error: { message: `Resync failed: ${(err as Error).message}`, type: "server_error" },
    });
  }
}

async function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  sendJson(res, 200, {
    status: "ok",
    mode: process.env.AGENT_CHAT_URL ? "local" : "maritime",
    supabase: Boolean(SUPABASE_URL),
  });
}

// ── Layer 3: Startup reconciliation ──────────────────────────────────────
// On adapter startup, fetch all Open WebUI models and delete any that don't
// have corresponding instinct_agent_adapters rows in Supabase.
async function reconcileModelsWithAdapterTable(): Promise<void> {
  if (!OPENWEBUI_URL || !OPENWEBUI_ADMIN_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log("[adapter] Reconciliation skipped — missing config");
    return;
  }

  try {
    // 1. Fetch all instinct-agent models from Open WebUI
    const owuiRes = await fetch(`${OPENWEBUI_URL}/api/v1/models/list`, {
      headers: { Authorization: `Bearer ${OPENWEBUI_ADMIN_TOKEN}` },
    });
    if (!owuiRes.ok) {
      console.warn(`[adapter] Reconciliation: failed to fetch OWUI models (${owuiRes.status})`);
      return;
    }
    const owuiData = (await owuiRes.json()) as { items?: Array<{ id: string }> };
    const owuiModels = (owuiData.items || []).filter((m) =>
      m.id.startsWith("instinct-agent-"),
    );
    const owuiModelIds = new Set(owuiModels.map((m) => m.id));

    // 2. Fetch all adapter rows from Supabase
    const supaRes = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/instinct_agent_adapters?select=instinct_user_id,user_id,status`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      },
    );
    if (!supaRes.ok) {
      console.warn(`[adapter] Reconciliation: failed to fetch adapter rows (${supaRes.status})`);
      return;
    }
    const adapterRows = (await supaRes.json()) as Array<{ instinct_user_id: string; user_id: string; status: string }>;
    const expectedModelIds = new Set(adapterRows.map((r) => `instinct-agent-${r.instinct_user_id}`));

    // ── Layer 1+3 combined: Verify each agent still exists in Maritime ──
    // Agents that don't exist in Maritime are ghosts — remove from both
    // Open WebUI and Supabase adapter table.
    const ghostIds = new Set<string>();
    for (const row of adapterRows) {
      const externalId = row.instinct_user_id;
      try {
        const agentUrl = `${MARITIME_API_URL.replace(/\/+$/, "")}/api/agents?externalId=${encodeURIComponent(externalId)}`;
        const agentRes = await fetch(agentUrl, {
          headers: { Authorization: `Bearer ${MARITIME_API_KEY}` },
        });
        if (agentRes.ok) {
          const agents = (await agentRes.json()) as any[];
          const exists = Array.isArray(agents) && agents.some((a: any) => a.externalId === externalId);
          if (!exists) {
            ghostIds.add(externalId);
            console.warn(`[adapter] Reconciliation: agent ${externalId} not found in Maritime (ghost)`);
          }
        } else {
          console.warn(`[adapter] Reconciliation: Maritime check failed for ${externalId} (${agentRes.status}) — skipping`);
        }
      } catch (err) {
        console.warn(`[adapter] Reconciliation: Maritime check error for ${externalId}: ${(err as Error).message} — skipping`);
      }
    }

    // 3. Delete orphaned/ghost models from Open WebUI
    let cleaned = 0;
    for (const model of owuiModels) {
      const externalId = model.id.replace("instinct-agent-", "");
      const isGhost = ghostIds.has(externalId);
      const isOrphan = !expectedModelIds.has(model.id);
      if (isGhost || isOrphan) {
        try {
          const delRes = await fetch(`${OPENWEBUI_URL}/api/v1/models/model/delete`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENWEBUI_ADMIN_TOKEN}`,
            },
            body: JSON.stringify({ id: model.id }),
          });
          if (delRes.ok) {
            console.log(`[adapter] Reconciliation: deleted ${isGhost ? "ghost" : "orphan"} model ${model.id}`);
            cleaned++;
          } else {
            console.warn(`[adapter] Reconciliation: failed to delete ${model.id} (${delRes.status})`);
          }
        } catch (err) {
          console.warn(`[adapter] Reconciliation: error deleting ${model.id}: ${(err as Error).message}`);
        }
      }
    }

    // 4. Clean up adapter rows for ghost agents (remove from Supabase)
    for (const ghostId of ghostIds) {
      try {
        const delRes = await fetch(
          `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/instinct_agent_adapters?instinct_user_id=eq.${ghostId}`,
          {
            method: "DELETE",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              Prefer: "return=representation",
            },
          },
        );
        if (delRes.ok) {
          console.log(`[adapter] Reconciliation: removed ghost adapter row ${ghostId}`);
        }
      } catch (err) {
        console.warn(`[adapter] Reconciliation: error removing adapter row ${ghostId}: ${(err as Error).message}`);
      }
    }

    // 5. Register missing models in Open WebUI (missing agents)
    let created = 0;
    for (const row of adapterRows) {
      // Skip ghost agents
      if (ghostIds.has(row.instinct_user_id)) continue;

      const modelId = `instinct-agent-${row.instinct_user_id}`;
      if (!owuiModelIds.has(modelId)) {
        try {
          const createRes = await fetch(`${OPENWEBUI_URL}/api/v1/models/create`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENWEBUI_ADMIN_TOKEN}`,
            },
            body: JSON.stringify({
              id: modelId,
              base_model_id: modelId,
              name: `Instinct Agent (${row.instinct_user_id})`,
              meta: {
                description: `Personal instinct agent`,
                profile_image_url: null,
              },
              params: {},
              access_grants: [{ principal_type: "user", principal_id: row.user_id, permission: "read" }],
              is_active: true,
            }),
          });
          if (createRes.ok) {
            console.log(`[adapter] Reconciliation: created missing model ${modelId}`);
            created++;
          } else {
            console.warn(`[adapter] Reconciliation: failed to create ${modelId} (${createRes.status})`);
          }
        } catch (err) {
          console.warn(`[adapter] Reconciliation: error creating ${modelId}: ${(err as Error).message}`);
        }
      }
    }

    console.log(`[adapter] Reconciliation complete: ${cleaned} ghosts removed, ${ghostIds.size} adapter rows cleaned, ${created} missing created`);
  } catch (err) {
    console.error(`[adapter] Reconciliation failed: ${(err as Error).message}`);
  }
}

// ── Periodic sync (every 5 minutes) ──────────────────────────────────────
function startPeriodicSync(): void {
  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  setInterval(() => {
    reconcileModelsWithAdapterTable().catch((err) => {
      console.error(`[adapter] Periodic sync error: ${(err as Error).message}`);
    });
  }, SYNC_INTERVAL_MS);
  console.log("[adapter] Periodic sync started (every 5 minutes)");
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
    } else if (
      method === "POST" &&
      (path === "/v1/models/resync" || path === "/models/resync")
    ) {
      await handleModelResync(req, res);
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
  if (process.env.AGENT_CHAT_URL) {
    console.log(`[adapter] Local mode: calling agent at ${process.env.AGENT_CHAT_URL}`);
    console.log(`[adapter] Model ID: ${MODEL_ID}`);
  } else {
    console.log(`[adapter] Multi-tenant: models queried from Supabase`);
    console.log(`[adapter] Supabase URL: ${SUPABASE_URL || "(not set)"}`);
    // ── Layer 3: Run startup reconciliation ──
    reconcileModelsWithAdapterTable().catch((err) => {
      console.error(`[adapter] Reconciliation error: ${(err as Error).message}`);
    });
    // ── Layer 3b: Start periodic sync (every 5 minutes) ──
    startPeriodicSync();
  }
});

export { server };