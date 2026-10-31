import { fetchWithRetry } from "./llm";
import * as os from "os";
export async function listModels(ollamaHost: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${trim(ollamaHost)}/api/tags`, 3000);
  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}`);
  }
  const data: any = await res.json();
  const models: string[] = (data.models || []).map((m: any) => String(m.name || "")).filter(Boolean);
  return models;
}

export async function checkHealth(ollamaHost: string): Promise<boolean> {
  try {
    await listModels(ollamaHost);
    return true;
  } catch {
    return false;
  }
}

export interface ChatMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

export async function* chatStream(
  ollamaHost: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  contextWindow?: number,
  think?: boolean
): AsyncGenerator<string, void, unknown> {
  // Speed: keep the model loaded for 30 minutes so the 2nd, 3rd, … question
  // does not pay the slow model-load cost again, and use all CPU threads.
  // Default context is capped at 4096 (Ollama's model default is often
  // 32768, which makes prefill on CPU very slow) unless the user set one.
  const body: any = { keep_alive: "30m", messages, model, stream: true };
  if (typeof think === "boolean") { body.think = think; }
  const options: any = { num_thread: Math.max(1, os.cpus().length) };
  if (maxTokens) {
    options.num_predict = maxTokens;
  }
  if (typeof temperature === "number") {
    options.temperature = temperature;
  }
  options.num_ctx = contextWindow && contextWindow > 0 ? contextWindow : 4096;
  if (Object.keys(options).length > 0) {
    body.options = options;
  }
  const res = await fetchWithRetry(`${trim(ollamaHost)}/api/chat`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama chat failed (${res.status}). ${text.slice(0, 300)}`);
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
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.message?.content === "string" && parsed.message.content) {
            yield parsed.message.content;
          } else if (typeof parsed.message?.thinking === "string" && parsed.message.thinking) {
            // Reasoning models (e.g. deepseek-r1) put their reply in
            // `thinking` first — without this, chat would look silent.
            yield parsed.message.thinking;
          }
          if (parsed.done) {
            return;
          }
        } catch {
          // Partial NDJSON line — ignore, next chunk completes it.
        }
      }
    }
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          yield parsed.message.content;
        } else if (parsed.message?.thinking) {
          yield parsed.message.thinking;
        }
      } catch {
        // ignore trailing fragment
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
