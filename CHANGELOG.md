# Changelog

## 0.9.37

- **Inline code completion (ghost text as you type).** As you type in a code file, LocalNest asks your local Ollama model to complete the current line/statement and shows it as ghost text — accept with **Tab**, ignore it by just keep typing. It uses fill-in-the-middle prompting for FIM-capable code models (qwen2.5-coder, Code Llama, DeepSeek Coder, StarCoder, …) and a prefix/suffix instruction prompt for other models, always respecting your configured `localNest.model` (default `qwen2.5-coder:7b`). Debounced, so it does not fire on every keystroke. Silent when Ollama is unreachable — no popups, no notifications, just no ghost text. Nothing is sent anywhere except your configured Ollama host; no new cloud calls, no new keys, no telemetry. Settings: `localNest.inlineCompletion.enabled` (default `true`) and `localNest.inlineCompletion.delayMs` (default `300` ms).

## 0.9.36

- **Auto-fix diagnostics (`/autofix`).** Reads VS Code diagnostics for the current file (`/autofix all` for the whole workspace) and proposes fixes through the existing review-and-approve flow — FILE blocks you approve file by file, never auto-applied.
- **Codebase Q&A (`/qa`).** Ask about your workspace — grounded in the actual files, with file:line citations.
