import * as vscode from "vscode";
import { exec } from "child_process";
import { checkHealth, chatStream, listModels } from "./ollama";
import { collectContext, contextToPrompt } from "./context";
import { applyUnifiedDiff, isDangerousCommand, parseDiffProposal, parseProposal, ProposedFile, Proposal } from "./proposal";
import { estimateTokens, trimHistory, LlmMessage } from "./llm";
import { checkOpenAi, openAiChatStream } from "./openai";
import { buildTemplateApp } from "./templates";
import { buildMajorTemplateApp, isMajorRequest } from "./majorTemplates";
import { buildRootForPrompt, desktopDir, resolveTargetRoot, TargetKind } from "./desktop";
import { checkGemini, geminiChatStream } from "./gemini";
import { buildLanguageProject, detectLanguage, platformInfo } from "./languages";

type Mode = "ask" | "plan" | "agent" | "build";

let currentProposal: Proposal | null = null;
let currentProposalRoot: vscode.Uri | undefined;
let currentRequestRoot: vscode.Uri | undefined;
let lastSnapshot: Map<string, string | null> | null = null;
let lastSnapshotRoot: vscode.Uri | undefined;
let lastSnapshotLabel = "";
let view: vscode.WebviewView | undefined;
let statusBar: vscode.StatusBarItem;
// Full desktop access is opt-in, per message from the panel, never on by
// default: the user ticks it when they want files/commands outside the
// open folder. When it is off, everything stays in the workspace.
let fullAccessEnabled = false;
let targetKind: TargetKind = "workspace";
let targetCustom = "";
let secretStorage: vscode.SecretStorage | undefined;
let agenticLoopEnabled = true;
interface AgentState {
  autoApply: boolean;
  lastOutput: string;
  mode: Mode;
  step: number;
  task: string;
}
let agentState: AgentState | null = null;
let lastAppliedFiles: string[] = [];
let conversationHistory: LlmMessage[] = [];
let currentAbort: AbortController | null = null;
function stopGeneration() {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    view?.webview.postMessage({ text: "Stopped.", type: "assistant" });
  }
}
function clearConversation() {
  conversationHistory = [];
  view?.webview.postMessage({ text: "New chat started — history cleared.", type: "assistant" });
}

export function activate(context: vscode.ExtensionContext) {
  secretStorage = context.secrets;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "localNest.refreshOllama";
  statusBar.text = "○ Ollama: checking…";
  statusBar.tooltip = "Vyntra — click to refresh Ollama status";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const provider = new VyntraViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localNest.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localNest.openChat", async () => {
      await vscode.commands.executeCommand("localNest.chat.focus");
    }),
    vscode.commands.registerCommand("localNest.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Vyntra: select some code first, then ask for an explanation.");
        return;
      }
      const code = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      await vscode.commands.executeCommand("localNest.chat.focus");
      // Give the view a beat to resolve, then prefill + send.
      setTimeout(() => {
        view?.webview.postMessage({
          mode: "ask",
          text: "Explain this code from " + file + ":\n\n```\n" + code + "\n```",
          type: "prefill"
        });
      }, 400);
    }),
    vscode.commands.registerCommand("localNest.undoLastApply", async () => {
      await undoLastApply();
    }),
    vscode.commands.registerCommand("localNest.refreshOllama", async () => {
      await refreshStatus(true);
    }),
    vscode.commands.registerCommand("localNest.openDesktopFolder", async () => {
      targetKind = "desktop";
      await openTargetFolder();
    }),
    vscode.commands.registerCommand("localNest.listDesktop", async () => {
      await listDesktopFiles();
    }),
    vscode.commands.registerCommand("localNest.setOpenAIApiKey", async () => {
      const key = await vscode.window.showInputBox({
        password: true,
        placeHolder: "Paste your API key for your OpenAI-compatible provider (leave blank for local LM Studio)",
        prompt: "Vyntra stores this in VS Code Secret Storage, not in settings or files."
      });
      if (key === undefined) {
        return;
      }
      await secretStorage?.store("localNest.openaiApiKey", key.trim());
      vscode.window.showInformationMessage("Vyntra: OpenAI-compatible API key saved securely.");
      await refreshStatus(false);
    }),
    vscode.commands.registerCommand("localNest.newChat", async () => {
      clearConversation();
    }),
    vscode.commands.registerCommand("localNest.setGeminiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        password: true,
        placeHolder: "Paste your Gemini API key from Google AI Studio",
        prompt: "Vyntra stores this in VS Code Secret Storage, not in settings or files. Get a key at https://aistudio.google.com/app/apikey"
      });
      if (!key) {
        return;
      }
      await secretStorage?.store("localNest.geminiApiKey", key.trim());
      vscode.window.showInformationMessage("Vyntra: Gemini API key saved securely. Select Provider: Gemini in the panel to use gemini-3.8-flash.");
      await refreshStatus(false);
    })
  );

  void refreshStatus(false);
}

export function deactivate() {}

interface Config {
  autoFallback: boolean;
  geminiModel: string;
  host: string;
  lowBandwidth: boolean;
  maxFiles: number;
  model: string;
  openaiBaseUrl: string;
  openaiModel: string;
  provider: string;
  temperature: number;
}

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration("localNest");
  return {
    autoFallback: cfg.get<boolean>("autoFallback", true),
    geminiModel: cfg.get<string>("geminiModel", "gemini-3.8-flash"),
    host: cfg.get<string>("ollamaHost", "http://localhost:11434"),
    lowBandwidth: cfg.get<boolean>("lowBandwidth", false),
    maxFiles: cfg.get<number>("maxContextFiles", 8),
    model: cfg.get<string>("model", "qwen2.5-coder:7b"),
    openaiBaseUrl: cfg.get<string>("openaiBaseUrl", "http://localhost:1234/v1"),
    openaiModel: cfg.get<string>("openaiModel", "local-model"),
    provider: cfg.get<string>("provider", "ollama"),
    temperature: cfg.get<number>("temperature", 0.2)
  };
}

function modelForProvider(cfg: Config): string {
  if (cfg.provider === "gemini") {
    return cfg.geminiModel;
  }
  if (cfg.provider === "openai") {
    return cfg.openaiModel;
  }
  return cfg.model;
}

async function getGeminiKey(): Promise<string> {
  try {
    const secret = await secretStorage?.get("localNest.geminiApiKey");
    if (secret) {
      return secret;
    }
  } catch {
    // fall through to settings / env
  }
  const cfg = vscode.workspace.getConfiguration("localNest");
  return cfg.get<string>("geminiApiKey", "") || process.env.GEMINI_API_KEY || "";
}

async function getOpenAIKey(): Promise<string> {
  try {
    const secret = await secretStorage?.get("localNest.openaiApiKey");
    if (secret) {
      return secret;
    }
  } catch {
    // fall through
  }
  const cfg = vscode.workspace.getConfiguration("localNest");
  return cfg.get<string>("openaiApiKey", "") || process.env.OPENAI_API_KEY || "";
}

async function providerOnline(cfg: Config): Promise<boolean> {
  if (cfg.provider === "gemini") {
    const key = await getGeminiKey();
    if (!key) {
      return false;
    }
    return checkGemini(key);
  }
  if (cfg.provider === "openai") {
    const key = await getOpenAIKey();
    return checkOpenAi({ apiKey: key, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel });
  }
  return checkHealth(cfg.host);
}

async function* providerStream(cfg: Config, messages: LlmMessage[]): AsyncGenerator<string, void, unknown> {
  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  try {
    if (cfg.provider === "gemini") {
      const key = await getGeminiKey();
      if (!key) {
        throw new Error("No Gemini API key set. Run “Vyntra: Set Gemini API Key” from the Command Palette, or pick Ollama as the provider.");
      }
      yield* geminiChatStream(key, cfg.geminiModel, messages, cfg.lowBandwidth ? 4096 : 8192, cfg.temperature, signal);
      return;
    }
    if (cfg.provider === "openai") {
      const key = await getOpenAIKey();
      yield* openAiChatStream({ apiKey: key, baseUrl: cfg.openaiBaseUrl, maxTokens: cfg.lowBandwidth ? 4096 : 8192, model: cfg.openaiModel, temperature: cfg.temperature }, messages, signal);
      return;
    }
    yield* chatStream(cfg.host, cfg.model, messages, signal, cfg.lowBandwidth ? 4096 : undefined, cfg.temperature);
  } finally {
    if (currentAbort?.signal === signal) {
      currentAbort = null;
    }
  }
}

function workspaceRootUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined;
}

function baseTargetUri(): vscode.Uri | undefined {
  const root = resolveTargetRoot(targetKind, targetCustom, workspaceRootUri()?.fsPath);
  return root ? vscode.Uri.file(root) : undefined;
}

function buildTargetUri(prompt: string, mode: Mode): vscode.Uri | undefined {
  if (mode !== "build") {
    return workspaceRootUri();
  }
  const root = buildRootForPrompt(targetKind, targetCustom, workspaceRootUri()?.fsPath, prompt);
  return root ? vscode.Uri.file(root) : undefined;
}

function applyTargetFromMessage(msg: any) {
  if (typeof msg.fullAccess === "boolean") {
    fullAccessEnabled = msg.fullAccess;
  }
  if (msg.target === "workspace" || msg.target === "desktop" || msg.target === "home" || msg.target === "custom") {
    targetKind = msg.target as TargetKind;
  }
  if (typeof msg.customPath === "string") {
    targetCustom = msg.customPath;
  }
}

async function openTargetFolder() {
  const root = baseTargetUri();
  if (!root) {
    vscode.window.showWarningMessage("Vyntra: no folder is open and no target is set.");
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", root);
}

async function listDesktopFiles() {
  const dir = vscode.Uri.file(desktopDir());
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const names = entries.map((e) => (e[1] === vscode.FileType.Directory ? e[0] + "/" : e[0])).join(", ") || "(empty)";
    const msg = "Desktop (" + desktopDir() + "): " + names;
    view?.webview.postMessage({ text: msg, type: "assistant" });
    vscode.window.showInformationMessage(msg);
  } catch {
    const msg = "No Desktop folder found at " + desktopDir() + ". On this machine your home folder is the place to build — pick Home as the target, or a custom folder.";
    view?.webview.postMessage({ text: msg, type: "assistant" });
  }
}

async function refreshStatus(showToast: boolean): Promise<{ models: string[]; online: boolean }> {
  const cfg = getConfig();
  if (cfg.provider === "gemini") {
    const key = await getGeminiKey();
    // Supported cloud models: the two Flash models by default, plus any
    // custom Gemini model ID the user set in Settings — the extension
    // passes that ID straight to the Gemini API, so it is not locked
    // to one model.
    const models = ["gemini-3.8-flash", "gemini-2.5-flash"];
    if (cfg.geminiModel && !models.includes(cfg.geminiModel)) {
      models.push(cfg.geminiModel);
    }
    if (!key) {
      statusBar.text = "○ Gemini: no API key";
      statusBar.tooltip = "Vyntra — run “Vyntra: Set Gemini API Key” to use gemini-3.8-flash.";
      view?.webview.postMessage({ host: "Gemini API", model: cfg.geminiModel, models, online: false, provider: "gemini", type: "status" });
      if (showToast) {
        vscode.window.showWarningMessage("Vyntra: no Gemini API key set. Run “Vyntra: Set Gemini API Key”, or switch Provider back to Ollama.");
      }
      return { models, online: false };
    }
    const online = await checkGemini(key);
    statusBar.text = online ? "◉ GEMINI 3.8 FLASH" : "○ Gemini offline";
    statusBar.tooltip = online ? "Vyntra — Gemini API online, model " + cfg.geminiModel : "Vyntra — Gemini API not reachable. Check your key.";
    view?.webview.postMessage({ host: "Gemini API", model: cfg.geminiModel, models, online, provider: "gemini", type: "status" });
    return { models, online };
  }
  if (cfg.provider === "openai") {
    const key = await getOpenAIKey();
    const online = await checkOpenAi({ apiKey: key, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel });
    statusBar.text = online ? "◉ OPENAI-COMPAT" : "○ OpenAI host offline";
    statusBar.tooltip = online ? "Vyntra — OpenAI-compatible host online, model " + cfg.openaiModel : "Vyntra — OpenAI-compatible host not reachable at " + cfg.openaiBaseUrl;
    view?.webview.postMessage({ host: cfg.openaiBaseUrl, model: cfg.openaiModel, models: [cfg.openaiModel], online, provider: "openai", type: "status" });
    return { models: [cfg.openaiModel], online };
  }
  try {
    const models = await listModels(cfg.host);
    statusBar.text = "◉ LOCAL OLLAMA";
    statusBar.tooltip = "Vyntra — Ollama online at " + cfg.host + " (" + models.length + " models)";
    view?.webview.postMessage({ host: cfg.host, model: cfg.model, models, online: true, provider: "ollama", type: "status" });
    return { models, online: true };
  } catch {
    statusBar.text = "○ Ollama offline";
    statusBar.tooltip = "Vyntra — Ollama not reachable at " + cfg.host + ". Start Ollama, then click to retry.";
    view?.webview.postMessage({ host: cfg.host, model: cfg.model, models: [], online: false, provider: "ollama", type: "status" });
    if (showToast) {
      vscode.window.showWarningMessage(
        "Vyntra: Ollama is not reachable at " + cfg.host + ". Start it with `ollama serve`, then pull a model (e.g. ollama pull qwen2.5-coder:7b)."
      );
    }
    return { models: [], online: false };
  }
}

function systemPrompt(mode: Mode): string {
  const universal =
    "You are Vyntra, a general-purpose LLM for Antigravity, fluent in EVERY programming language — Python, Java, JavaScript, TypeScript, Go, Rust, C, C++, C#, Kotlin, Swift, PHP, Ruby, SQL, HTML/CSS and any other language the user names. Never default to JavaScript/web unless the user asked for it: if they name a language, use ONLY that language, its idioms, its project files (e.g. go.mod, Cargo.toml, pom.xml, requirements.txt, package.json) and its run commands. If they do not name a language, pick the best fit and say which one you picked in the README. " +
    platformInfo();
  if (mode === "plan") {
    return [
      universal,
      "You never claim a change has been made.",
      "Produce ONLY a plan, in this shape:",
      "Goal (one line)",
      "Steps (numbered, each naming the exact file to touch and what changes there)",
      "Risks / things to check",
      "Validation (commands or manual checks to prove it works)",
      "Do not write full file contents. Keep it short and concrete, grounded in the workspace context given."
    ].join("\n");
  }
  if (mode === "agent") {
    return [
      universal,
      "Propose changes; the user approves each one before anything is written.",
      "If a change is needed, output ONLY this format, nothing else before or after:",
      "### FILE: path/to/file.ext",
      "```language",
      "full new contents of that file",
      "```",
      "Repeat one block per changed file. Give FULL file contents, not diffs or snippets, and keep every unrelated line unchanged.",
      "If commands should run (tests, build), add at the end:",
      "### COMMANDS",
      "```sh",
      "npm test",
      "```",
      "If no change is needed, say so in plain text with no FILE blocks."
    ].join("\n");
  }
  if (mode === "build") {
    return [
      universal,
      "You build complete, working apps in ANY language the user names.",
      "The user wants a whole website or app. Build it fully — do not stop at a description, a skeleton, or TODO placeholders.",
      "Output ONLY this format, nothing else before or after:",
      "### FILE: index.html",
      "```html",
      "full, complete, working file contents",
      "```",
      "Repeat one block per file. For a website, index.html alone is fine if it is self-contained, otherwise add style.css, app.js and a README.md.",
      "For a Python/Go/Rust/Java/etc. app, include every file needed to run it in THAT language (entry file, go.mod/Cargo.toml/pom.xml/requirements.txt as appropriate, README with run commands for this device).",
      "Use real functionality: localStorage/file storage for persistence, free no-key APIs (like Open-Meteo) where live data is needed. Never invent an API key.",
      "If commands should run (install, test, start), add at the end:",
      "### COMMANDS",
      "```sh",
      "npm install",
      "```",
      "Keep every file complete and runnable. If the request is vague, pick sensible defaults and say what you picked in the README, not in extra prose."
    ].join("\n");
  }
  return [
    universal,
    "Answer ANY question the user asks — coding or general, about this workspace or not, in any programming language they ask for.",
    "Use the workspace context when it is relevant and cite file paths then. When it is not relevant, answer from your own knowledge and say so.",
    "Use code blocks for code. Be direct and complete: give the answer, the explanation, and a working example where one helps.",
    "Do not invent functions, files or APIs that are not in the context when you claim they are in this workspace. If you are unsure, say what is missing instead of guessing."
  ].join("\n");
}

async function handleChat(mode: Mode, text: string, autoApply: boolean, majorFlag: boolean) {
  const cfg = getConfig();
  currentRequestRoot = buildTargetUri(text, mode);
  agentState = { autoApply, lastOutput: "", mode, step: 1, task: text };
  const online = await providerOnline(cfg);
  const effectiveMaxFiles = cfg.lowBandwidth ? Math.max(3, Math.floor(cfg.maxFiles / 2)) : cfg.maxFiles;
  const ctx = await collectContext(text, effectiveMaxFiles, cfg.lowBandwidth);
  const contextPrompt = contextToPrompt(ctx.files);
  const lang = detectLanguage(text);
  const langNote = lang ? "\nTarget language: " + lang.name + " (main file " + lang.mainFile + ", run with: " + lang.runCommand + "). Use this language only." : "";
  // Step 1, made visible: inspect the workspace, context before code.
  view?.webview.postMessage({
    text: "Step 1 — Inspect workspace (context before code): " + ctx.summary + (ctx.files.length ? "\nTop files used as context: " + ctx.files.map((f) => f.path).join(", ") : "\nNo workspace files matched — answering from the model alone."),
    type: "assistant"
  });

  if (!online) {
    if (mode === "build") {
      // Build must still work without a model: language starter first if a
      // language was named, then major/small templates.
      const langProject = buildLanguageProject(text);
      const proposal = langProject
        ? { commands: [], files: langProject.files.map((f) => ({ content: f.content, exists: false, original: null, path: f.path })), raw: "Language starter: " + langProject.language.name }
        : isMajorRequest(text) || majorFlag
          ? buildMajorTemplateProposal(text)
          : buildTemplateProposal(text);
      await deliverProposal(proposal, autoApply, (cfg.provider === "gemini" ? "Gemini is not reachable (check your API key), so I built this from a working template instead. " : "Ollama is offline, so I built this from a working template instead of a model. Start Ollama for custom, model-generated projects. ") + "Files below are ready to review (or already created, if auto-create was on):");
      await refreshStatus(false);
      return;
    }
    const offline = [
      (cfg.provider === "gemini" ? "Gemini is not reachable at the moment (check your API key)." : "Ollama is offline at " + cfg.host + ", so I cannot generate an answer") + " — but here is what I found in this workspace without a model:",
      "",
      ctx.summary,
      "",
      ctx.files.length
        ? "Top matching files (open one and ask again once the model is running): " + ctx.files.map((f) => f.path).join(", ")
        : "No files matched that question.",
      "",
      cfg.provider === "gemini"
        ? "To go live: run “Vyntra: Set Gemini API Key” (key from https://aistudio.google.com/app/apikey), select Provider: Gemini, model gemini-3.8-flash, then press Refresh."
        : "To go live: `ollama serve` in a terminal, then `ollama pull qwen2.5-coder:7b` (or another code model), then press Refresh in this panel. You can also point Vyntra at a remote Ollama host in Settings, or switch Provider to Gemini for gemini-3.8-flash. No GPU setup is needed — Ollama runs on CPU by default.",
      "Tip: Build mode still works offline — it creates a working website/app from a built-in template."
    ].join("\n");
    view?.webview.postMessage({ text: offline, type: "assistant" });
    await refreshStatus(false);
    return;
  }

  // Major projects: blueprint first, then generate in small batches so a
  // local model does not truncate a 20-file project into one huge reply.
  if (online && mode === "build" && (majorFlag || isMajorRequest(text))) {
    const built = await tryBuildMajorProject(cfg, text, autoApply);
    if (built) {
      return;
    }
    // If the blueprint path failed, fall through to the single-shot build
    // below, which itself falls back to a major template if needed.
  }

  const userTurn: LlmMessage = {
    content: "Workspace context:\n" + ctx.summary + "\n\n" + contextPrompt + "\n\nUser request:\n" + text + langNote + "\n" + platformInfo(),
    role: "user"
  };
  conversationHistory = trimHistory([...conversationHistory, userTurn]);
  const messages: LlmMessage[] = [
    { content: systemPrompt(mode), role: "system" },
    ...conversationHistory
  ];

  let full = "";
  let streamError: any = null;
  const startedAt = Date.now();
  try {
    for await (const chunk of providerStream(cfg, messages)) {
      full += chunk;
      view?.webview.postMessage({ text: chunk, type: "stream" });
    }
  } catch (err: any) {
    streamError = err;
  }
  if (!streamError && full) {
    conversationHistory = trimHistory([...conversationHistory, { content: full, role: "assistant" }]);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    view?.webview.postMessage({ text: "— " + secs + "s · ~" + estimateTokens(full) + " tokens in this reply (estimate, 1 token ≈ 4 chars) · history: " + conversationHistory.length + " message(s) kept", type: "assistant" });
  }
  if (streamError && String(streamError?.name || "") === "AbortError") {
    view?.webview.postMessage({ text: "Generation stopped by you. The partial reply was not saved to history.", type: "assistant" });
    // Remove the user turn that was not answered, so the next turn is clean.
    conversationHistory = conversationHistory.slice(0, -1);
    return;
  }
  if (streamError && cfg.autoFallback) {
    // Any network: if Gemini (internet) fails, try local Ollama; if Ollama
    // fails, try Gemini if a key is set. This is what makes it work on
    // offline, slow, hotspot or proxy networks — it degrades, not dies.
    const fallbackCfg: Config = { ...cfg, provider: cfg.provider === "gemini" ? "ollama" : "gemini" };
    const fallbackOnline = await providerOnline(fallbackCfg);
    if (fallbackOnline) {
      view?.webview.postMessage({ text: "Note: " + modelForProvider(cfg) + " was unreachable on this network, so I switched to " + modelForProvider(fallbackCfg) + " for this reply.", type: "assistant" });
      full = "";
      try {
        for await (const chunk of providerStream(fallbackCfg, messages)) {
          full += chunk;
          view?.webview.postMessage({ text: chunk, type: "stream" });
        }
        streamError = null;
        if (full) {
          conversationHistory = trimHistory([...conversationHistory, { content: full, role: "assistant" }]);
        }
      } catch (err2: any) {
        streamError = err2;
      }
    }
  }
  if (streamError) {
    if (mode === "build") {
      view?.webview.postMessage({ type: "streamDone" });
      const langProject = buildLanguageProject(text);
      const proposal = langProject
        ? { commands: [], files: langProject.files.map((f) => ({ content: f.content, exists: false, original: null, path: f.path })), raw: "Language starter" }
        : isMajorRequest(text) || majorFlag
          ? buildMajorTemplateProposal(text)
          : buildTemplateProposal(text);
      await deliverProposal(proposal, autoApply, "The model could not be reached on this network, so I built this from a working template instead. Check that " + (cfg.provider === "gemini" ? "your Gemini API key is set" : "Ollama is running and the model is pulled") + " for custom builds.");
      return;
    }
    view?.webview.postMessage({
      text: "Vyntra could not reach the model: " + String(streamError?.message || streamError) + "\nCheck that " + (cfg.provider === "gemini" ? "your Gemini API key is set and gemini-3.8-flash is enabled for it" : "Ollama is running and the model `" + cfg.model + "` is pulled") + ". If you are offline, Build mode still works from templates.",
      type: "assistant"
    });
    return;
  }

  if (mode === "agent" || mode === "build") {
    let proposal = parseProposal(full);
    if (proposal.files.length === 0) {
      // Diff format: model sent small diffs instead of full files.
      const diffProposal = parseDiffProposal(full);
      if (diffProposal.files.length > 0) {
        // Resolve each diff against the current file on disk (hydrated below).
        const root = currentRequestRoot || workspaceRootUri();
        const resolved: ProposedFile[] = [];
        for (const d of diffProposal.files) {
          let original: string | null = null;
          if (root) {
            try {
              const uri = d.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d.path) ? vscode.Uri.file(d.path) : vscode.Uri.joinPath(root, d.path);
              original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
            } catch {
              original = null;
            }
          }
          const applied = original !== null ? applyUnifiedDiff(original, d.content) : null;
          if (applied !== null) {
            resolved.push({ content: applied, exists: true, original, path: d.path });
          } else if (original === null) {
            // New file diff: added lines are the file.
            const added = d.content.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
            if (added) {
              resolved.push({ content: added, exists: false, original: null, path: d.path });
            }
          }
        }
        if (resolved.length > 0) {
          proposal = { commands: diffProposal.commands, files: resolved, raw: full };
        }
      }
    }
    if (proposal.files.length > 0) {
      await deliverProposal(proposal, autoApply, mode === "build" ? "Built app ready — see the files below." : "Proposal ready below — nothing has been written yet. Review each file, then approve the ones you want. Commands, if any, run only after you press “Run approved commands”.");
      if (agenticLoopEnabled && autoApply) {
        await runAgenticLoop(cfg, proposal);
      } else if (agenticLoopEnabled && !autoApply) {
        view?.webview.postMessage({ text: "Agentic loop is on: approve the files above, then press “Continue agent” and I will verify the result and fix anything that is still missing, up to 5 steps.", type: "assistant" });
      }
    } else if (mode === "build") {
      view?.webview.postMessage({ type: "streamDone" });
      const langProject = buildLanguageProject(text);
      const proposal = langProject
        ? { commands: [], files: langProject.files.map((f) => ({ content: f.content, exists: false, original: null, path: f.path })), raw: "Language starter" }
        : isMajorRequest(text) || majorFlag
          ? buildMajorTemplateProposal(text)
          : buildTemplateProposal(text);
      await deliverProposal(proposal, autoApply, "The model did not return files in the expected format, so I built a working version from a template. Ask again in Build mode with more detail for a custom version.");
    } else {
      view?.webview.postMessage({ type: "streamDone" });
    }
  } else {
    view?.webview.postMessage({ type: "streamDone" });
    if (mode === "plan") {
      // Plan never writes. Offer the next step explicitly:
      // "Build this plan" carries this exact plan into Agent mode.
      view?.webview.postMessage({ text: full, type: "planReady" });
    }
  }
}

function buildTemplateProposal(text: string): Proposal {
  const app = buildTemplateApp(text);
  return {
    commands: [],
    files: app.files.map((f) => ({ content: f.content, exists: false, original: null, path: f.path })),
    raw: app.description
  };
}

function buildMajorTemplateProposal(text: string): Proposal {
  const app = buildMajorTemplateApp(text);
  return {
    commands: [],
    files: app.files.map((f) => ({ content: f.content, exists: false, original: null, path: f.path })),
    raw: app.description
  };
}

async function chatOnce(cfg: Config, messages: { content: string; role: "assistant" | "system" | "user" }[]): Promise<string> {
  let full = "";
  for await (const chunk of providerStream(cfg, messages)) {
    full += chunk;
  }
  return full;
}

interface BlueprintFile {
  path: string;
  purpose: string;
}

function parseBlueprint(text: string): { commands: string[]; files: BlueprintFile[]; name: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed: any = JSON.parse(text.slice(start, end + 1));
    const files: BlueprintFile[] = (parsed.files || [])
      .map((f: any) => ({ path: String(f.path || ""), purpose: String(f.purpose || "") }))
      .filter((f: BlueprintFile) => f.path && !f.path.includes(".."));
    if (files.length < 3) {
      return null;
    }
    return { commands: (parsed.commands || []).map(String), files: files.slice(0, 24), name: String(parsed.name || "project") };
  } catch {
    return null;
  }
}

async function tryBuildMajorProject(cfg: Config, text: string, autoApply: boolean): Promise<boolean> {
  try {
    view?.webview.postMessage({ text: "Major project detected — first planning the architecture, then building it file by file in batches. This takes longer than a single page, please wait.", type: "assistant" });
    const blueprintText = await chatOnce(cfg, [
      {
        content: "You plan major software projects. Output ONLY JSON, no other text, in this shape: {\"name\": \"project-name\", \"files\": [{\"path\": \"index.html\", \"purpose\": \"what this file does\"}], \"commands\": [\"npm install\"]}. Include 8 to 20 files that together make a complete, runnable project: frontend, styling, logic, data and README. Prefer plain HTML/CSS/JS or Node with no heavy dependencies unless the user asked for a framework.",
        role: "system"
      },
      { content: "Plan this major project: " + text, role: "user" }
    ]);
    const blueprint = parseBlueprint(blueprintText);
    if (!blueprint) {
      return false;
    }
    const allFiles: ProposedFile[] = [];
    const allCommands: string[] = [...blueprint.commands];
    const batches: BlueprintFile[][] = [];
    for (let i = 0; i < blueprint.files.length; i += 3) {
      batches.push(blueprint.files.slice(i, i + 3));
    }
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      view?.webview.postMessage({ text: "Building batch " + (b + 1) + " of " + batches.length + ": " + batch.map((f) => f.path).join(", "), type: "assistant" });
      const batchText = await chatOnce(cfg, [
        {
          content: "You build major projects file by file. Output ONLY this format, nothing else: ### FILE: path\n```language\nfull file contents\n``` repeated per file. Give FULL, runnable contents, keep names and imports consistent with the project plan, and never use placeholders.",
          role: "system"
        },
        {
          content: "Project: " + blueprint.name + ". User request: " + text + ". Generate ONLY these files, in order: " + batch.map((f) => f.path + " (" + f.purpose + ")").join(", ") + ".",
          role: "user"
        }
      ]);
      const parsed = parseProposal(batchText);
      for (const f of parsed.files) {
        if (!allFiles.some((x) => x.path === f.path)) {
          allFiles.push(f);
        }
      }
      if (parsed.commands.length > 0) {
        allCommands.push(...parsed.commands);
      }
    }
    if (allFiles.length < 3) {
      return false;
    }
    const proposal: Proposal = { commands: [...new Set(allCommands)], files: allFiles, raw: "Major project: " + blueprint.name };
    await deliverProposal(proposal, autoApply, "Major project ready: " + allFiles.length + " files planned as " + blueprint.name + " (" + blueprint.files.map((f) => f.path).join(", ") + "). " + (allFiles.length < blueprint.files.length ? "Note: " + (blueprint.files.length - allFiles.length) + " planned file(s) did not generate — ask Build to add them by name." : "") + " Review below, or they are already created if auto-create was on.");
    return true;
  } catch {
    return false;
  }
}

async function deliverProposal(proposal: Proposal, autoApply: boolean, intro: string) {
  const root = currentRequestRoot || workspaceRootUri();
  currentProposalRoot = root;
  await hydrateProposal(proposal, root);
  currentProposal = proposal;
  const targetNote = root && targetKind !== "workspace" ? "\nTarget folder: " + root.fsPath : "";
  if (autoApply) {
    const results: string[] = [];
    for (const f of proposal.files) {
      results.push(await applyFile(f.path));
    }
    lastAppliedFiles = proposal.files.map((f) => f.path);
    // applyFile captured the snapshot; clear the pending proposal so it cannot be applied twice.
    currentProposal = null;
    view?.webview.postMessage({
      text: intro + targetNote + "\nCreated (auto-create was on):\n" + results.join("\n") + "\nUndo is available via “Undo last approved changes”.",
      type: "assistant"
    });
    return;
  }
  view?.webview.postMessage({ proposal: serialiseProposal(proposal), type: "proposal" });
  const updates = proposal.files.filter((f) => f.exists).length;
  const news = proposal.files.length - updates;
  view?.webview.postMessage({ text: intro + targetNote + "\nStep 2 — Reviewed proposal, snapshot checks: " + proposal.files.length + " file(s) (" + updates + " update(s), " + news + " new file(s)). Originals are recorded, so Undo can restore them after approval. Nothing has been written yet — review each file, then approve explicitly.", type: "assistant" });
}

function serialiseProposal(p: Proposal) {
  return {
    commands: p.commands,
    files: p.files.map((f) => ({ exists: f.exists, path: f.path, preview: f.content.slice(0, 3000) + (f.content.length > 3000 ? "\n… (preview truncated — press View to see the full file)" : "") }))
  };
}

async function hydrateProposal(proposal: Proposal, root?: vscode.Uri) {
  const useRoot = root || workspaceRootUri();
  if (!useRoot) {
    return;
  }
  for (const file of proposal.files) {
    // Absolute paths (full desktop access) are used as-is; relative paths
    // join the proposal root (workspace, or Desktop/Home/Custom project).
    const uri = file.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file.path) ? vscode.Uri.file(file.path) : vscode.Uri.joinPath(useRoot, file.path);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      file.original = Buffer.from(bytes).toString("utf8");
      file.exists = true;
    } catch {
      file.original = null;
      file.exists = false;
    }
  }
}

function captureSnapshot(files: ProposedFile[]) {
  if (!lastSnapshot) {
    lastSnapshot = new Map();
    lastSnapshotRoot = currentProposalRoot;
    lastSnapshotLabel = new Date().toLocaleString();
    for (const f of files) {
      lastSnapshot.set(f.path, f.original);
    }
  }
}

async function applyFile(path: string): Promise<string> {
  if (!currentProposal) {
    return "No proposal is waiting.";
  }
  const file = currentProposal.files.find((f) => f.path === path);
  if (!file) {
    return "That file is not in the proposal.";
  }
  const root = currentProposalRoot || workspaceRootUri();
  if (!root) {
    return "No target folder — open a project folder, or pick Desktop/Home/Custom as the target.";
  }
  captureSnapshot(currentProposal.files);
  const uri = file.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file.path) ? vscode.Uri.file(file.path) : vscode.Uri.joinPath(root, path);
  try {
    await vscode.workspace.fs.createDirectory(root);
  } catch {
    // root may already exist
  }
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !file.path.startsWith("/")) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, dir));
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  return "Wrote " + uri.fsPath + (file.exists ? " (updated)" : " (new file)") + ". Undo is available via “Undo last approved changes”.";
}

async function undoLastApply(): Promise<void> {
  if (!lastSnapshot || lastSnapshot.size === 0) {
    vscode.window.showInformationMessage("Vyntra: nothing to undo — no approved changes yet.");
    view?.webview.postMessage({ text: "Nothing to undo yet.", type: "assistant" });
    return;
  }
  const root = lastSnapshotRoot || workspaceRootUri();
  if (!root) {
    return;
  }
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [path, original] of lastSnapshot) {
    const uri = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(root, path);
    if (original === null) {
      try {
        await vscode.workspace.fs.delete(uri);
        deleted.push(path);
      } catch {
        // already gone
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(original, "utf8"));
      restored.push(path);
    }
  }
  lastSnapshot = null;
  const msg =
    "Undid changes from " + lastSnapshotLabel + ". Restored: " + (restored.join(", ") || "none") + ". Deleted new files: " + (deleted.join(", ") || "none") + ".";
  vscode.window.showInformationMessage("Vyntra: " + msg);
  view?.webview.postMessage({ text: msg, type: "assistant" });
}

function runCommands(commands: string[], cwdUri?: vscode.Uri): Promise<string> {
  return new Promise((resolve) => {
    const root = cwdUri || currentProposalRoot || baseTargetUri() || workspaceRootUri();
    if (!root) {
      const msg = "No target folder — open a project folder, or pick Desktop/Home/Custom as the target.";
      view?.webview.postMessage({ text: msg, type: "assistant" });
      resolve(msg);
      return;
    }
    // Destructive commands are never run, even with full access: full
    // access means building anything, not wiping a disk. Sudo is also
    // refused because it needs a terminal password — run it yourself.
    const destructive = commands.filter((c) => /rm\s+-rf\s+\//.test(c) || /\bmkfs\b/.test(c) || />\s*\/dev\/sd/.test(c) || /:\(\)\s*\{/.test(c) || /\bsudo\b/.test(c));
    const blocked = fullAccessEnabled ? destructive : commands.filter((c) => isDangerousCommand(c));
    if (blocked.length > 0) {
      const blockedMsg = "Refused to run blocked command(s): " + blocked.join(", ") + ". Vyntra never runs disk formatting, rm -rf / or sudo — run those yourself in a terminal if you really mean them. Everything else for building (npm/pip install, git, build, test, start a server) is allowed" + (fullAccessEnabled ? " with full desktop access on." : ", and with full access on it runs in your chosen target folder.");
      view?.webview.postMessage({ text: blockedMsg, type: "assistant" });
      resolve(blockedMsg);
      return;
    }
    const safe = commands.filter((c) => !blocked.includes(c));
    if (safe.length === 0) {
      view?.webview.postMessage({ text: "No commands to run.", type: "assistant" });
      resolve("No commands to run.");
      return;
    }
    const joined = safe.join(" && ");
    exec(joined, { cwd: root.fsPath, timeout: 300000 }, (error, stdout, stderr) => {
      const out = [
        "Ran (in " + root.fsPath + "): " + joined,
        stdout ? "\nOutput:\n" + stdout.slice(0, 6000) : "",
        stderr ? "\nErrors:\n" + stderr.slice(0, 3000) : "",
        error ? "\nExit: " + String(error.message).slice(0, 500) : "\nExit: OK."
      ].join("");
      view?.webview.postMessage({ text: out, type: "assistant" });
      resolve(out);
    });
  });
}

async function runAgenticLoop(cfg: Config, firstProposal: Proposal) {
  if (!agentState) {
    return;
  }
  let lastOutput = "";
  if (firstProposal.commands.length > 0) {
    lastOutput = await runCommands(firstProposal.commands);
  }
  agentState.lastOutput = lastOutput;
  for (let step = 2; step <= 5; step++) {
    agentState.step = step;
    view?.webview.postMessage({ text: "Agent step " + step + "/5: verifying what was built and fixing anything still missing…", type: "assistant" });
    let verifyText = "";
    try {
      verifyText = await chatOnce(cfg, [
        {
          content: "You are an agentic coding assistant, like Gemini Flash for autonomous software work. You work step by step with tools: files already written, then verification, then fixes. If the task is complete, reply with exactly DONE on the first line and a short summary. Otherwise output ONLY this format: ### FILE: path\n```language\nfull file contents\n``` repeated per file that still needs creating or fixing. No placeholders, no extra prose before the FILE blocks.",
          role: "system"
        },
        {
          content: "Original task: " + agentState.task + "\nFiles already written: " + lastAppliedFiles.join(", ") + "\nLast command output: " + (lastOutput || "(no commands run)") + "\nIs the task fully done? If yes, say DONE. If not, give the next FILE blocks.",
          role: "user"
        }
      ]);
    } catch (err: any) {
      view?.webview.postMessage({ text: "Agent loop stopped: could not verify — " + String(err?.message || err), type: "assistant" });
      return;
    }
    const nextProposal = parseProposal(verifyText);
    if (nextProposal.files.length === 0) {
      view?.webview.postMessage({ text: "Agent done after step " + step + ": " + verifyText.slice(0, 1000), type: "assistant" });
      agentState = null;
      return;
    }
    // Verify step produced fixes: apply them the same way as step 1.
    currentRequestRoot = currentProposalRoot;
    await deliverProposal(nextProposal, true, "Agent step " + step + ": applying fixes.");
    if (nextProposal.commands.length > 0) {
      lastOutput = await runCommands(nextProposal.commands);
      agentState.lastOutput = lastOutput;
    }
  }
  view?.webview.postMessage({ text: "Agent loop reached 5 steps. The last batch is applied — check the result and ask for the next fix if anything remains.", type: "assistant" });
  agentState = null;
}

async function continueAgenticLoop() {
  if (!agentState) {
    view?.webview.postMessage({ text: "No agent task is waiting. Ask in Agent or Build mode first, then press Continue agent.", type: "assistant" });
    return;
  }
  const cfg = getConfig();
  const state = agentState;
  view?.webview.postMessage({ text: "Continuing agent (step " + (state.step + 1) + "): verifying the approved files and fixing anything still missing…", type: "assistant" });
  try {
    const verifyText = await chatOnce(cfg, [
      { content: "You are an agentic coding assistant. If the task is complete, reply DONE and a short summary. Otherwise output ONLY ### FILE blocks with full file contents for files that still need creating or fixing.", role: "system" },
      { content: "Original task: " + state.task + "\nFiles written/approved so far: " + lastAppliedFiles.join(", ") + "\nLast output: " + (state.lastOutput || "(none)") + "\nVerify and fix if needed.", role: "user" }
    ]);
    const nextProposal = parseProposal(verifyText);
    if (nextProposal.files.length === 0) {
      view?.webview.postMessage({ text: "Agent done: " + verifyText.slice(0, 1000), type: "assistant" });
      agentState = null;
      return;
    }
    state.step += 1;
    await deliverProposal(nextProposal, state.autoApply, "Agent continue step " + state.step + ": fixes ready below (or already applied, if auto-create was on).");
    if (state.autoApply) {
      await runAgenticLoop(cfg, nextProposal);
    }
  } catch (err: any) {
    view?.webview.postMessage({ text: "Continue agent failed: " + String(err?.message || err), type: "assistant" });
  }
}

class VyntraViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extContext: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === "chat") {
        applyTargetFromMessage(msg);
        if (typeof msg.agenticLoop === "boolean") {
          agenticLoopEnabled = msg.agenticLoop;
        }
        if (msg.provider === "ollama" || msg.provider === "gemini" || msg.provider === "openai") {
          const cfg = vscode.workspace.getConfiguration("localNest");
          await cfg.update("provider", msg.provider, vscode.ConfigurationTarget.Global);
        }
        if (typeof msg.lowBandwidth === "boolean") {
          const cfg = vscode.workspace.getConfiguration("localNest");
          await cfg.update("lowBandwidth", msg.lowBandwidth, vscode.ConfigurationTarget.Global);
        }
        await handleChat(msg.mode as Mode, String(msg.text || ""), msg.autoApply === true, msg.major === true);
      } else if (msg.type === "stop") {
        stopGeneration();
      } else if (msg.type === "newChat") {
        clearConversation();
      } else if (msg.type === "setOpenAIKey") {
        await vscode.commands.executeCommand("localNest.setOpenAIApiKey");
      } else if (msg.type === "temperature") {
        const cfg = vscode.workspace.getConfiguration("localNest");
        const temp = Number(msg.value);
        if (!Number.isNaN(temp) && temp >= 0 && temp <= 2) {
          await cfg.update("temperature", temp, vscode.ConfigurationTarget.Global);
        }
      } else if (msg.type === "continueAgent") {
        await continueAgenticLoop();
      } else if (msg.type === "setGeminiKey") {
        await vscode.commands.executeCommand("localNest.setGeminiApiKey");
      } else if (msg.type === "runCommand") {
        applyTargetFromMessage(msg);
        await runCommands([String(msg.command || "")], baseTargetUri());
      } else if (msg.type === "openFolder") {
        applyTargetFromMessage(msg);
        await openTargetFolder();
      } else if (msg.type === "listDesktop") {
        await listDesktopFiles();
      } else if (msg.type === "approveFile") {
        const result = await applyFile(String(msg.path));
        view?.webview.postMessage({ text: result, type: "assistant" });
      } else if (msg.type === "viewProposalFile") {
        // Review before approve: open the proposed content in a side
        // editor tab (untitled, so nothing is written to disk) next to
        // the original file, if one exists. This is the reviewable-change
        // "review edits" step — approve only after reading it.
        if (!currentProposal) {
          view?.webview.postMessage({ text: "No proposal is waiting.", type: "assistant" });
        } else {
          const file = currentProposal.files.find((f) => f.path === String(msg.path));
          if (!file) {
            view?.webview.postMessage({ text: "That file is not in the proposal.", type: "assistant" });
          } else {
            const ext = file.path.includes(".") ? file.path.slice(file.path.lastIndexOf(".") + 1) : "plaintext";
            const doc = await vscode.workspace.openTextDocument({ content: file.content, language: ext === "js" ? "javascript" : ext === "ts" ? "typescript" : ext });
            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
            view?.webview.postMessage({ text: "Opened proposed " + file.path + " beside the editor for review. Approve it only if it looks right; otherwise Discard proposal.", type: "assistant" });
          }
        }
      } else if (msg.type === "approveAll") {
        if (!currentProposal) {
          view?.webview.postMessage({ text: "No proposal is waiting.", type: "assistant" });
          return;
        }
        const results: string[] = [];
        for (const f of currentProposal.files) {
          results.push(await applyFile(f.path));
        }
        lastAppliedFiles = currentProposal.files.map((f) => f.path);
        view?.webview.postMessage({ text: results.join("\n"), type: "assistant" });
        // Step 4, visible: validation AFTER accepted edits.
        // Approve-all is the explicit approval; only then does validation
        // run, and any fix it proposes goes through review again.
        if (agenticLoopEnabled && agentState && (agentState.mode === "agent" || agentState.mode === "build")) {
          view?.webview.postMessage({ text: "Step 3 — Validation after accepted edits: checking the approved files and fixing anything still missing…", type: "assistant" });
          await continueAgenticLoop();
        }
      } else if (msg.type === "rejectProposal") {
        currentProposal = null;
        view?.webview.postMessage({ text: "Proposal discarded — nothing was written.", type: "assistant" });
      } else if (msg.type === "runCommands") {
        if (!currentProposal) {
          view?.webview.postMessage({ text: "No proposal is waiting.", type: "assistant" });
          return;
        }
        await runCommands(currentProposal.commands);
      } else if (msg.type === "undo") {
        await undoLastApply();
      } else if (msg.type === "refresh") {
        await refreshStatus(true);
      } else if (msg.type === "setModel") {
        const cfg = vscode.workspace.getConfiguration("localNest");
        const provider = cfg.get<string>("provider", "ollama");
        await cfg.update(provider === "gemini" ? "geminiModel" : (provider === "openai" ? "openaiModel" : "model"), String(msg.model), vscode.ConfigurationTarget.Global);
        view?.webview.postMessage({ text: "Model set to " + String(msg.model) + ".", type: "assistant" });
        await refreshStatus(false);
      }
    });
    void refreshStatus(false);
  }

  private html(): string {
    return [
      "<!DOCTYPE html><html><head><meta charset='utf-8'>",
      "<style>",
      "body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);margin:0;padding:12px;font-size:13px}",
      "h3{margin:0 0 4px} p{color:var(--vscode-descriptionForeground);line-height:1.45}",
      "#status{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px 10px;margin:8px 0;display:flex;gap:8px;align-items:center;justify-content:space-between}",
      "#status b{white-space:nowrap} select,input,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px}",
      "textarea{min-height:90px;resize:vertical}",
      ".modes{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap} .modes button{flex:1;padding:7px 4px;border-radius:6px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer} .modes button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}",
      "button.primary{width:100%;padding:9px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;cursor:pointer;margin-top:8px}",
      "button.small{padding:5px 8px;margin:4px 4px 0 0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border);border-radius:6px;cursor:pointer}",
      "#chat{margin-top:12px} .msg{white-space:pre-wrap;word-break:break-word;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:9px;margin:8px 0} .msg.user{background:var(--vscode-editor-background)} .msg.ai{background:var(--vscode-sideBar-background)}",
      "#proposal{border:2px solid var(--vscode-focusBorder);border-radius:10px;padding:10px;margin-top:12px;display:none} code{font-family:var(--vscode-editor-font-family)}",
      "</style></head><body>",
      "<h3>Vyntra</h3><p>Local-first, plug-and-play AI coding agent for VS Code / Antigravity. No separate IDE, no GPU configuration. Plan changes, review every edit before it is written, then verify it. Install, pick a model, ask.</p>",
      "<div id='status'><span><b id='dot'>○</b> <span id='host'>checking…</span></span><button class='small' id='refresh'>Refresh</button></div>",
      "<p style='font-size:12px'>Setup — pick one, no other setup needed: <b>Local (private):</b> install Ollama, run <code>ollama serve</code> + <code>ollama pull qwen2.5-coder:7b</code> (any Ollama model works, or point Ollama Host at your own remote Ollama host). <b>Cloud:</b> press Set Gemini API Key. <b>No model yet:</b> Ask still searches this workspace and Build still creates working templates offline.</p>",
      "<p style='font-size:12px'>Local-first: with Ollama, your code never leaves this machine. With Gemini, code goes only to the Google API you chose — Vyntra has no telemetry and makes no other network calls. No GPU/CUDA settings exist in this extension; Ollama manages hardware itself and runs on CPU by default.</p>",
      "<label>Provider</label><select id='provider'><option value='ollama'>Ollama (local, private)</option><option value='gemini'>Gemini 3.8 Flash (Google API)</option><option value='openai'>OpenAI-compatible (LM Studio / OpenRouter / Groq / any /v1 API)</option></select>",
      "<button class='small' id='setGeminiKey'>Set Gemini API Key (secure)</button><button class='small' id='setOpenAIKey'>Set OpenAI-compatible API Key (secure)</button>",
      "<label>Model</label><select id='model'><option>qwen2.5-coder:7b</option></select>",
      "<label style='display:block;margin-top:8px'>Temperature (0 = precise code, 1 = creative, 2 = wild) — default 0.2</label><input id='temperature' type='number' min='0' max='2' step='0.1' value='0.2'>",
      "<label style='display:block;margin-top:8px'>Build target</label><select id='target'><option value='workspace'>This project folder</option><option value='desktop'>Desktop (own project folder)</option><option value='home'>Home folder (own project folder)</option><option value='custom'>Custom folder...</option></select>",
      "<input id='customPath' placeholder='Custom folder, e.g. ~/Projects/my-app' style='display:none;margin-top:6px'>",
      "<label style='display:block;margin-top:8px'><input type='checkbox' id='fullAccess' style='width:auto'> Full desktop access — allow files &amp; commands outside this folder (Desktop, Home, custom paths)</label>",
      "<div class='modes'><button data-mode='ask' class='on'>Ask</button><button data-mode='plan'>Plan</button><button data-mode='agent'>Agent</button><button data-mode='build'>Build</button></div>",
      "<textarea id='input' placeholder='Ask anything, or in Build mode: create a todo website, a weather app, a portfolio…'></textarea>",
      "<label style='display:block;margin-top:8px'><input type='checkbox' id='autoApply' style='width:auto'> Auto-create without review — skips per-file approval (not the default workflow; you can still Undo)</label>",
      "<label style='display:block;margin-top:4px'><input type='checkbox' id='majorProject' style='width:auto'> Major project (multi-file, built in batches — also auto-detected for shop, blog, dashboard, full-stack, etc.)</label>",
      "<label style='display:block;margin-top:4px'><input type='checkbox' id='agenticLoop' style='width:auto' checked> Agentic loop — keep working until done (max 5 steps, verify + fix)</label>",
      "<label style='display:block;margin-top:4px'><input type='checkbox' id='lowBandwidth' style='width:auto'> Low-bandwidth / slow network — smaller context, smaller replies</label>",
      "<button class='primary' id='send'>Send to agent</button><div><button class='small' id='stopBtn'>Stop generation</button><button class='small' id='newChat'>New chat (clear history)</button></div>",
      "<button class='small' id='buildPlan' style='display:none'>Build this plan (Agent mode)</button>",
      "<div><button class='small' id='continueAgent'>Verify &amp; fix (Continue agent)</button><button class='small' id='undo'>Undo last approved changes</button><button class='small' id='openFolder'>Open target folder</button><button class='small' id='listDesktop'>List Desktop</button></div>",
      "<div style='margin-top:10px'><label>Run any command in the target folder</label><input id='cmdInput' placeholder='e.g. npm install, git status, python3 -m http.server 8000'><button class='small' id='runAnyCmd'>Run command</button></div>",
      "<div id='proposal'><b>Proposal — nothing written yet</b><div id='files'></div><div id='cmds'></div>",
      "<button class='primary' id='approveAll'>Approve all files</button>",
      "<button class='small' id='runCmds'>Run approved commands</button><button class='small' id='reject'>Discard proposal</button></div>",
      "<div id='chat'></div>",
      "<script>",
      "var vscode = acquireVsCodeApi(); var mode = 'ask'; var currentBubble = null; var lastPlan = '';",
      "function addMsg(text, cls){ var d=document.createElement('div'); d.className='msg '+cls; d.textContent=text; document.getElementById('chat').appendChild(d); return d; }",
      "function targetInfo(){ return {target: document.getElementById('target').value, customPath: document.getElementById('customPath').value, fullAccess: document.getElementById('fullAccess').checked}; }",
      "function send(){ var t=document.getElementById('input').value.trim(); if(!t) return; addMsg(t,'user'); currentBubble = addMsg('Thinking…','ai'); var ti=targetInfo(); vscode.postMessage({type:'chat', mode:mode, text:t, autoApply: document.getElementById('autoApply').checked, major: document.getElementById('majorProject').checked, agenticLoop: document.getElementById('agenticLoop').checked, lowBandwidth: document.getElementById('lowBandwidth').checked, provider: document.getElementById('provider').value, target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); }",
      "document.getElementById('setGeminiKey').addEventListener('click', function(){ vscode.postMessage({type:'setGeminiKey'}); });",
      "document.getElementById('setOpenAIKey').addEventListener('click', function(){ vscode.postMessage({type:'setOpenAIKey'}); });",
      "document.getElementById('stopBtn').addEventListener('click', function(){ vscode.postMessage({type:'stop'}); });",
      "document.getElementById('newChat').addEventListener('click', function(){ document.getElementById('chat').innerHTML=''; vscode.postMessage({type:'newChat'}); });",
      "document.getElementById('temperature').addEventListener('change', function(e){ vscode.postMessage({type:'temperature', value:e.target.value}); });",
      "document.getElementById('continueAgent').addEventListener('click', function(){ vscode.postMessage({type:'continueAgent'}); });",
      "document.getElementById('target').addEventListener('change', function(e){ document.getElementById('customPath').style.display = e.target.value==='custom' ? 'block' : 'none'; });",
      "document.getElementById('openFolder').addEventListener('click', function(){ var ti=targetInfo(); vscode.postMessage({type:'openFolder', target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); });",
      "document.getElementById('listDesktop').addEventListener('click', function(){ vscode.postMessage({type:'listDesktop'}); });",
      "document.getElementById('runAnyCmd').addEventListener('click', function(){ var c=document.getElementById('cmdInput').value.trim(); if(!c) return; addMsg('Run: '+c,'user'); var ti=targetInfo(); vscode.postMessage({type:'runCommand', command:c, target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); });",
      "document.getElementById('send').addEventListener('click', send);",
      "document.getElementById('buildPlan').addEventListener('click', function(){ if(!lastPlan) return; addMsg('Build this plan','user'); currentBubble = addMsg('Thinking…','ai'); var ti=targetInfo(); mode='agent'; document.querySelectorAll('.modes button').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-mode')==='agent'); }); vscode.postMessage({type:'chat', mode:'agent', text:'Build this plan exactly:\n'+lastPlan, autoApply: document.getElementById('autoApply').checked, major: document.getElementById('majorProject').checked, agenticLoop: document.getElementById('agenticLoop').checked, lowBandwidth: document.getElementById('lowBandwidth').checked, provider: document.getElementById('provider').value, target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); document.getElementById('buildPlan').style.display='none'; });",
      "document.getElementById('input').addEventListener('keydown', function(e){ if(e.key==='Enter' && (e.metaKey || e.ctrlKey)){ send(); } });",
      "document.querySelectorAll('.modes button').forEach(function(b){ b.addEventListener('click', function(){ mode=b.getAttribute('data-mode'); document.querySelectorAll('.modes button').forEach(function(x){ x.classList.toggle('on', x===b); }); }); });",
      "document.getElementById('refresh').addEventListener('click', function(){ vscode.postMessage({type:'refresh'}); });",
      "document.getElementById('undo').addEventListener('click', function(){ vscode.postMessage({type:'undo'}); });",
      "document.getElementById('model').addEventListener('change', function(e){ vscode.postMessage({type:'setModel', model:e.target.value}); });",
      "document.getElementById('approveAll').addEventListener('click', function(){ vscode.postMessage({type:'approveAll'}); });",
      "document.getElementById('reject').addEventListener('click', function(){ document.getElementById('proposal').style.display='none'; vscode.postMessage({type:'rejectProposal'}); });",
      "document.getElementById('runCmds').addEventListener('click', function(){ vscode.postMessage({type:'runCommands'}); });",
      "window.addEventListener('message', function(ev){ var m=ev.data;",
      " if(m.type==='status'){ var label = m.provider==='gemini' ? 'GEMINI 3.8 FLASH' : 'LOCAL OLLAMA'; document.getElementById('dot').textContent = m.online ? '◉ '+label : '○ '+(m.provider==='gemini' ? 'Gemini offline / no key' : 'Ollama offline'); document.getElementById('host').textContent = m.host + (m.online ? ' — ' + m.models.length + ' model(s)' : ' — '+(m.provider==='gemini' ? 'set API key to go live' : 'start Ollama to go live')); if(m.provider) document.getElementById('provider').value=m.provider; var sel=document.getElementById('model'); if(m.models && m.models.length){ sel.innerHTML=''; m.models.forEach(function(name){ var o=document.createElement('option'); o.textContent=name; o.value=name; if(name===m.model) o.selected=true; sel.appendChild(o); }); } }",
      " else if(m.type==='stream'){ if(!currentBubble) currentBubble=addMsg('','ai'); if(currentBubble.textContent==='Thinking…') currentBubble.textContent=''; currentBubble.textContent += m.text; }",
      " else if(m.type==='assistant'){ currentBubble=null; addMsg(m.text,'ai'); }",
      " else if(m.type==='streamDone'){ currentBubble=null; }",
      " else if(m.type==='planReady'){ lastPlan=m.text; document.getElementById('buildPlan').style.display='block'; }",
      " else if(m.type==='prefill'){ document.getElementById('input').value=m.text; mode=m.mode||'ask'; document.querySelectorAll('.modes button').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-mode')===mode); }); send(); }",
      " else if(m.type==='proposal'){ var box=document.getElementById('proposal'); box.style.display='block'; var files=document.getElementById('files'); files.innerHTML=''; m.proposal.files.forEach(function(f){ var row=document.createElement('div'); row.textContent=(f.exists?'Update: ':'New file: ')+f.path+' '; var vb=document.createElement('button'); vb.className='small'; vb.textContent='View (review)'; vb.addEventListener('click', function(){ vscode.postMessage({type:'viewProposalFile', path:f.path}); }); row.appendChild(vb); var b=document.createElement('button'); b.className='small'; b.textContent='Approve this file'; b.addEventListener('click', function(){ vscode.postMessage({type:'approveFile', path:f.path}); }); row.appendChild(b); files.appendChild(row); if(f.preview){ var pre=document.createElement('pre'); pre.style.cssText='white-space:pre-wrap;max-height:200px;overflow:auto;background:#111;color:#ddd;padding:6px;font-size:11px'; pre.textContent=f.preview; files.appendChild(pre); } }); var cmds=document.getElementById('cmds'); cmds.textContent = m.proposal.commands.length ? 'Commands (run only on approval): '+m.proposal.commands.join('  •  ') : 'No commands proposed.'; }",
      "});",
      "</script></body></html>"
    ].join("");
  }
}
