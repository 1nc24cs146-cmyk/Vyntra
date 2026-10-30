import { fetchWithRetry, LlmMessage } from "./llm";

/** OpenAI-compatible chat API: LM Studio, OpenRouter, Groq, Ollama via /v1, etc. */

export interface OpenAiConfig {
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  model: string;
  temperature?: number;
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function* openAiChatStream(
  cfg: OpenAiConfig,
  messages: LlmMessage[],
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const body: any = {
    messages: messages.map((m) => ({ content: m.content, role: m.role })),
    model: cfg.model,
    stream: true
  };
  if (cfg.maxTokens) {
    body.max_tokens = cfg.maxTokens;
  }
  if (typeof cfg.temperature === "number") {
    body.temperature = cfg.temperature;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  const res = await fetchWithRetry(`${trim(cfg.baseUrl)}/chat/completions`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible chat failed (${res.status}). ${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith("data:")) {
          continue;
        }
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") {
          continue;
        }
        try {
          const parsed = JSON.parse(json);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            yield delta;
          }
        } catch {
          // partial SSE chunk — next chunk completes it
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function checkOpenAi(cfg: OpenAiConfig): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
    const res = await fetch(`${trim(cfg.baseUrl)}/models`, { headers, signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
