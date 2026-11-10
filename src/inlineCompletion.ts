/** Inline (ghost-text) code completion from the local Ollama model.
 *
 * Pure helpers live here with no vscode dependency, so they can be unit
 * tested in plain Node. The VS Code provider is in inlineCompletionProvider.ts.
 *
 * Silence rule: every failure path returns null / [] — never throws, never
 * notifies. Ollama unreachable simply means no ghost text appears.
 * No cloud calls, no API keys, no telemetry — code goes only to the
 * configured Ollama host, exactly like chat does.
 */

/** Settings defaults for localNest.inlineCompletion.* (also declared in package.json). */
export const INLINE_COMPLETION_DEFAULTS = { delayMs: 300, enabled: true };

/** Languages the inline provider registers for. Code files only. */
export const INLINE_COMPLETION_LANGUAGES: string[] = [
  "c", "cpp", "csharp", "css", "go", "html", "java", "javascript",
  "javascriptreact", "json", "jsonc", "kotlin", "less", "php", "python",
  "ruby", "rust", "scss", "shellscript", "sql", "swift", "typescript",
  "typescriptreact", "vue", "yaml"
];

/** How much surrounding code is sent to the model. */
export const INLINE_COMPLETION_MAX_PREFIX_CHARS = 2000;
export const INLINE_COMPLETION_MAX_SUFFIX_CHARS = 1000;
/** Hard caps on a single suggestion, so ghost text stays a completion, not a dump. */
export const INLINE_COMPLETION_MAX_LINES = 10;
export const INLINE_COMPLETION_MAX_CHARS = 600;

/** Models known to understand fill-in-the-middle (FIM) special tokens. */
const FIM_MODEL_HINTS = [
  "codellama", "qwen2.5-coder", "qwen-coder", "codeqwen", "deepseek-coder",
  "starcoder", "codegemma", "wizardcoder", "opencoder"
];

/** True when the model name looks like a FIM-capable code model. */
export function supportsFim(model: string): boolean {
  const lower = (model || "").toLowerCase();
  return FIM_MODEL_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Build the completion prompt from the code around the cursor.
 * FIM models get the native <|fim_prefix|> / <|fim_suffix|> / <|fim_middle|>
 * format; other models get a plain instruction prompt that still carries
 * the same prefix/suffix context. Either way the prompt includes both the
 * code before the cursor and the code after it.
 */
export function buildCompletionPrompt(prefix: string, suffix: string, languageId: string, model: string): string {
  const lang = languageId || "code";
  if (supportsFim(model)) {
    return "<|fim_prefix|>" + prefix + "<|fim_suffix|>" + suffix + "<|fim_middle|>";
  }
  return "You are a code completion engine. Complete the code at the cursor. "
    + "Reply with ONLY the code that should be inserted at the cursor — no explanation, no markdown fences, no repeating the existing code.\n\n"
    + "Language: " + lang + "\n\n"
    + "Code before the cursor:\n" + prefix + "\n\n"
    + "Code after the cursor:\n" + suffix + "\n\n"
    + "Completion:\n";
}

/**
 * Clean a raw model reply into insertable ghost text.
 * Strips markdown fences, trims, drops an echo of the prefix tail, and
 * caps the suggestion at INLINE_COMPLETION_MAX_LINES / MAX_CHARS.
 * Returns "" when there is nothing worth showing.
 */
export function cleanCompletion(raw: string, prefix: string): string {
  if (!raw || typeof raw !== "string") {
    return "";
  }
  let text = raw.replace(/^\s*```[a-zA-Z]*\s*\n/, "").replace(/\n\s*```\s*$/, "").trim();
  if (!text) {
    return "";
  }
  // The model sometimes echoes the last line of the prefix before
  // continuing it — drop that echo so the ghost text is only new code.
  const prefixLines = prefix.split("\n").filter((l) => l.trim() !== "");
  const lastPrefixLine = prefixLines.length ? prefixLines[prefixLines.length - 1].trim() : "";
  if (lastPrefixLine) {
    const firstLine = text.split("\n")[0].trim();
    if (firstLine === lastPrefixLine) {
      text = text.split("\n").slice(1).join("\n").trim();
    }
  }
  if (!text) {
    return "";
  }
  const lines = text.split("\n").slice(0, INLINE_COMPLETION_MAX_LINES);
  text = lines.join("\n");
  if (text.length > INLINE_COMPLETION_MAX_CHARS) {
    text = text.slice(0, INLINE_COMPLETION_MAX_CHARS);
    const cut = text.lastIndexOf("\n");
    text = (cut > 0 ? text.slice(0, cut) : text).trimEnd();
  }
  return text.trim();
}

/** Minimal config shape the provider needs (a vscode WorkspaceConfiguration satisfies it). */
export interface InlineCompletionConfigSource {
  get<T>(key: string, defaultValue: T): T;
}

export interface InlineCompletionConfig {
  delayMs: number;
  enabled: boolean;
  host: string;
  model: string;
}

/** Read the inline-completion settings, applying defaults and clamping the delay. */
export function readInlineCompletionConfig(cfg: InlineCompletionConfigSource): InlineCompletionConfig {
  const enabled = cfg.get<boolean>("inlineCompletion.enabled", INLINE_COMPLETION_DEFAULTS.enabled);
  const rawDelay = cfg.get<number>("inlineCompletion.delayMs", INLINE_COMPLETION_DEFAULTS.delayMs);
  const delayMs = typeof rawDelay === "number" && isFinite(rawDelay)
    ? Math.min(5000, Math.max(0, Math.floor(rawDelay)))
    : INLINE_COMPLETION_DEFAULTS.delayMs;
  return {
    delayMs,
    enabled: enabled !== false,
    host: cfg.get<string>("ollamaHost", "http://localhost:11434") || "http://localhost:11434",
    model: cfg.get<string>("model", "qwen2.5-coder:7b") || "qwen2.5-coder:7b"
  };
}

function trimHost(url: string): string {
  return (url || "").replace(/\/+$/, "");
}

/**
 * Ask Ollama for one completion. Non-streaming /api/generate call with a
 * short timeout. Returns the cleaned suggestion, or null on ANY failure
 * (unreachable host, bad status, bad JSON, timeout, abort) — the caller
 * shows nothing instead of erroring, per the silence rule.
 */
export async function fetchInlineCompletion(
  host: string,
  model: string,
  prompt: string,
  prefix: string,
  signal?: AbortSignal
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const onAbort = () => controller.abort();
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
    const res = await fetch(trimHost(host) + "/api/generate", {
      body: JSON.stringify({
        model,
        options: {
          num_predict: 128,
          stop: ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>"],
          temperature: 0.2
        },
        prompt,
        stream: false
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
    if (!res.ok) {
      return null;
    }
    const data: any = await res.json().catch(() => null);
    const raw = typeof data?.response === "string" ? data.response : "";
    const cleaned = cleanCompletion(raw, prefix);
    return cleaned || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
