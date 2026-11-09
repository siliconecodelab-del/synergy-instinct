/**
 * Protocol translation between OpenAI-compatible (Open WebUI) and
 * Instinct agent (/chat) formats.
 */

// ── OpenAI-compatible types ──────────────────────────────────────────────

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
}

export interface OpenAIChatChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage: OpenAIChatUsage;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { content?: string; role?: string };
    finish_reason: "stop" | "length" | "content_filter" | null;
  }[];
}

// ── Instinct agent types ─────────────────────────────────────────────────

export interface InstinctChatRequest {
  message: string;
  source?: string;
  conversation_id?: string;
}

export interface InstinctChatResponse {
  response: string;
  acked: boolean;
  conversationKey?: string;
  blocked?: string;
  pending?: string[];
}

// ── Translation helpers ──────────────────────────────────────────────────

/**
 * Extract the last user message from an OpenAI messages array.
 * System messages are prepended as context.
 */
export function extractUserMessage(messages: OpenAIMessage[]): string {
  let systemContext = "";
  let userMessage = "";

  for (const m of messages) {
    if (m.role === "system") {
      systemContext += (m.content || "") + "\n";
    } else if (m.role === "user") {
      userMessage = m.content || "";
    }
  }

  if (systemContext && userMessage) {
    return `${systemContext.trim()}\n\n${userMessage}`;
  }
  return userMessage;
}

/**
 * Extract conversation ID from model name or messages.
 * Model name format: "instinct-agent-{handle}" or "instinct-agent-{userId}"
 */
export function extractConversationId(model: string, user?: string): string {
  const match = model.match(/^instinct-agent-(.+)$/);
  if (match && match[1]) return match[1];
  return user || "default";
}

/**
 * Convert an instinct agent response to OpenAI chat completion format.
 */
export function instinctToOpenAI(
  agentResponse: InstinctChatResponse,
  model: string,
  userMessage: string,
): OpenAIChatResponse {
  // Handle async ack-only responses
  let content = agentResponse.response;
  if (!content && agentResponse.acked) {
    content = "I'm working on it. I'll send the result when it's done.";
  }
  if (agentResponse.blocked) {
    content = `Blocked: ${agentResponse.blocked}`;
  }

  // Handle pending replies (buffered async responses from earlier turns)
  if (agentResponse.pending && agentResponse.pending.length > 0) {
    content = agentResponse.pending.join("\n\n");
  }

  const promptTokens = Math.ceil(userMessage.split(/\s+/).length * 1.3);
  const completionTokens = Math.ceil(content.split(/\s+/).length * 1.3);

  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Convert an instinct agent response to an SSE chunk for streaming.
 */
export function instinctToOpenAIChunk(
  text: string,
  model: string,
  chunkId: string,
  isLast: boolean = false,
): string {
  const chunk: OpenAIChatChunk = {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: isLast ? {} : { content: text },
        finish_reason: isLast ? "stop" : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Convert OpenAI request to instinct agent request.
 */
export function openAIToInstinct(req: OpenAIChatRequest): InstinctChatRequest {
  return {
    message: extractUserMessage(req.messages),
    source: "open-webui",
    conversation_id: extractConversationId(req.model, req.user),
  };
}