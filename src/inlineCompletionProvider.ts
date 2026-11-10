import * as vscode from "vscode";
import {
  buildCompletionPrompt,
  fetchInlineCompletion,
  INLINE_COMPLETION_LANGUAGES,
  INLINE_COMPLETION_MAX_PREFIX_CHARS,
  INLINE_COMPLETION_MAX_SUFFIX_CHARS,
  readInlineCompletionConfig,
  sleep
} from "./inlineCompletion";

/**
 * Ghost-text inline completion backed by the local Ollama model.
 *
 * - Debounced: each keystroke restarts the delay, so Ollama is not hit on
 *   every keystroke; a newer request cancels the older in-flight fetch.
 * - Silent: Ollama unreachable (or any other failure) just means no ghost
 *   text — no popups, no notifications, no status-bar change.
 * - Isolated: shares nothing with the Ask/Plan/Agent chat, /autofix, /qa
 *   or any other feature — it only reads localNest.model / ollamaHost and
 *   its own localNest.inlineCompletion.* settings.
 * - Accepted with Tab, like any VS Code inline suggestion.
 */
export class LocalNestInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private abort: AbortController | null = null;
  private requestId = 0;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const cfg = readInlineCompletionConfig(vscode.workspace.getConfiguration("localNest"));
    if (!cfg.enabled) {
      return [];
    }
    // Debounce: wait delayMs; if a newer keystroke arrived meanwhile, this
    // request is stale and yields nothing.
    const id = ++this.requestId;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    try { token.onCancellationRequested(() => abort.abort()); } catch { /* ignore */ }
    await sleep(cfg.delayMs);
    if (id !== this.requestId || abort.signal.aborted) {
      return [];
    }

    let prefix = "";
    let suffix = "";
    try {
      const full = document.getText();
      const offset = document.offsetAt(position);
      prefix = full.slice(Math.max(0, offset - INLINE_COMPLETION_MAX_PREFIX_CHARS), offset);
      suffix = full.slice(offset, offset + INLINE_COMPLETION_MAX_SUFFIX_CHARS);
    } catch {
      return [];
    }
    if (!prefix.trim()) {
      return [];
    }
    const prompt = buildCompletionPrompt(prefix, suffix, document.languageId, cfg.model);
    let completion: string | null = null;
    try {
      completion = await fetchInlineCompletion(cfg.host, cfg.model, prompt, prefix, abort.signal);
    } catch {
      completion = null;
    }
    if (id !== this.requestId || abort.signal.aborted || !completion) {
      return [];
    }
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }
}

/**
 * Register the inline provider for code files. Best-effort: returns the
 * disposable, or undefined when the API is unavailable (older host), so
 * activation never fails because of completion.
 */
export function registerInlineCompletion(context: vscode.ExtensionContext): vscode.Disposable | undefined {
  try {
    const languages = (vscode as any).languages;
    if (!languages || typeof languages.registerInlineCompletionItemProvider !== "function") {
      return undefined;
    }
    const selector: vscode.DocumentSelector = INLINE_COMPLETION_LANGUAGES.map((language) => ({ language, scheme: "file" }));
    const provider = new LocalNestInlineCompletionProvider();
    const disposable = languages.registerInlineCompletionItemProvider(selector, provider);
    context.subscriptions.push(disposable);
    return disposable;
  } catch {
    return undefined;
  }
}
