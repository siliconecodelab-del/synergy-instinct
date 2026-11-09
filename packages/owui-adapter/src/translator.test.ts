/**
 * Unit tests for the OpenAI ↔ Instinct protocol translation layer.
 *
 * Run with: npm test  (or npx vitest run)
 */

import {
  extractUserMessage,
  extractConversationId,
  instinctToOpenAI,
  instinctToOpenAIChunk,
  openAIToInstinct,
} from "./translator.js";

import { describe, it, expect } from "vitest";

type Role = "system" | "user" | "assistant" | "tool";

function msg(role: Role, content: string) {
  return { role, content } as const;
}

// ──────────────────────────────────────────────────────────────
// extractUserMessage
// ──────────────────────────────────────────────────────────────

describe("extractUserMessage", () => {
  it("returns the last user message when no system prompt", () => {
    const result = extractUserMessage([
      msg("user", "Hello there"),
      msg("assistant", "Hi!"),
      msg("user", "How are you?"),
    ]);
    expect(result).toBe("How are you?");
  });

  it("prepends system prompt to the last user message", () => {
    const result = extractUserMessage([
      msg("system", "You are a helpful assistant"),
      msg("user", "What is 2+2?"),
    ]);
    expect(result).toBe("You are a helpful assistant\n\nWhat is 2+2?");
  });

  it("handles empty content gracefully", () => {
    const result = extractUserMessage([
      msg("system", ""),
      msg("user", ""),
    ]);
    expect(result).toBe("");
  });

  it("returns empty string for no messages", () => {
    const result = extractUserMessage([]);
    expect(result).toBe("");
  });

  it("ignores assistant messages when selecting user message", () => {
    const result = extractUserMessage([
      msg("assistant", "I am an assistant"),
      msg("user", "Real user message"),
    ]);
    expect(result).toBe("Real user message");
  });

  it("includes multiple system messages concatenated", () => {
    const result = extractUserMessage([
      msg("system", "System rule 1"),
      msg("system", "System rule 2"),
      msg("user", "User question"),
    ]);
    expect(result).toBe("System rule 1\nSystem rule 2\n\nUser question");
  });
});

// ──────────────────────────────────────────────────────────────
// extractConversationId
// ──────────────────────────────────────────────────────────────

describe("extractConversationId", () => {
  it("extracts externalId from instinct-agent-{id} model name", () => {
    const result = extractConversationId("instinct-agent-usr_abc123");
    expect(result).toBe("usr_abc123");
  });

  it("extracts externalId with hyphens and numbers", () => {
    const result = extractConversationId("instinct-agent-usr_1c54fb18858b04bd");
    expect(result).toBe("usr_1c54fb18858b04bd");
  });

  it("falls back to user param when model doesn't match pattern", () => {
    const result = extractConversationId("openai/gpt-4", "usr_fallback");
    expect(result).toBe("usr_fallback");
  });

  it("returns 'default' when no match and no user param", () => {
    const result = extractConversationId("openai/gpt-4");
    expect(result).toBe("default");
  });

  it("returns 'default' when model matches but captures empty", () => {
    // "instinct-agent-" with nothing after the hyphen — .+ requires at least 1 char
    const result = extractConversationId("instinct-agent-");
    expect(result).toBe("default");
  });
});

// ──────────────────────────────────────────────────────────────
// instinctToOpenAI
// ──────────────────────────────────────────────────────────────

describe("instinctToOpenAI", () => {
  it("converts a normal agent response to OpenAI format", () => {
    const agentResp = {
      response: "Hello! How can I help?",
      acked: true,
      conversationKey: "chat:default",
    };

    const result = instinctToOpenAI(agentResp, "instinct-agent-usr_123", "Hello");

    expect(result.id).toMatch(/^chatcmpl-[a-z0-9]{24}$/);
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("instinct-agent-usr_123");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0]!.index).toBe(0);
    expect(result.choices[0]!.message.role).toBe("assistant");
    expect(result.choices[0]!.message.content).toBe("Hello! How can I help?");
    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(
      result.usage.prompt_tokens + result.usage.completion_tokens,
    );
  });

  it("returns placeholder when agent acks but has no response", () => {
    const agentResp = {
      response: "",
      acked: true,
    };

    const result = instinctToOpenAI(agentResp, "instinct-agent-usr_123", "Do something");

    expect(result.choices[0]!.message.content).toBe(
      "I'm working on it. I'll send the result when it's done.",
    );
  });

  it("returns blocked message when agent blocks", () => {
    const agentResp = {
      response: "",
      acked: true,
      blocked: "payments not configured",
    };

    const result = instinctToOpenAI(agentResp, "instinct-agent-usr_123", "Buy something");

    expect(result.choices[0]!.message.content).toBe(
      "Blocked: payments not configured",
    );
  });

  it("returns pending replies when agent has buffered responses", () => {
    const agentResp = {
      response: "",
      acked: true,
      pending: ["First buffered reply", "Second buffered reply"],
    };

    const result = instinctToOpenAI(agentResp, "instinct-agent-usr_123", "Check status");

    expect(result.choices[0]!.message.content).toBe(
      "First buffered reply\n\nSecond buffered reply",
    );
  });

  it("handles empty messages gracefully", () => {
    const agentResp = {
      response: "Hi",
      acked: true,
    };

    const result = instinctToOpenAI(agentResp, "instinct-agent-usr_123", "");

    expect(result.choices[0]!.message.content).toBe("Hi");
    // Empty string split produces [""] → 1 token estimate
    expect(result.usage.prompt_tokens).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────
// instinctToOpenAIChunk
// ──────────────────────────────────────────────────────────────

describe("instinctToOpenAIChunk", () => {
  it("produces a valid SSE chunk for non-final content", () => {
    const chunk = instinctToOpenAIChunk("Hello", "instinct-agent-usr_123", "chatcmpl-abc", false);

    expect(chunk).toContain('"object":"chat.completion.chunk"');
    expect(chunk).toContain('"model":"instinct-agent-usr_123"');
    expect(chunk).toContain('"content":"Hello"');
    expect(chunk).toContain('"finish_reason":null');
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk.endsWith("\n\n")).toBe(true);
  });

  it("produces a final chunk with finish_reason=stop", () => {
    const chunk = instinctToOpenAIChunk("", "instinct-agent-usr_123", "chatcmpl-abc", true);

    expect(chunk).toContain('"finish_reason":"stop"');
    expect(chunk).toContain('"delta":{}');
  });

  it("produces the EOS sentinel after the final chunk", () => {
    const chunk = instinctToOpenAIChunk("", "instinct-agent-usr_123", "chatcmpl-abc", true);
    const eos = "data: [DONE]\n\n";

    expect(chunk.endsWith(eos)).toBe(false); // EOS is separate
    expect(eos.endsWith("\n\n")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// openAIToInstinct
// ──────────────────────────────────────────────────────────────

describe("openAIToInstinct", () => {
  it("converts OpenAI request to instinct agent request", () => {
    const openaiReq = {
      model: "instinct-agent-usr_abc123",
      messages: [
        msg("system", "You are helpful"),
        msg("user", "Hello agent"),
      ],
      stream: false,
      temperature: 0.7,
    };

    const result = openAIToInstinct(openaiReq);

    expect(result.message).toBe("You are helpful\n\nHello agent");
    expect(result.source).toBe("open-webui");
    expect(result.conversation_id).toBe("usr_abc123");
  });

  it("uses fallback conversation_id when model doesn't match instinct pattern", () => {
    const openaiReq = {
      model: "openai/gpt-4",
      messages: [msg("user", "Hello")],
      user: "usr_fallback",
    };

    const result = openAIToInstinct(openaiReq);

    expect(result.conversation_id).toBe("usr_fallback");
  });

  it("handles empty messages array", () => {
    const openaiReq = {
      model: "instinct-agent-usr_abc123",
      messages: [],
    };

    const result = openAIToInstinct(openaiReq);

    expect(result.message).toBe("");
    expect(result.conversation_id).toBe("usr_abc123");
  });
});
