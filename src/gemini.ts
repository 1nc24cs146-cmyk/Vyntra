import { fetchWithRetry } from "./llm";
export interface GeminiMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiModelId(model: string): string {
  return model && model.trim() ? model.trim() : "gemini-3.8-flash";
}

/** Extract the text from one Gemini generateContent response object. */
export function extractGeminiText(data: any): string {
  try {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p: any) => (typeof p.text === "string" ? p.text : "")).join("");
  } catch {
    return "";
  }
}

export async function checkGemini(apiKey: string): Promise<boolean> {
  if (!apiKey) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function* geminiChatStream(
  apiKey: string,
  model: string,
  messages: GeminiMessage[],
  maxOutputTokens = 8192,
  temperature = 0.2,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const modelId = geminiModelId(model);
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ parts: [{ text: m.content }], role: m.role === "assistant" ? "model" : "user" }));
  const body: any = {
    contents,
    generationConfig: { maxOutputTokens, temperature }
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  // Streaming first: SSE lines "data: {...}"
  const streamRes = await fetchWithRetry(`${BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal
  });
  if (streamRes.ok && streamRes.body) {
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let yielded = false;
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
            const text = extractGeminiText(JSON.parse(json));
            if (text) {
              yielded = true;
              yield text;
            }
          } catch {
            // partial SSE chunk — next chunk completes it
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (yielded) {
      return;
    }
  }
  // Fallback: non-streaming generateContent.
  const res = await fetchWithRetry(`${BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API failed (${res.status}). ${text.slice(0, 300)} Check your API key and that gemini-3.8-flash is enabled for it.`);
  }
  const data: any = await res.json();
  const text = extractGeminiText(data);
  if (text) {
    yield text;
  }
}
