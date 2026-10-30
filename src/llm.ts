/** Shared LLM helpers: token estimates, history trimming, retryable errors. */

export interface LlmMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

/** Rough token estimate: ~4 characters per token for English/code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Keep the most recent history, dropping oldest user/assistant pairs first,
 * so the total history stays under maxChars. System messages are never
 * trimmed here — the caller keeps them separate.
 */
export function trimHistory(history: LlmMessage[], maxChars = 40000, maxMessages = 12): LlmMessage[] {
  let kept = history.slice(-maxMessages);
  let total = kept.reduce((sum, m) => sum + m.content.length, 0);
  while (kept.length > 2 && total > maxChars) {
    const dropped = kept.shift();
    if (dropped) {
      total -= dropped.content.length;
    }
    // Drop in pairs where possible so an assistant reply is not orphaned.
    if (kept.length > 0 && kept[0].role === "assistant" && total > maxChars) {
      const second = kept.shift();
      if (second) {
        total -= second.content.length;
      }
    }
  }
  return kept;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 and 5xx are worth retrying; 400/401/403/404 are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry an initial (non-streaming) fetch up to 3 attempts with backoff. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3
): Promise<Response> {
  let lastError: any = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !isRetryableStatus(res.status)) {
        return res;
      }
      // Retryable status: consume body so the connection can close cleanly.
      await res.text().catch(() => "");
      lastError = new Error(`Request failed (${res.status})`);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw err;
      }
      lastError = err;
    }
    if (attempt < attempts - 1) {
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastError || new Error("Request failed");
}

/**
 * Lexical retrieval over older chat messages (chat-memory idea,
 * without a BM25 index): score by shared query tokens, return the top
 * resultCount messages, each truncated to retrievedCharacters. Tool results
 * are never stored here — only user/assistant text.
 */
export function retrieveOlderChats(query: string, older: LlmMessage[], resultCount = 4, retrievedCharacters = 3000): LlmMessage[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((x) => x.length > 2);
  if (tokens.length === 0 || older.length === 0) { return []; }
  const scored = older.map((m) => {
    const lower = m.content.toLowerCase();
    let score = 0;
    for (const tok of tokens) { if (lower.includes(tok)) { score += 1; } }
    return { m, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, resultCount));
  return scored.map((x) => ({ content: x.m.content.slice(0, retrievedCharacters), role: x.m.role }));
}
