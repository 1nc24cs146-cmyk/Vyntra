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
  maxTokens?: number
): AsyncGenerator<string, void, unknown> {
  const body: any = { messages, model, stream: true };
  if (maxTokens) {
    body.options = { num_predict: maxTokens };
  }
  const res = await fetch(`${trim(ollamaHost)}/api/chat`, {
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
