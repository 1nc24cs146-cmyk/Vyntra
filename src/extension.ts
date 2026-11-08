import * as vscode from "vscode";
import { exec, spawn } from "child_process";
import { checkHealth, chatStream, listModels } from "./ollama";
import { collectContext, contextToPrompt } from "./context";
import { applyUnifiedDiff, isDangerousCommand, isUnsafeProposalPath, parseDiffProposal, parseProposal, ProposedFile, Proposal } from "./proposal";
import { estimateTokens, retrieveOlderChats, trimHistory, LlmMessage } from "./llm";
import { checkOpenAi, openAiChatStream } from "./openai";
import { buildTemplateApp } from "./templates";
import { buildMajorTemplateApp, isMajorRequest } from "./majorTemplates";
import { buildRootForPrompt, desktopDir, resolveTargetRoot, sanitizeProjectName, TargetKind } from "./desktop";
import { checkGemini, geminiChatStream } from "./gemini";
import { buildLanguageProject, detectLanguage, fullLanguageGuidance, platformInfo } from "./languages";
import { buildAutoFixPrompt, countBySeverity, DiagnosticItem, fixHintFor, formatDiagnostics } from "./diagnostics";
import { buildCodebaseAnswer, buildCodebaseQAPrompt, extractQuestionTerms, findDefinitions, isCodebaseQuestion } from "./codebaseQA";

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
let lastChatRequest: { autoApply: boolean; majorFlag: boolean; mode: Mode; text: string } | null = null;
interface LearnedAnswer { answer: string; createdAt: number; question: string; }
let learnedAnswers: LearnedAnswer[] = [];
function loadLearnedAnswers() {
  try {
    const s = extContext?.globalState.get<LearnedAnswer[]>("localNest.learnedAnswers", []);
    if (Array.isArray(s)) { learnedAnswers = s.filter((x) => x && typeof x.question === "string" && typeof x.answer === "string"); }
  } catch { /* start with none */ }
}
function saveLearnedAnswers() {
  try { void extContext?.globalState.update("localNest.learnedAnswers", learnedAnswers.slice(-100)); } catch { /* best-effort */ }
}
function normQ(q: string): string { return q.toLowerCase().replace(/\s+/g, " ").trim(); }
function storeLearnedAnswer(question: string, answer: string): string {
  const q = question.trim().slice(0, 500);
  const a = answer.trim().slice(0, 4000);
  if (!q || !a) { return ""; }
  const idx = learnedAnswers.findIndex((x) => normQ(x.question) === normQ(q));
  if (idx >= 0) { learnedAnswers[idx] = { answer: a, createdAt: Date.now(), question: q }; }
  else { learnedAnswers.push({ answer: a, createdAt: Date.now(), question: q }); learnedAnswers = learnedAnswers.slice(-100); }
  saveLearnedAnswers();
  return q;
}
function findLearnedAnswers(query: string): LearnedAnswer[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((x) => x.length > 2);
  if (!tokens.length || !learnedAnswers.length) { return []; }
  const nq = normQ(query);
  const scored = learnedAnswers.map((x) => {
    let score = 0;
    if (normQ(x.question) === nq) { score += 100; }
    const lower = x.question.toLowerCase();
    for (const tok of tokens) { if (lower.includes(tok)) { score += 1; } }
    return { score, x };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map((s) => s.x);
}
function parseTaughtQA(text: string): { answer: string; question: string } | null {
  // "Q: ... A: ..." / "Question: ... Answer: ..." — a user teaching the
  // extension, not asking it. Stored, not sent to the model.
  const m = text.trim().match(/^(?:Q|Question)\s*:\s*(.+?)\s*(?:A|Answer)\s*:\s*(.+)$/is);
  if (!m) { return null; }
  return { answer: m[2].trim(), question: m[1].trim() };
}
function parseLearnArg(rest: string): { answer: string; question: string } | null {
  for (const sep of [" | ", " :: ", "\nAnswer:", "\nA:", " Answer: "]) {
    const i = rest.indexOf(sep);
    if (i > 0) { return { answer: rest.slice(i + sep.length).trim(), question: rest.slice(0, i).trim() }; }
  }
  return null;
}
let lastAppliedFiles: string[] = [];
let conversationHistory: LlmMessage[] = [];
let olderChats: LlmMessage[] = [];
let lastModels: string[] = [];
let modelsView: vscode.WebviewView | undefined;
let extContext: vscode.ExtensionContext | undefined;
let effectiveOpenAiUrl = "";
let autoStartTried = false;
let currentAbort: AbortController | null = null;
function memoryState() {
  const cfg = vscode.workspace.getConfiguration("localNest");
  const scope = cfg.get<string>("chatMemory.scope", "current");
  return scope === "all" && extContext ? extContext.globalState : extContext!.workspaceState;
}
function saveChatMemory() {
  try { void memoryState().update("localNest.conversationHistory", conversationHistory); } catch { /* memory is best-effort */ }
}
function saveOlderChats() {
  try { void memoryState().update("localNest.olderChatMemory", olderChats.slice(-50)); } catch { /* best-effort */ }
}
function loadChatMemory() {
  try {
    const h = memoryState().get<LlmMessage[]>("localNest.conversationHistory", []);
    if (Array.isArray(h)) { conversationHistory = h.filter((m) => m && typeof m.content === "string"); }
    const o = memoryState().get<LlmMessage[]>("localNest.olderChatMemory", []);
    if (Array.isArray(o)) { olderChats = o.filter((m) => m && typeof m.content === "string"); }
  } catch { /* start fresh */ }
}
function applyHistory(next: LlmMessage[], maxChars: number): LlmMessage[] {
  const trimmed = trimHistory(next, maxChars > 0 ? maxChars : 40000, 12);
  const dropped = next.slice(0, Math.max(0, next.length - trimmed.length));
  if (dropped.length > 0) {
    olderChats = [...olderChats, ...dropped].slice(-50);
    saveOlderChats();
    updateContextSummary(dropped);
  }
  conversationHistory = trimmed;
  saveChatMemory();
  return trimmed;
}
function postModelsUpdate(models: string[], provider: string) {
  lastModels = models;
  modelsView?.webview.postMessage({ models, provider, type: "models" });
}
function stopGeneration() {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    view?.webview.postMessage({ text: "Stopped.", type: "assistant" });
  }
}
function clearConversation() {
  conversationHistory = [];
  saveChatMemory();
  view?.webview.postMessage({ text: "New chat started — history cleared.", type: "assistant" });
}

// --- Saved chat sessions (0.9.26) ---
// One session = one named thread. Sessions live in the same state store as
// chat memory (workspaceState by default, globalState when scope is "all"),
// so they survive the panel closing — the panel is only a view, the thread
// is not lost with it. A session is created on the first user message, not
// on every panel open, so empty opens do not spam the list.
interface ChatSession { id: string; title: string; createdAt: number; updatedAt: number; messages: LlmMessage[]; }
let chatSessions: ChatSession[] = [];
let currentSessionId: string | null = null;
let contextSummary = "";
let contextSummaryCount = 0;
let lastTrimNotice = "";
function sessionTitleFrom(messages: LlmMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  // Use displayContent: conversationHistory stores the constructed prompt
  // ("MODE: build / CURRENT USER REQUEST ..."), but a session must be
  // named after what the user actually typed, not that internal prompt.
  const raw = (firstUser ? displayContent(firstUser) : "New chat").replace(/\s+/g, " ").trim();
  return raw.length > 48 ? raw.slice(0, 48) + "…" : (raw || "New chat");
}
function retitleBadSessions() {
  for (const s of chatSessions) {
    if (s.title.startsWith("MODE:") || s.title.startsWith("MODE")) {
      s.title = sessionTitleFrom(s.messages);
    }
  }
}
function saveSessions() {
  try {
    void memoryState().update("localNest.chatSessions", chatSessions);
    void memoryState().update("localNest.currentSessionId", currentSessionId);
    void memoryState().update("localNest.contextSummary", contextSummary);
    void memoryState().update("localNest.contextSummaryCount", contextSummaryCount);
  } catch { /* sessions are best-effort */ }
}
function loadSessions() {
  try {
    const s = memoryState().get<ChatSession[]>("localNest.chatSessions", []);
    if (Array.isArray(s)) { chatSessions = s.filter((x) => x && typeof x.id === "string" && Array.isArray(x.messages)); retitleBadSessions(); }
    const cur = memoryState().get<string | null>("localNest.currentSessionId", null);
    currentSessionId = typeof cur === "string" ? cur : null;
    contextSummary = memoryState().get<string>("localNest.contextSummary", "") || "";
    contextSummaryCount = memoryState().get<number>("localNest.contextSummaryCount", 0) || 0;
    // Legacy migration: a pre-session thread becomes session #1, not lost.
    if (!chatSessions.length && conversationHistory.length) {
      const now = Date.now();
      chatSessions = [{ id: "session-" + now, title: sessionTitleFrom(conversationHistory), createdAt: now, updatedAt: now, messages: [...conversationHistory] }];
      currentSessionId = chatSessions[0].id;
      saveSessions();
      return;
    }
    if (currentSessionId) {
      const curSession = chatSessions.find((x) => x.id === currentSessionId);
      if (curSession) { conversationHistory = [...curSession.messages]; return; }
    }
    if (chatSessions.length) { currentSessionId = chatSessions[0].id; conversationHistory = [...chatSessions[0].messages]; }
  } catch { /* start fresh */ }
}
function saveCurrentSession() {
  try { if (!getConfig().chatMemoryEnabled) { return; } } catch { /* fall through */ }
  if (!currentSessionId) { return; }
  const s = chatSessions.find((x) => x.id === currentSessionId);
  if (!s) { return; }
  s.messages = [...conversationHistory];
  s.updatedAt = Date.now();
  if (s.title === "New chat" || !s.title || s.title.startsWith("MODE:")) { s.title = sessionTitleFrom(conversationHistory); }
  saveSessions();
}
function ensureSession() {
  try { if (!getConfig().chatMemoryEnabled) { return; } } catch { /* fall through */ }
  if (currentSessionId && chatSessions.some((x) => x.id === currentSessionId)) { return; }
  const now = Date.now();
  const s: ChatSession = { id: "session-" + now + "-" + Math.floor(Math.random() * 10000), title: "New chat", createdAt: now, updatedAt: now, messages: [...conversationHistory] };
  chatSessions.unshift(s);
  currentSessionId = s.id;
  saveSessions();
}
function startNewSession() {
  saveCurrentSession();
  const now = Date.now();
  const s: ChatSession = { id: "session-" + now + "-" + Math.floor(Math.random() * 10000), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
  chatSessions.unshift(s);
  currentSessionId = s.id;
  conversationHistory = [];
  saveChatMemory();
  saveSessions();
  postSessions();
  view?.webview.postMessage({ messages: [], type: "restoreHistory" });
  view?.webview.postMessage({ text: "New chat started — past chats are still in Past chats at the top.", type: "assistant" });
}
function openSession(id: string) {
  const s = chatSessions.find((x) => x.id === id);
  if (!s) { return; }
  saveCurrentSession();
  currentSessionId = s.id;
  conversationHistory = [...s.messages];
  saveChatMemory();
  saveSessions();
  postSessions();
  view?.webview.postMessage({ messages: displayMessages(s.messages), type: "restoreHistory" });
  view?.webview.postMessage({ text: "Reopened chat: " + s.title + " (" + s.messages.length + " message(s)).", type: "assistant" });
  postContext("ask");
}
function deleteSession(id: string) {
  chatSessions = chatSessions.filter((x) => x.id !== id);
  if (currentSessionId === id) {
    currentSessionId = null;
    conversationHistory = [];
    saveChatMemory();
    if (chatSessions.length) { currentSessionId = chatSessions[0].id; conversationHistory = [...chatSessions[0].messages]; }
  }
  saveSessions();
  postSessions();
  if (currentSessionId) {
    const cur = chatSessions.find((x) => x.id === currentSessionId);
    if (cur) { view?.webview.postMessage({ messages: displayMessages(cur.messages), type: "restoreHistory" }); }
  } else {
    view?.webview.postMessage({ messages: [], type: "restoreHistory" });
  }
}

function displayContent(m: LlmMessage): string {
  // conversationHistory stores the constructed prompt (MODE + workspace
  // context + request). When replaying a chat, show only the user's
  // original text, never that internal prompt — otherwise the panel
  // shows a "MODE: build CURRENT USER REQUEST ..." bubble instead of
  // what the user actually typed.
  if (m.role !== "user") { return m.content; }
  const marker = "CURRENT USER REQUEST";
  const idx = m.content.indexOf(marker);
  if (idx < 0) { return m.content; }
  const after = m.content.slice(idx);
  const nl = after.indexOf("\n");
  if (nl < 0) { return m.content; }
  let rest = after.slice(nl + 1);
  const cut = rest.indexOf("\n\nWorkspace context");
  if (cut >= 0) { rest = rest.slice(0, cut); }
  return rest.trim() || m.content;
}
function displayMessages(msgs: LlmMessage[]) {
  return msgs.map((m) => ({ content: displayContent(m), role: m.role }));
}

function postSessions() {
  view?.webview.postMessage({ sessions: chatSessions.map((s) => ({ count: s.messages.length, id: s.id, title: s.title, updatedAt: s.updatedAt })), type: "sessions" });
}
// --- Context meter + auto-summary (0.9.26) ---
// Truncation used to be silent: trimHistory dropped old messages into an
// unreadable store. Now every dropped batch gets an extractive summary
// (topics + first asks + last outcome, no model call, so it works offline),
// that summary is kept and fed back into later prompts, and the user is
// told, in the panel, that it happened.
function updateContextSummary(dropped: LlmMessage[]) {
  if (!dropped.length) { return; }
  const asks = dropped.filter((m) => m.role === "user").slice(0, 3).map((m) => m.content.replace(/\s+/g, " ").slice(0, 160));
  const lastAssistant = [...dropped].reverse().find((m) => m.role === "assistant");
  const note = "Earlier chat (" + dropped.length + " message(s) trimmed): " + (asks.length ? "asked: " + asks.join(" | ") : "no user asks kept") + (lastAssistant ? " — last outcome: " + lastAssistant.content.replace(/\s+/g, " ").slice(0, 200) : "");
  contextSummary = (contextSummary ? contextSummary + "\n" : "") + note;
  if (contextSummary.length > 6000) { contextSummary = contextSummary.slice(-6000); }
  contextSummaryCount += dropped.length;
  lastTrimNotice = "Context note: " + dropped.length + " older message(s) were trimmed and summarised, not lost silently. Summary is kept and used for later answers (" + contextSummaryCount + " message(s) summarised so far).";
  saveSessions();
}
function contextWindowTokens(cfg: Config): number {
  return cfg.ollamaContextWindow && cfg.ollamaContextWindow > 0 ? cfg.ollamaContextWindow : 4096;
}
function postContext(mode: Mode) {
  try {
    const cfg = getConfig();
    const windowTokens = contextWindowTokens(cfg);
    const historyTokens = conversationHistory.reduce((s, m) => s + estimateTokens(m.content), 0);
    const systemTokens = estimateTokens(systemPrompt(mode));
    const used = historyTokens + systemTokens + (contextSummary ? estimateTokens(contextSummary) : 0);
    const pct = Math.min(100, Math.round((used / windowTokens) * 100));
    view?.webview.postMessage({ pct, summaryCount: contextSummaryCount, tokens: used, type: "context", window: windowTokens });
  } catch { /* meter is best-effort */ }
}
// --- Custom skills + project rules (0.9.26) ---
async function loadCustomSkills(): Promise<Record<string, Skill>> {
  const out: Record<string, Skill> = {};
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) { return out; }
    const files = await vscode.workspace.findFiles(".localnest/skills/*.md");
    for (const f of files) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString("utf8");
        const name = f.path.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
        if (!name || !/^[a-z0-9_-]+$/.test(name)) { continue; }
        const lines = text.split("\n");
        const first = lines.find((l) => l.trim().length > 0) || "";
        const description = first.startsWith("#") ? first.replace(/^#+\s*/, "").trim() : "Custom skill from .localnest/skills/" + name + ".md";
        const prompt = first.startsWith("#") ? lines.slice(lines.indexOf(first) + 1).join("\n").trim() || text : text;
        if (prompt) { out[name] = { description, prompt }; }
      } catch { /* skip one bad skill file */ }
    }
  } catch { /* no custom skills */ }
  return out;
}
async function loadProjectRules(): Promise<{ content: string; file: string } | null> {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) { return null; }
    const root = folders[0].uri;
    for (const rel of [".localnest/rules.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md"]) {
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 0) {
          const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8").slice(0, 8000);
          if (text.trim()) { return { content: text, file: rel }; }
        }
      } catch { /* try next candidate */ }
    }
  } catch { /* no rules */ }
  return null;
}
async function skillsHelpTextFull(): Promise<string> {
  const custom = await loadCustomSkills();
  const built = "Built-in skills — type one at the start of your message:\n" + Object.entries(SKILLS).map(([n, s]) => "/" + n + " — " + s.description).join("\n");
  const customText = Object.keys(custom).length ? "\n\nYour skills (.localnest/skills/*.md):\n" + Object.entries(custom).map(([n, s]) => "/" + n + " — " + s.description).join("\n") : "\n\nYour skills: none yet. Add a file .localnest/skills/<name>.md in your project — first line '# description', rest is the skill prompt.";
  const rules = await loadProjectRules();
  return built + customText + (rules ? "\n\nProject rules loaded from " + rules.file + "." : "\n\nProject rules: none found. Add .localnest/rules.md or AGENTS.md to your project to set them.") + (learnedAnswers.length ? "\n\nLearned answers: " + learnedAnswers.length + " stored — I use them first for matching questions. See /learned." : "\n\nLearned answers: none yet. Teach one with /learn <question> | <answer>.") + "\n\nExample: /review look at this function and tell me what is wrong\nType /skills any time to see this list again.";
}

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  secretStorage = context.secrets;
  loadChatMemory();
  loadSessions();
  loadLearnedAnswers();
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "localNest.refreshOllama";
  statusBar.text = "○ Ollama: checking…";
  statusBar.tooltip = "Vyntra — click to refresh Ollama status";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Chat participant: @localnest in a chat view.
  // This is the closest extension surface to an "@ to mention" chat box:
  // Antigravity's own built-in Ask panel (the Gemini dropdown in the
  // screenshot) is not an extension surface, so no extension can inject
  // itself or a model into that panel. This participant, the sidebar
  // view, and the first-run reveal below are what an extension can do.
  try {
    const chatApi: any = (vscode as any).chat;
    if (chatApi && typeof chatApi.createChatParticipant === "function") {
      const participant = chatApi.createChatParticipant("localNest", async (request: any, _ctx: any, stream: any, token: any) => {
        const cfg = getConfig();
        const prompt = String(request?.prompt || "");
        const ctx = await collectContext(prompt, cfg.maxFiles, cfg.lowBandwidth, { maxFileBytes: cfg.contextMaxFileBytes, maxIndexCharacters: cfg.contextMaxIndexCharacters, maxIndexedFiles: cfg.contextMaxIndexedFiles });
        const online = await providerOnline(cfg);
        if (!online) {
          stream.markdown("LocalNest is offline right now — " + ctx.summary + "\n\nStart Ollama (`ollama serve` + a pulled free model), then ask @localnest again. Build mode in the sidebar still works offline from templates.");
          return {};
        }
        const messages: LlmMessage[] = [
          { content: systemPrompt("ask"), role: "system" },
          { content: "Workspace context:\n" + ctx.summary + "\n\n" + contextToPrompt(ctx.files) + "\n\nUser request:\n" + prompt, role: "user" }
        ];
        const abort = new AbortController();
        try { token?.onCancellationRequested?.(() => abort.abort()); } catch { /* ignore */ }
        // providerStream uses its own controller; link cancellation by
        // aborting the shared signal is not wired through, so stop the
        // stream loop when the token is cancelled.
        let cancelled = false;
        try { token?.onCancellationRequested?.(() => { cancelled = true; }); } catch { /* ignore */ }
        try {
          for await (const chunk of providerStream(cfg, messages, modelForMode(cfg, "ask"))) {
            if (cancelled) { break; }
            stream.markdown(chunk);
          }
        } catch (err: any) {
          stream.markdown("\n\nLocalNest could not reach the model: " + String(err?.message || err));
        }
        return {};
      });
      participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
      context.subscriptions.push(participant);
    }
  } catch { /* chat participants are optional; sidebar still works */ }

  // First run after install: read the system, check Ollama and its models,
  // and tell the user exactly what is missing before they type anything.
  // Only the prompt is once — the panel itself re-checks on every open.
  try {
    const shown = context.globalState.get<boolean>("localNest.firstRunShown", false);
    if (!shown) {
      void context.globalState.update("localNest.firstRunShown", true);
      setTimeout(async () => {
        const res = await runSystemCheck();
        void vscode.commands.executeCommand("localNest.chat.focus");
        if (!res.installed) {
          void vscode.window.showInformationMessage("LocalNest: Ollama is NOT installed on this system, so LocalNest cannot answer yet. Install Ollama to continue.", "Install Ollama", "Open LocalNest Chat").then((choice) => {
            if (choice === "Install Ollama") { void vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download")); }
            else if (choice === "Open LocalNest Chat") { void vscode.commands.executeCommand("localNest.chat.focus"); }
          });
        } else if (!res.online) {
          void vscode.window.showInformationMessage("LocalNest: Ollama is installed but not running yet. Start it with `ollama serve`, then reopen LocalNest Chat.", "Open LocalNest Chat").then((choice) => {
            if (choice === "Open LocalNest Chat") { void vscode.commands.executeCommand("localNest.chat.focus"); }
          });
        } else if (!res.models.length) {
          void vscode.window.showInformationMessage("LocalNest: Ollama is installed, but no Ollama model is downloaded yet. Pick a model in LocalNest Chat and press Download.", "Open LocalNest Chat").then((choice) => {
            if (choice === "Open LocalNest Chat") { void vscode.commands.executeCommand("localNest.chat.focus"); }
          });
        } else {
          void vscode.window.showInformationMessage("LocalNest: found " + res.models.length + " Ollama model(s) on this system (" + res.models.join(", ") + ") — chat is ready. Pick a model and ask.", "Open LocalNest Chat").then((choice) => {
            if (choice === "Open LocalNest Chat") { void vscode.commands.executeCommand("localNest.chat.focus"); }
          });
        }
      }, 800);
    }
  } catch { /* first-run reveal is best-effort */ }

  const provider = new VyntraViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localNest.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const modelsProvider = new LocalNestModelsProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localNest.models", modelsProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localNest.openChat", async () => {
      await focusChatView();
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
        prompt: "Vyntra stores this in secure storage, not in settings or files."
      });
      if (key === undefined) {
        return;
      }
      await secretStorage?.store("localNest.openaiApiKey", key.trim());
      vscode.window.showInformationMessage("Vyntra: OpenAI-compatible API key saved securely.");
      await refreshStatus(false);
    }),
    vscode.commands.registerCommand("localNest.exportChat", async () => {
      if (!conversationHistory.length) { vscode.window.showInformationMessage("LocalNest: nothing to export yet — chat first."); return; }
      const md = "# LocalNest chat export\n\n" + conversationHistory.map((m) => (m.role === "user" ? "## You\n\n" : "## LocalNest\n\n") + m.content).join("\n\n");
      const doc = await vscode.workspace.openTextDocument({ content: md, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage("LocalNest: chat opened as a document — save it with Ctrl+S / Cmd+S. Nothing was written to disk automatically.");
    }),
    vscode.commands.registerCommand("localNest.listSessions", async () => {
      loadSessions();
      if (!chatSessions.length) { vscode.window.showInformationMessage("LocalNest: no past chats saved yet."); return; }
      const pick = await vscode.window.showQuickPick(chatSessions.map((s) => ({ description: s.messages.length + " message(s) · " + new Date(s.updatedAt).toLocaleString(), detail: s.id, label: s.title })), { placeHolder: "Reopen a past chat" });
      if (!pick) { return; }
      await vscode.commands.executeCommand("localNest.openChat");
      setTimeout(() => { openSession(pick.detail); }, 400);
    }),
    vscode.commands.registerCommand("localNest.newChat", async () => {
      startNewSession();
    }),
    vscode.commands.registerCommand("localNest.cancelAgent", async () => { stopGeneration(); }),
    vscode.commands.registerCommand("localNest.setAgentMode", async () => {
      const pick = await vscode.window.showQuickPick(["ask", "plan", "agent", "build"], { placeHolder: "Pick an agent mode" });
      if (!pick) { return; }
      await vscode.commands.executeCommand("localNest.chat.focus");
      setTimeout(() => { view?.webview.postMessage({ mode: pick, type: "setMode" }); }, 400);
    }),
    vscode.commands.registerCommand("localNest.setModel", async () => {
      const cfg = getConfig();
      const models = lastModels.length ? lastModels : [modelForProvider(cfg)];
      const pick = await vscode.window.showQuickPick(models, { placeHolder: "Pick a model for the current provider, or type a custom id" });
      if (!pick) { return; }
      const ws = vscode.workspace.getConfiguration("localNest");
      await ws.update(cfg.provider === "gemini" ? "geminiModel" : (cfg.provider === "openai" ? "openaiModel" : "model"), pick, vscode.ConfigurationTarget.Global);
      await refreshStatus(false);
    }),
    vscode.commands.registerCommand("localNest.continueTask", async () => {
      if (agentState) { await continueAgenticLoop(); return; }
      await vscode.commands.executeCommand("localNest.chat.focus");
      view?.webview.postMessage({ text: conversationHistory.length ? "Continuing your previous task — history is still kept (" + conversationHistory.length + " message(s)). Type the next step." : "No agent task is waiting. Ask in Agent or Build mode first.", type: "assistant" });
    }),
    vscode.commands.registerCommand("localNest.reviewChanges", async () => {
      if (!currentProposal) { vscode.window.showInformationMessage("Vyntra: no proposal is waiting to review."); return; }
      await vscode.commands.executeCommand("localNest.chat.focus");
      view?.webview.postMessage({ proposal: serialiseProposal(currentProposal), type: "proposal" });
      view?.webview.postMessage({ text: "Reviewing the waiting proposal: " + currentProposal.files.map((f) => f.path).join(", ") + ". Nothing has been written yet.", type: "assistant" });
    }),
    vscode.commands.registerCommand("localNest.showArtifacts", async () => {
      if (lastAppliedFiles.length === 0) { vscode.window.showInformationMessage("Vyntra: no files have been created or updated yet in this session."); return; }
      const pick = await vscode.window.showQuickPick(lastAppliedFiles, { placeHolder: "Open a file created/updated by the agent" });
      if (!pick) { return; }
      const root = currentProposalRoot || workspaceRootUri();
      if (!root) { return; }
      const uri = pick.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pick) ? vscode.Uri.file(pick) : vscode.Uri.joinPath(root, pick);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("localNest.diagnose", async () => { await runDiagnose(false); }),
    vscode.commands.registerCommand("localNest.doctor", async () => { await runDiagnose(true); }),
    vscode.commands.registerCommand("localNest.selfTest", async () => {
      const result = selfTestText();
      vscode.window.showInformationMessage("Vyntra self-test: " + result);
      view?.webview.postMessage({ text: "Self-test:\n" + result, type: "assistant" });
    }),
    vscode.commands.registerCommand("localNest.refreshModels", async () => { await refreshStatus(true); }),
    vscode.commands.registerCommand("localNest.reindexWorkspace", async () => {
      const cfg = getConfig();
      const ctx = await collectContext("", cfg.maxFiles, cfg.lowBandwidth, { maxFileBytes: cfg.contextMaxFileBytes, maxIndexCharacters: cfg.contextMaxIndexCharacters, maxIndexedFiles: cfg.contextMaxIndexedFiles });
      const msg = "Re-indexed workspace: " + ctx.summary;
      view?.webview.postMessage({ text: msg, type: "assistant" });
      vscode.window.showInformationMessage("Vyntra: " + msg);
    }),
    vscode.commands.registerCommand("localNest.searchWorkspace", async () => {
      const q = await vscode.window.showInputBox({ placeHolder: "Search workspace files, e.g. auth, todo, database", prompt: "Search workspace context (keyword match, same index as Ask)" });
      if (!q) { return; }
      const cfg = getConfig();
      const ctx = await collectContext(q, cfg.maxFiles, cfg.lowBandwidth, { maxFileBytes: cfg.contextMaxFileBytes, maxIndexCharacters: cfg.contextMaxIndexCharacters, maxIndexedFiles: cfg.contextMaxIndexedFiles });
      if (ctx.files.length === 0) { vscode.window.showInformationMessage("Vyntra: no workspace files matched '" + q + "'."); return; }
      const pick = await vscode.window.showQuickPick(ctx.files.map((f) => f.path), { placeHolder: "Open a matching file" });
      if (!pick) { return; }
      const root = workspaceRootUri();
      if (!root) { return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, pick));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("localNest.editSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage("Vyntra: select some code first, then propose an edit."); return; }
      const code = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      await vscode.commands.executeCommand("localNest.chat.focus");
      setTimeout(() => { view?.webview.postMessage({ mode: "agent", text: "Propose a diff-reviewed edit for this code from " + file + ":\n\n```\n" + code + "\n```", type: "prefill" }); }, 400);
    }),
    vscode.commands.registerCommand("localNest.fixSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage("Vyntra: select some code first, then ask for a fix."); return; }
      const code = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const diags = vscode.languages.getDiagnostics(editor.document.uri).slice(0, 10).map((d) => d.message).join("; ");
      await vscode.commands.executeCommand("localNest.chat.focus");
      setTimeout(() => { view?.webview.postMessage({ mode: "agent", text: "Fix this code from " + file + (diags ? " (diagnostics: " + diags + ")" : "") + ":\n\n```\n" + code + "\n```", type: "prefill" }); }, 400);
    }),
    vscode.commands.registerCommand("localNest.fixDiagnostics", async () => {
      // Auto-fix diagnostics (0.9.36): prefill /autofix in Agent mode, so
      // fixes come back as FILE blocks for review — never applied directly.
      const editor = vscode.window.activeTextEditor;
      const scope = editor ? "current file" : "workspace";
      const items = collectEditorDiagnostics(editor ? "file" : "workspace");
      if (!items.length) { vscode.window.showInformationMessage("Vyntra: no diagnostics reported for the " + scope + " — nothing to fix."); return; }
      await vscode.commands.executeCommand("localNest.chat.focus");
      setTimeout(() => { view?.webview.postMessage({ mode: "agent", text: "/autofix", type: "prefill" }); }, 400);
    }),
    vscode.commands.registerCommand("localNest.askCodebase", async () => {
      // Codebase Q&A (0.9.36): ask about the workspace, grounded in its files.
      const q = await vscode.window.showInputBox({ placeHolder: "e.g. where is parseProposal defined", prompt: "Ask about your codebase — answered only from the actual workspace files, with file:line citations" });
      if (!q || !q.trim()) { return; }
      await vscode.commands.executeCommand("localNest.chat.focus");
      const question = q.trim();
      setTimeout(() => { view?.webview.postMessage({ mode: "ask", text: "/qa " + question, type: "prefill" }); }, 400);
    }),
    vscode.commands.registerCommand("localNest.connectRemote", async () => {
      const url = await vscode.window.showInputBox({ placeHolder: "http://192.168.1.10:11434", prompt: "Remote Ollama host URL (your own host; code is sent only there)" });
      if (!url || !/^https?:\/\//.test(url.trim())) { vscode.window.showWarningMessage("Vyntra: that is not an http(s) URL."); return; }
      await vscode.workspace.getConfiguration("localNest").update("ollamaHost", url.trim(), vscode.ConfigurationTarget.Global);
      await refreshStatus(true);
    }),
    vscode.commands.registerCommand("localNest.configureRemote", async () => { await vscode.commands.executeCommand("localNest.connectRemote"); }),
    vscode.commands.registerCommand("localNest.disconnectRemote", async () => {
      await vscode.workspace.getConfiguration("localNest").update("ollamaHost", "http://localhost:11434", vscode.ConfigurationTarget.Global);
      await refreshStatus(true);
      vscode.window.showInformationMessage("Vyntra: disconnected remote host — back to local Ollama.");
    }),
    vscode.commands.registerCommand("localNest.remoteStatus", async () => {
      const cfg = getConfig();
      try {
        const models = await listModels(cfg.host);
        const msg = "Remote Ollama status: online at " + cfg.host + " (" + models.length + " model(s): " + models.join(", ") + "). No GPU status is shown — Ollama manages hardware itself.";
        view?.webview.postMessage({ text: msg, type: "assistant" });
        vscode.window.showInformationMessage("Vyntra: " + msg);
      } catch {
        const msg = "Remote Ollama status: offline at " + cfg.host + ". Check the host is running and reachable from this network.";
        view?.webview.postMessage({ text: msg, type: "assistant" });
        vscode.window.showWarningMessage("Vyntra: " + msg);
      }
    }),
    vscode.commands.registerCommand("localNest.openAgent", async () => { await vscode.commands.executeCommand("localNest.openChat"); }),
    vscode.commands.registerCommand("localNest.newConversation", async () => { startNewSession(); }),
    vscode.commands.registerCommand("localNest.setGeminiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        password: true,
        placeHolder: "Paste your Gemini API key from Google AI Studio",
        prompt: "Vyntra stores this in secure storage, not in settings or files. Get a key at https://aistudio.google.com/app/apikey"
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
  agentMaxFileBytes: number;
  agentMaxGeneratedTokens: number;
  agentMaxRounds: number;
  agentTaskTimeoutMs: number;
  autoFallback: boolean;
  chatMemoryEnabled: boolean;
  chatMemoryResultCount: number;
  chatMemoryRetrievedCharacters: number;
  contextMaxFileBytes: number;
  contextMaxIndexCharacters: number;
  contextMaxIndexedFiles: number;
  geminiModel: string;
  historyCharacters: number;
  host: string;
  lowBandwidth: boolean;
  maxFiles: number;
  model: string;
  ollamaAgentThinking: boolean;
  ollamaAutoStart: boolean;
  ollamaContextWindow: number;
  ollamaMaxOutputTokens: number;
  openaiBaseUrl: string;
  openaiCompatibleUrls: string;
  openaiModel: string;
  provider: string;
  routingAgentModel: string;
  routingChatModel: string;
  routingEditModel: string;
  temperature: number;
}

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration("localNest");
  return {
    agentMaxFileBytes: cfg.get<number>("agentMaxFileBytes", 8388608),
    agentMaxGeneratedTokens: cfg.get<number>("agentMaxGeneratedTokens", 0),
    agentMaxRounds: cfg.get<number>("agentMaxRounds", 5),
    agentTaskTimeoutMs: cfg.get<number>("agentTaskTimeoutMs", 0),
    autoFallback: false,
    chatMemoryEnabled: cfg.get<boolean>("chatMemory.enabled", true),
    chatMemoryResultCount: cfg.get<number>("chatMemory.resultCount", 4),
    chatMemoryRetrievedCharacters: cfg.get<number>("chatMemory.retrievedCharacters", 3000),
    contextMaxFileBytes: cfg.get<number>("contextMaxFileBytes", 262144),
    contextMaxIndexCharacters: cfg.get<number>("contextMaxIndexCharacters", 8000000),
    contextMaxIndexedFiles: cfg.get<number>("contextMaxIndexedFiles", 2000),
    geminiModel: cfg.get<string>("geminiModel", "gemini-3.8-flash"),
    historyCharacters: cfg.get<number>("historyCharacters", 40000),
    host: cfg.get<string>("ollamaHost", "http://localhost:11434"),
    lowBandwidth: cfg.get<boolean>("lowBandwidth", false),
    maxFiles: cfg.get<number>("maxContextFiles", 8),
    model: cfg.get<string>("model", "qwen2.5-coder:7b"),
    ollamaAgentThinking: cfg.get<boolean>("ollamaAgentThinking", false),
    ollamaAutoStart: cfg.get<boolean>("ollamaAutoStart", true),
    ollamaContextWindow: cfg.get<number>("ollamaContextWindow", 0),
    ollamaMaxOutputTokens: cfg.get<number>("ollamaMaxOutputTokens", -1),
    openaiBaseUrl: cfg.get<string>("openaiBaseUrl", "http://localhost:1234/v1"),
    openaiCompatibleUrls: cfg.get<string>("openAICompatibleUrls", "http://127.0.0.1:1234/v1,http://127.0.0.1:8080/v1,http://127.0.0.1:8000/v1"),
    openaiModel: cfg.get<string>("openaiModel", "local-model"),
    provider: "ollama",
    routingAgentModel: cfg.get<string>("routing.agentModel", ""),
    routingChatModel: cfg.get<string>("routing.chatModel", ""),
    routingEditModel: cfg.get<string>("routing.editModel", ""),
    temperature: cfg.get<number>("temperature", 0.2)
  };
}
function openAiUrls(cfg: Config): string[] {
  const list = [cfg.openaiBaseUrl, ...cfg.openaiCompatibleUrls.split(",").map((s) => s.trim()).filter(Boolean)];
  return [...new Set(list)];
}
function modelForMode(cfg: Config, mode: Mode): string {
  if ((mode === "agent" || mode === "build") && cfg.routingAgentModel) { return cfg.routingAgentModel; }
  if ((mode === "ask" || mode === "plan") && cfg.routingChatModel) { return cfg.routingChatModel; }
  return modelForProvider(cfg);
}
function selfTestText(): string {
  const checks: string[] = [];
  checks.push("estimateTokens('hello world test')=" + estimateTokens("hello world test") + (estimateTokens("hello world test") === 4 ? " PASS" : " FAIL"));
  const trimmed = trimHistory(Array.from({ length: 20 }, (_, i) => ({ content: "x".repeat(5000), role: i % 2 === 0 ? "user" as const : "assistant" as const })));
  checks.push("trimHistory 20x5000 -> " + trimmed.length + " msgs, " + trimmed.reduce((s, m) => s + m.content.length, 0) + " chars" + (trimmed.length <= 12 ? " PASS" : " FAIL"));
  const diffed = applyUnifiedDiff("line1\nline2\nline3", "@@ -1,3 +1,3 @@\n line1\n-line2\n+line2-fixed\n line3");
  checks.push("applyUnifiedDiff -> " + (diffed && diffed.includes("line2-fixed") ? "PASS" : "FAIL"));
  const retrieved = retrieveOlderChats("todo database", [{ content: "todo database schema", role: "user" }, { content: "unrelated weather", role: "assistant" }]);
  checks.push("retrieveOlderChats -> " + retrieved.length + " hit(s)" + (retrieved.length === 1 ? " PASS" : " FAIL"));
  const trav = parseProposal("### FILE: ../../etc/passwd\n```txt\nsecret\n```\n### FILE: index.html\n```html\n<h1>ok</h1>\n```\n### FILE: index.html\n```html\n<h1>last</h1>\n```");
  checks.push("parseProposal traversal blocked + duplicate deduped -> " + trav.files.length + " file(s)" + (trav.files.length === 1 && trav.files[0].content.includes("last") ? " PASS" : " FAIL"));
  checks.push("isDangerousCommand rm -rf ~ / format C: -> " + (isDangerousCommand("rm -rf ~/") && isDangerousCommand("format C:") ? "PASS" : "FAIL"));
  checks.push("displayContent strips internal prompt -> " + (displayContent({ content: "MODE: build\n\nCURRENT USER REQUEST — answer exactly this:\nbuild a site\n\nWorkspace context (background only):\nnone", role: "user" }) === "build a site" ? "PASS" : "FAIL"));
  // Auto-fix diagnostics (0.9.36)
  const diagItems: DiagnosticItem[] = [{ column: 5, file: "src/a.ts", line: 3, message: "Cannot find name 'foo'.", severity: "error" }];
  checks.push("formatDiagnostics lists file:line + hint -> " + (formatDiagnostics(diagItems).includes("src/a.ts:3:5") && formatDiagnostics(diagItems).includes("imported") ? "PASS" : "FAIL"));
  checks.push("fixHintFor TS2304 / unused / null -> " + (fixHintFor("Cannot find name 'x'.", 2304).length > 0 && fixHintFor(" 'y' is declared but its value is never read.", 6133).length > 0 && fixHintFor("Object is possibly 'null'.", 18047).length > 0 ? "PASS" : "FAIL"));
  checks.push("countBySeverity 2 errors + 1 warning -> " + (() => { const c = countBySeverity([...diagItems, { column: 1, file: "src/a.ts", line: 1, message: "e2", severity: "error" as const }, { column: 1, file: "src/b.ts", line: 1, message: "w", severity: "warning" as const }]); return c.errors === 2 && c.warnings === 1 && c.total === 3 ? "PASS" : "FAIL"; })());
  // Codebase Q&A (0.9.36)
  checks.push("isCodebaseQuestion 'where is X defined' -> " + (isCodebaseQuestion("where is parseProposal defined") && isCodebaseQuestion("how does the approval flow work") && !isCodebaseQuestion("write a poem about cats") ? "PASS" : "FAIL"));
  const qaFiles = [{ content: "export function parseProposal(raw: string): Proposal {\n  return { commands: [], files: [], raw };\n}", path: "src/proposal.ts" }];
  const qaDefs = findDefinitions(qaFiles, extractQuestionTerms("where is parseProposal defined"));
  checks.push("findDefinitions parseProposal -> " + (qaDefs.length >= 1 && qaDefs[0].file === "src/proposal.ts" && qaDefs[0].line === 1 ? "PASS" : "FAIL"));
  const qaAns = buildCodebaseAnswer("where is parseProposal defined", qaFiles);
  checks.push("buildCodebaseAnswer cites file:line -> " + (qaAns.answerText.includes("src/proposal.ts:1") ? "PASS" : "FAIL"));
  const qaMiss = buildCodebaseAnswer("where is nosuchthing defined", qaFiles);
  checks.push("buildCodebaseAnswer not-found says so plainly -> " + (/could not find/i.test(qaMiss.answerText) ? "PASS" : "FAIL"));
  checks.push("buildCodebaseQAPrompt forbids inventing -> " + (buildCodebaseQAPrompt("where is x defined", []).includes("do not guess") ? "PASS" : "FAIL"));
  return checks.join("\n");
}
async function tryAutoStartOllama(host: string): Promise<void> {
  if (autoStartTried) { return; }
  autoStartTried = true;
  if (!/localhost|127\.0\.0\.1/.test(host)) { return; }
  try {
    const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 1500));
  } catch { /* already-installed Ollama could not be started; user starts it manually */ }
}
interface SystemCheck { installed: boolean; online: boolean; models: string[]; }
let systemCheckResult: SystemCheck | null = null;
async function checkOllamaBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ollama", ["--version"], { shell: false });
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    setTimeout(() => { try { child.kill(); } catch { /* noop */ } finish(false); }, 5000);
  });
}
async function runSystemCheck(): Promise<SystemCheck> {
  const cfg = getConfig();
  const installed = await checkOllamaBinary();
  if (!installed) { systemCheckResult = { installed: false, models: [], online: false }; return systemCheckResult; }
  try {
    const models = await listModels(cfg.host);
    systemCheckResult = { installed: true, models, online: true };
    return systemCheckResult;
  } catch {
    // Ollama is installed but the server is not running — try starting it once, then re-check.
    await tryAutoStartOllama(cfg.host);
    try {
      const models = await listModels(cfg.host);
      systemCheckResult = { installed: true, models, online: true };
      return systemCheckResult;
    } catch {
      systemCheckResult = { installed: true, models: [], online: false };
      return systemCheckResult;
    }
  }
}
function pullOllamaModel(model: string): void {
  const terminal = vscode.window.createTerminal("Ollama pull " + model);
  terminal.show();
  if (process.platform === "win32") {
    // PowerShell: check first, so a missing Ollama install gives a plain
    // message instead of the confusing red CommandNotFoundException.
    terminal.sendText(`if (Get-Command ollama -ErrorAction SilentlyContinue) { ollama pull ${model} } else { Write-Host 'Ollama is NOT installed. Install it from https://ollama.com/download, restart Antigravity, then try pulling again.' }`);
  } else {
    terminal.sendText("ollama pull " + model);
  }
}
let downloadingModel = "";
async function downloadOllamaModel(model: string): Promise<void> {
  if (downloadingModel) {
    view?.webview.postMessage({ text: "Already downloading " + downloadingModel + " — wait for it to finish, then press Continue to chat.", type: "setupStatus" });
    return;
  }
  downloadingModel = model;
  view?.webview.postMessage({ text: "Downloading " + model + "… this can take several minutes for a 7B model (about 4–5 GB). Do not close Antigravity.", type: "setupStatus" });
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Downloading Ollama model " + model, cancellable: false }, async (progress) => {
      await new Promise<void>((resolve, reject) => {
        let lastPct = "";
        let lastOut = "";
        const child = spawn("ollama", ["pull", model], { shell: false });
        const onData = (data: any) => {
          const text = String(data);
          lastOut = text.slice(-500);
          const m = text.match(/(\d+)%/g);
          if (m) {
            const pct = m[m.length - 1];
            if (pct !== lastPct) {
              lastPct = pct;
              progress.report({ message: model + " — " + pct });
              view?.webview.postMessage({ text: "Downloading " + model + " — " + pct + " (keep this open, do not close Antigravity)", type: "setupStatus" });
            }
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (err: any) => {
          if (err?.code === "ENOENT") {
            reject(new Error("Ollama is not installed"));
          } else {
            reject(err);
          }
        });
        child.on("close", (code) => {
          if (code === 0) { resolve(); } else { reject(new Error("ollama pull exited with code " + code + ". " + lastOut)); }
        });
      });
    });
    downloadingModel = "";
    userPickedDownloadModel = null;
    view?.webview.postMessage({ text: "Downloaded " + model + " — opening chat now.", type: "setupStatus" });
    await vscode.workspace.getConfiguration("localNest").update("model", model, vscode.ConfigurationTarget.Global);
    await refreshStatus(false);
    view?.webview.postMessage({ type: "showChat" });
    vscode.window.showInformationMessage("LocalNest: downloaded " + model + " — chat is ready.");
  } catch (err: any) {
    downloadingModel = "";
    const msg = String(err?.message || err);
    if (msg.includes("not installed")) {
      view?.webview.postMessage({ text: "Ollama is NOT installed on this machine, so nothing could download. Press Install Ollama, install it from ollama.com/download, restart Antigravity, then download again.", type: "setupStatus" });
      vscode.window.showWarningMessage("LocalNest: Ollama is not installed. Install it from https://ollama.com/download, restart Antigravity, then download a model.");
    } else {
      view?.webview.postMessage({ text: "Download failed for " + model + ": " + msg + "\nTrying the terminal instead — watch the terminal for the full error.", type: "setupStatus" });
      pullOllamaModel(model);
    }
  }
}
async function focusChatView(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.extension.localNest");
  } catch { /* container focus is best-effort */ }
  await vscode.commands.executeCommand("localNest.chat.focus");
  vscode.window.showInformationMessage("LocalNest Chat is in the left sidebar. If you still see only Models, click the sidebar title at the top and choose 'LocalNest Chat' (in the Vyntra build it is called 'Vyntra Chat').");
}
async function runDiagnose(includeSelfTest: boolean): Promise<void> {
  const cfg = getConfig();
  const online = await providerOnline(cfg);
  const lines = [
    "Provider: " + cfg.provider + " / model: " + modelForProvider(cfg),
    "Host: " + (cfg.provider === "ollama" ? cfg.host : cfg.provider === "openai" ? (effectiveOpenAiUrl || cfg.openaiBaseUrl) : "Gemini API"),
    "Online: " + (online ? "yes" : "no"),
    "Workspace: " + (workspaceRootUri()?.fsPath || "none open"),
    "History: " + conversationHistory.length + " message(s) kept, " + olderChats.length + " older message(s) stored",
    "Learned answers: " + learnedAnswers.length + " stored (used first for matching questions)",
    "Last created/updated: " + (lastAppliedFiles.join(", ") || "none"),
    "Agent steps ceiling: " + cfg.agentMaxRounds + ", temperature: " + cfg.temperature,
    "Target: " + targetKind + (targetCustom ? " (" + targetCustom + ")" : "") + ", full desktop access: " + (fullAccessEnabled ? "on" : "off")
  ];
  if (includeSelfTest) { lines.push("Self-test:\n" + selfTestText()); }
  const text = lines.join("\n");
  const channel = vscode.window.createOutputChannel("LocalNest Diagnose");
  channel.appendLine(text);
  channel.show();
  view?.webview.postMessage({ text: "Diagnose:\n" + text, type: "assistant" });
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
    for (const url of openAiUrls(cfg)) {
      if (await checkOpenAi({ apiKey: key, baseUrl: url, model: cfg.openaiModel })) { effectiveOpenAiUrl = url; return true; }
    }
    return false;
  }
  const healthy = await checkHealth(cfg.host);
  if (!healthy && cfg.ollamaAutoStart) {
    await tryAutoStartOllama(cfg.host);
    return checkHealth(cfg.host);
  }
  return healthy;
}

async function* providerStream(cfg: Config, messages: LlmMessage[], modelOverride?: string): AsyncGenerator<string, void, unknown> {
  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  const timer = cfg.agentTaskTimeoutMs > 0 ? setTimeout(() => currentAbort?.abort(), cfg.agentTaskTimeoutMs) : undefined;
  try {
    if (cfg.provider === "gemini") {
      const key = await getGeminiKey();
      if (!key) {
        throw new Error("No Gemini API key set. Run “Vyntra: Set Gemini API Key” from the Command Palette, or pick Ollama as the provider.");
      }
      const maxTokens = cfg.agentMaxGeneratedTokens > 0 ? cfg.agentMaxGeneratedTokens : (cfg.lowBandwidth ? 4096 : 8192);
      yield* geminiChatStream(key, modelOverride || cfg.geminiModel, messages, maxTokens, cfg.temperature, signal);
      return;
    }
    if (cfg.provider === "openai") {
      const key = await getOpenAIKey();
      const maxTokens = cfg.agentMaxGeneratedTokens > 0 ? cfg.agentMaxGeneratedTokens : (cfg.lowBandwidth ? 4096 : 8192);
      yield* openAiChatStream({ apiKey: key, baseUrl: effectiveOpenAiUrl || cfg.openaiBaseUrl, maxTokens, model: modelOverride || cfg.openaiModel, temperature: cfg.temperature }, messages, signal);
      return;
    }
    // Speed: cap output at 4096 tokens by default instead of uncapped —
    // uncapped generation keeps running long after the useful answer ends.
    const maxTokens = cfg.ollamaMaxOutputTokens > 0 ? cfg.ollamaMaxOutputTokens : (cfg.agentMaxGeneratedTokens > 0 ? cfg.agentMaxGeneratedTokens : (cfg.lowBandwidth ? 2048 : 4096));
    yield* chatStream(cfg.host, modelOverride || cfg.model, messages, signal, maxTokens, cfg.temperature, cfg.ollamaContextWindow, cfg.ollamaAgentThinking);
  } finally {
    if (timer) { clearTimeout(timer); }
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
  const ws = workspaceRootUri()?.fsPath;
  if (targetKind === "workspace" && ws && isFromScratchRequest(prompt)) {
    // "Do it on your own, from scratch" = a new folder for this project,
    // never loose files dumped into the open workspace.
    const folder = sanitizeProjectName(prompt);
    return vscode.Uri.file(require("path").join(ws, folder));
  }
  const root = buildRootForPrompt(targetKind, targetCustom, ws, prompt);
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
      postModelsUpdate(models, "gemini");
      if (showToast) {
        vscode.window.showWarningMessage("Vyntra: no Gemini API key set. Run “Vyntra: Set Gemini API Key”, or switch Provider back to Ollama.");
      }
      return { models, online: false };
    }
    const online = await checkGemini(key);
    statusBar.text = online ? "◉ GEMINI 3.8 FLASH" : "○ Gemini offline";
    statusBar.tooltip = online ? "Vyntra — Gemini API online, model " + cfg.geminiModel : "Vyntra — Gemini API not reachable. Check your key.";
    view?.webview.postMessage({ host: "Gemini API", model: cfg.geminiModel, models, online, provider: "gemini", type: "status" });
    postModelsUpdate(models, "gemini");
    return { models, online };
  }
  if (cfg.provider === "openai") {
    const key = await getOpenAIKey();
    const online = await checkOpenAi({ apiKey: key, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel });
    statusBar.text = online ? "◉ OPENAI-COMPAT" : "○ OpenAI host offline";
    statusBar.tooltip = online ? "Vyntra — OpenAI-compatible host online, model " + cfg.openaiModel : "Vyntra — OpenAI-compatible host not reachable at " + cfg.openaiBaseUrl;
    view?.webview.postMessage({ host: effectiveOpenAiUrl || cfg.openaiBaseUrl, model: cfg.openaiModel, models: [cfg.openaiModel], online, provider: "openai", type: "status" });
    postModelsUpdate([cfg.openaiModel], "openai");
    return { models: [cfg.openaiModel], online };
  }
  try {
    const models = await listModels(cfg.host);
    // Whichever model the user pulled on their desktop is the model to use:
    // if the saved model is not among the installed models, switch to the
    // first installed one instead of failing on a model that was never pulled.
    // EXCEPT when the user just picked a model to download — then the pick
    // must stay selected so Download pulls that model, not the installed one.
    let effectiveModel = cfg.model;
    if (models.length && !models.includes(effectiveModel) && userPickedDownloadModel !== effectiveModel) {
      effectiveModel = models.includes("qwen2.5-coder:7b") ? "qwen2.5-coder:7b" : models[0];
      await vscode.workspace.getConfiguration("localNest").update("model", effectiveModel, vscode.ConfigurationTarget.Global);
    }
    statusBar.text = "◉ LOCAL OLLAMA";
    statusBar.tooltip = "Vyntra — Ollama online at " + cfg.host + " (" + models.length + " models, using " + effectiveModel + ")";
    view?.webview.postMessage({ host: cfg.host, model: effectiveModel, models, online: true, provider: "ollama", type: "status" });
    postModelsUpdate(models, "ollama");
    return { models, online: true };
  } catch {
    statusBar.text = "○ Ollama offline";
    statusBar.tooltip = "Vyntra — Ollama not reachable at " + cfg.host + ". Start Ollama, then click to retry.";
    view?.webview.postMessage({ host: cfg.host, model: cfg.model, models: [], online: false, provider: "ollama", type: "status" });
    postModelsUpdate([], "ollama");
    if (showToast) {
      vscode.window.showWarningMessage(
        "Vyntra: Ollama is not reachable at " + cfg.host + ". Start it with `ollama serve`, then pull a model (e.g. ollama pull qwen2.5-coder:7b)."
      );
    }
    return { models: [], online: false };
  }
}


// --- Built-in skills (0.9.25) ---
// A skill is a slash command typed at the start of a chat message, e.g.
// "/review explain this function". It does not need a model, a key, or a
// separate install — it just changes what the model is asked to do, and it
// works with the user's local Ollama model only.
type Skill = { description: string; prompt: string };
const SKILLS: Record<string, Skill> = {
  review: { description: "Review code for bugs, security, performance and style", prompt: "You are doing a CODE REVIEW. Group findings as Critical / Major / Minor, each with the file or code it refers to and a concrete fix suggestion. Do not rewrite whole files unless the user asked for a rewrite." },
  test: { description: "Generate tests for the given code", prompt: "Generate TESTS for the code given. Cover the main path, edge cases and failure cases. Use the project's own test style if the workspace context shows one, otherwise a plain, runnable test file. Output code in code blocks; in Agent/Build mode output as FILE blocks for review." },
  fix: { description: "Fix bugs / diagnostics in the given code", prompt: "FIX the bug or diagnostic in the code given. Explain the cause in one or two lines first, then give the corrected code. Do not change unrelated behaviour." },
  explain: { description: "Explain code in simple steps", prompt: "EXPLAIN the code given in simple steps: what it does, how it works, and its edge cases. Use plain language first, then technical detail. Do not rewrite the code unless asked." },
  docs: { description: "Write documentation / README for the given code or project", prompt: "Write DOCUMENTATION for the code or project given: what it does, how to run it, its main files and commands, and an example. Keep it clear and short, in Markdown." },
  refactor: { description: "Refactor code without changing what it does", prompt: "REFACTOR the code given for readability and maintainability, without changing its behaviour. Keep every public name and output the same unless the user asked otherwise. Say what you changed and why." },
  commit: { description: "Write a commit message for a described change", prompt: "Write a COMMIT MESSAGE for the change described: a short conventional-commit title (feat/fix/docs/refactor/test/chore), then a 2-4 line body saying what changed and why. If no change is described, say what information is missing instead of inventing one." },
  security: { description: "Security audit: SQLi, XSS, secrets, auth, crypto, SSRF, etc.", prompt: "Do a SECURITY AUDIT of the code given. Check SQL injection, command injection, XSS, hardcoded secrets, weak crypto, insecure random, unsafe deserialisation, path traversal, SSRF, debug mode and missing auth. Give each finding a risk level (Critical/High/Medium/Low), the risky code, and a secure fix. If nothing is risky, say so plainly." },
  summarize: { description: "Summarise a file, project or workspace", prompt: "SUMMARISE what was given: purpose, main parts, how they fit together, and anything important or risky. Keep it short and structured. Do not invent files or features that are not in the context." },
  autofix: { description: "Auto-fix diagnostics: fix the errors/warnings in the current file (or workspace with 'all') as reviewable FILE blocks — never applied without your approval", prompt: "AUTO-FIX DIAGNOSTICS. Fix EVERY diagnostic listed in the request, errors first, then warnings. For each one, explain the cause in one line, then give the corrected code. In Agent/Build mode output the corrected files ONLY as ### FILE: blocks, so each fix goes through the normal review-and-approve flow — NEVER claim a fix has been applied, and NEVER write a file yourself. Change only the lines needed to fix the diagnostics; do not change unrelated behaviour. If a diagnostic cannot be fixed from the context given, say which one and what file you would need, instead of guessing." },
  qa: { description: "Codebase Q&A: ask about this workspace — where X is defined, how Y works — answered only from the actual files, with file:line citations", prompt: "CODEBASE QUESTION. Answer ONLY from the workspace files given as context, and cite every claim as file:line (e.g. src/extension.ts:123). Do NOT invent functions, files or APIs that are not in the context. If the answer is not in the context, say plainly that it was not found in the searched files and name what file you would need. Keep the answer short and structured: the definition first, then how it is used, then anything risky or worth knowing." },
};
function skillsHelpText(): string {
  return "Built-in skills — type one at the start of your message:\n" + Object.entries(SKILLS).map(([n, s]) => "/" + n + " — " + s.description).join("\n") + "\n\nExample: /review look at this function and tell me what is wrong\nType /skills any time to see this list again.";
}

function systemPrompt(mode: Mode, skillPrompt?: string, projectRules?: { content: string; file: string } | null): string {
  const universal =
    "You are Vyntra, a general-purpose LLM for Antigravity, fluent in EVERY programming language — Python, Java, JavaScript, TypeScript, Go, Rust, C, C++, C#, Kotlin, Swift, PHP, Ruby, SQL, HTML/CSS and any other language the user names. Never default to JavaScript/web unless the user asked for it: if they name a language, use ONLY that language, its idioms, its project files (e.g. go.mod, Cargo.toml, pom.xml, requirements.txt, package.json) and its run commands. If they do not name a language, pick the best fit and say which one you picked in the README. " +
    platformInfo() +
    " REAL-WORLD PROBLEMS: when the user describes a real problem — an API, a login system, a shop, a report, a migration, a dashboard, a real app — build the real thing, not a toy example: work out the requirements first, handle edge cases and invalid input, return proper errors, persist data, add login/auth only where asked (with hashed passwords and JWT, never plain text), add pagination on lists, log what matters, include a runnable test, and write a README with run and deploy steps. A hello-world starter is never the answer to a real-world request." +
    " SECURITY (always, especially for websites): write secure code by default — escape/sanitise all user input, never insert user data with innerHTML (use textContent / DOM creation), add a Content-Security-Policy meta tag to web pages, never put API keys, passwords or secrets in client code, validate input on every form, use parameterised queries / prepared statements for databases, hash passwords (never store plain text), use HTTPS links only, and add a short SECURITY note in the README naming what was secured.";
  const skillSection = skillPrompt ? " SKILL IN USE: " + skillPrompt + " Follow this skill above all other style rules, but still answer exactly the current request." : "";
  const rulesSection = projectRules ? " PROJECT RULES (from " + projectRules.file + " in this project — follow these for every answer, they override generic style):\n" + projectRules.content : "";
  const questionFirst = " RULE: answer the user's CURRENT request exactly as asked, in the mode selected. Do not change topic, do not answer a different question, do not build a different project, and do not repeat an older task from history. If the request is a question, answer that question first and directly, before any extra detail. Workspace context and older chat are background only — they must never replace the current request.";
  const decisions = " DECISIONS (Agent/Build only): small decisions (language, file names, colours, layout, library choice for a small task) — decide them yourself at once, do not ask, and say what you decided in the README/proposal. Big decisions (a complete/full project, database choice, login/auth design, payments, hosting/deployment, architecture) — if the user has not already chosen, ask ONCE with 2-3 options and a clearly marked recommended option, then wait for their answer; if they answer 'you decide' / 'anything' / 'do it', go with the recommended option and say so.";
  if (mode === "plan") {
    return [
      universal + rulesSection + skillSection + questionFirst,
      "Plan ONLY what the user asked for in the current request — nothing else.",
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
      universal + rulesSection + skillSection + questionFirst + decisions,
      "Propose changes; the user approves each one before anything is written.",
      "If the user asked a question or for an explanation (not a change), answer it in plain text — do NOT force it into FILE blocks.",
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
      universal + rulesSection + skillSection + questionFirst + decisions,
      "You build complete, working apps in ANY language the user names.",
      "Build EXACTLY what the user asked for in the current request — same topic, same language, same features. Do not substitute a different app.",
      "If the user asked a question or for an explanation (not a build), answer it in plain text — do NOT force it into FILE blocks.",
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
    universal + rulesSection + skillSection + questionFirst,
    "Answer ANY question the user asks — coding or general, about this workspace or not, in any programming language they ask for.",
    "Answer the exact question asked first, directly and completely. Do not turn a question into a project build unless the user asked for one.",
    "Use the workspace context when it is relevant and cite file paths then. When it is not relevant, answer from your own knowledge and say so.",
    "Use code blocks for code. Be direct and complete: give the answer, the explanation, and a working example where one helps.",
    "Do not invent functions, files or APIs that are not in the context when you claim they are in this workspace. If you are unsure, say what is missing instead of guessing."
  ].join("\n");
}


// --- Decisions, security, and from-scratch folders (user request, 0.9.20) ---
function isFromScratchRequest(text: string): boolean {
  return /\b(from scratch|on your own|do it yourself|create (a )?folder|new folder|own folder|from the beginning)\b/i.test(text);
}
function isBigDecision(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(use|with|using)\s+(sqlite|postgres|mysql|firebase|mongodb|supabase)\b/.test(lower)) { return false; }
  if (/\b(no (database|auth|login)|local only|localstorage only)\b/.test(lower)) { return false; }
  return /\b(complete|full|entire|whole)\s+(app|website|project|system)/.test(lower)
    || /\b(database|auth|login|sign[- ]?in|payment|hosting|deploy|architecture|e-?commerce|shop|store)\b/.test(lower)
    || isMajorRequest(text);
}
function recommendOption(text: string): string {
  const lower = text.toLowerCase();
  if (/shop|store|e-?commerce/.test(lower)) { return "Static website + localStorage cart, no backend and no payments — fastest, safest to start; add a real backend later only if you need real orders."; }
  if (/auth|login|sign[- ]?in/.test(lower)) { return "Local-only demo login (no real passwords stored in client code) — real auth needs a backend and password hashing, which I will add only if you confirm."; }
  if (/database/.test(lower)) { return "localStorage / a local file database (SQLite) — no cloud account, no key, data stays on your machine."; }
  if (/website|web/.test(lower)) { return "Plain HTML/CSS/JS, self-contained, no build step — fastest to run, smallest attack surface, with CSP and escaped user input."; }
  return "Plain, self-contained build with local storage, no cloud backend — fastest and safest to start, easy to upgrade later.";
}
function autoDecisionNote(text: string): string {
  const lang = detectLanguage(text);
  const langName = lang ? lang.name : "HTML/CSS/JS (plain website, no build step)";
  return "Auto-decided (small decision, no question asked): language " + langName + ", plain self-contained structure, local storage for persistence, secure defaults (escaped user input, CSP for web pages, no secrets in client code).";
}
let pendingBigDecision: { recommendation: string; text: string } | null = null;
// Model the user just picked in the dropdown to download. refreshStatus must
// NOT auto-switch this back to an already-installed model, or the pick
// snaps back and Download pulls the wrong (already installed) model.
let userPickedDownloadModel: string | null = null;

// Only inspect the workspace when the user actually asks for it — a
// mention of the project/files, an @ mention, a file path/extension, or
// selected code in the editor. Otherwise the task is answered directly,
// with no Step 1 and no workspace scan slowing it down.
function needsWorkspaceContext(text: string): boolean {
  const lower = text.toLowerCase();
  if (/@(file|selection|terminal|diagnostics|git)\b/.test(lower)) { return true; }
  if (/\b(project|workspace|folder|repository|repo|codebase|my code|this project|this file|this folder|look at|check (this|my|the)|in this project|in my project|in this file)\b/.test(lower)) { return true; }
  if (/[A-Za-z0-9_\-\/]+\.(py|js|ts|tsx|jsx|html|css|json|md|go|rs|java|php|rb|c|cpp|h)\b/.test(text)) { return true; }
  if (/\b[a-z0-9_\-]+\/[a-z0-9_\-\/]+/.test(text)) { return true; }
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) { return true; }
  } catch { /* no editor */ }
  return false;
}
// --- Auto-fix diagnostics (0.9.36) ---
// Read VS Code diagnostics into plain DiagnosticItem[] for diagnostics.ts.
// Nothing here applies a fix — the model proposes FILE blocks and the user
// approves them through the normal proposal flow, exactly like Agent mode.
function collectEditorDiagnostics(scope: "file" | "workspace"): DiagnosticItem[] {
  const toItem = (uri: vscode.Uri, d: vscode.Diagnostic): DiagnosticItem => ({
    code: typeof d.code === "object" && d.code !== null ? String((d.code as { value?: string | number }).value ?? "") : (d.code as string | number | undefined),
    column: d.range.start.character + 1,
    file: vscode.workspace.asRelativePath(uri),
    line: d.range.start.line + 1,
    message: d.message,
    severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" : d.severity === vscode.DiagnosticSeverity.Information ? "info" : "hint",
    source: d.source
  });
  const items: DiagnosticItem[] = [];
  if (scope === "workspace") {
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) { items.push(toItem(uri, d)); }
    }
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return items; }
    for (const d of vscode.languages.getDiagnostics(editor.document.uri)) {
      items.push(toItem(editor.document.uri, d));
    }
  }
  items.sort((a, b) => (a.severity === "error" ? 0 : a.severity === "warning" ? 1 : 2) - (b.severity === "error" ? 0 : b.severity === "warning" ? 1 : 2) || a.file.localeCompare(b.file) || a.line - b.line);
  return items.slice(0, 50);
}
async function handleChat(mode: Mode, text: string, autoApply: boolean, majorFlag: boolean, modelOverride?: string) {
  lastChatRequest = { autoApply, majorFlag, mode, text };
  // Taught Q&A: "Q: ... A: ..." / "Question: ... Answer: ..." — store it
  // and confirm, do not send it to the model as a question.
  const taught = parseTaughtQA(text);
  if (taught) {
    const q = storeLearnedAnswer(taught.question, taught.answer);
    view?.webview.postMessage({ text: q ? "Stored — I will use this answer first next time a similar question comes up.\nQ: " + q + "\nA: " + taught.answer.slice(0, 500) + (learnedAnswers.length ? "\n(" + learnedAnswers.length + " learned answer(s) stored in total.)" : "") : "That did not look like a complete question + answer — use: Q: <question> A: <answer>", type: "assistant" });
    return;
  }
  // Correction of the last answer: "No, the correct answer is ..." —
  // store it against the last question, so the next similar question
  // gets the corrected answer instead of the model's wrong one.
  if (/^(no,?|wrong,?|actually,?|correct answer is|the correct answer is)\b/i.test(text.trim()) && lastChatRequest && conversationHistory.length) {
    const prev = [...conversationHistory].reverse().find((m) => m.role === "user");
    if (prev) {
      const q = storeLearnedAnswer(displayContent(prev), text.trim());
      view?.webview.postMessage({ text: q ? "Got it — stored the corrected answer for that question, and I will use it first next time it comes up.\nQ: " + q : "Could not tell which question that corrects — teach it with: /learn <question> | <answer>", type: "assistant" });
      return;
    }
  }
  // Slash skills: "/review ..." etc. Handled before anything else, so a
  // skill never gets mistaken for a normal question, and /skills lists them.
  const slash = text.trim().match(/^\/(\w+)\s*(.*)$/s);
  let skillPrompt: string | undefined;
  // Auto-fix diagnostics (0.9.36) and codebase Q&A (0.9.36) state, carried
  // from the slash handling below into the model call further down.
  let diagnosticItems: DiagnosticItem[] = [];
  let diagnosticScope = "";
  let isQaRequest = false;
  let slashHandled = false;
  const customSkills = await loadCustomSkills();
  const allSkills: Record<string, Skill> = { ...SKILLS, ...customSkills };
  const projectRules = await loadProjectRules();
  if (slash) {
    const name = slash[1].toLowerCase();
    if (name === "skills" || name === "help") {
      view?.webview.postMessage({ text: await skillsHelpTextFull(), type: "assistant" });
      return;
    }
    if (name === "learn") {
      if (!slash[2].trim()) { view?.webview.postMessage({ text: "Teach me a question + answer so I use it next time:\n/learn <question> | <answer>\nExample: /learn how do I start Ollama | Run: ollama serve, then ollama pull llama3.2:3b\nOr just type: Q: <question> A: <answer>", type: "assistant" }); return; }
      const parsed = parseLearnArg(slash[2].trim());
      if (!parsed) { view?.webview.postMessage({ text: "I need a question and an answer separated by | — /learn <question> | <answer>", type: "assistant" }); return; }
      const q = storeLearnedAnswer(parsed.question, parsed.answer);
      view?.webview.postMessage({ text: q ? "Stored — I will use this answer first next time a similar question comes up. (" + learnedAnswers.length + " learned answer(s) stored in total.)" : "That did not look like a complete question + answer.", type: "assistant" }); return;
    }
    if (name === "learned") {
      view?.webview.postMessage({ text: learnedAnswers.length ? "Learned answers (" + learnedAnswers.length + " stored — I use these first for matching questions):\n" + learnedAnswers.map((x, i) => (i + 1) + ". Q: " + x.question + "\n   A: " + x.answer.slice(0, 200) + (x.answer.length > 200 ? "…" : "")).join("\n") + "\n\nForget one with: /forget-learned <number>" : "No learned answers stored yet. Teach one with: /learn <question> | <answer> — or type: Q: <question> A: <answer>", type: "assistant" }); return;
    }
    if (name === "forget-learned" || name === "forgetlearned") {
      const arg = slash[2].trim();
      const n = parseInt(arg, 10);
      if (!isNaN(n) && n >= 1 && n <= learnedAnswers.length) { const removed = learnedAnswers.splice(n - 1, 1)[0]; saveLearnedAnswers(); view?.webview.postMessage({ text: "Forgot learned answer #" + n + ": " + removed.question, type: "assistant" }); }
      else if (arg) { const before = learnedAnswers.length; learnedAnswers = learnedAnswers.filter((x) => normQ(x.question) !== normQ(arg)); if (learnedAnswers.length < before) { saveLearnedAnswers(); view?.webview.postMessage({ text: "Forgot the learned answer for: " + arg, type: "assistant" }); } else { view?.webview.postMessage({ text: "No learned answer matches that — see /learned for the list.", type: "assistant" }); } }
      else { view?.webview.postMessage({ text: "Usage: /forget-learned <number> — see /learned for the numbers.", type: "assistant" }); }
      return;
    }
    // Auto-fix diagnostics (0.9.36): "/autofix" with no argument fixes the
    // current file; "/autofix all" fixes the whole workspace. Unlike other
    // skills an empty argument is valid — the diagnostics ARE the input.
    // Fixes are proposed as FILE blocks and approved like any Agent proposal;
    // nothing is ever applied here.
    if (name === "autofix" || name === "fixdiagnostics" || name === "fix-diagnostics") {
      const arg = slash[2].trim();
      const scope = /\ball\b/i.test(arg) ? "workspace" as const : "file" as const;
      diagnosticItems = collectEditorDiagnostics(scope);
      diagnosticScope = scope === "workspace" ? "whole workspace" : ("current file" + (vscode.window.activeTextEditor ? " (" + vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri) + ")" : ""));
      if (!diagnosticItems.length) {
        view?.webview.postMessage({ text: "Auto-fix: no diagnostics reported for the " + diagnosticScope + " — nothing to fix. If you expected errors, make sure the file is saved and its language extension has finished checking it.", type: "assistant" });
        return;
      }
      const counts = countBySeverity(diagnosticItems);
      view?.webview.postMessage({ text: "Auto-fix: found " + diagnosticItems.length + " diagnostic(s) in the " + diagnosticScope + " (" + counts.errors + " error(s), " + counts.warnings + " warning(s)). I will propose fixes as FILE blocks for your review — nothing is applied without your approval.", type: "assistant" });
      skillPrompt = SKILLS.autofix.prompt;
      text = arg && !/^\s*all\s*$/i.test(arg) ? arg : "Fix all diagnostics in the " + diagnosticScope;
      slashHandled = true;
    }
    // Codebase Q&A (0.9.36): "/qa where is X defined" — answered only from
    // the actual workspace files, with file:line citations.
    if (name === "qa") {
      if (!slash[2].trim()) {
        view?.webview.postMessage({ text: "Usage: /qa <your question about this codebase>\nExamples:\n/qa where is collectContext defined\n/qa how does the proposal approval flow work\n/qa what calls parseProposal", type: "assistant" });
        return;
      }
      isQaRequest = true;
      skillPrompt = SKILLS.qa.prompt;
      text = slash[2].trim();
      slashHandled = true;
    }
    if (!slashHandled) {
    const skill = allSkills[name];
    if (!skill) {
      view?.webview.postMessage({ text: "Unknown skill '/" + name + "'.\n\n" + await skillsHelpTextFull(), type: "assistant" });
      return;
    }
    if (!slash[2].trim()) {
      view?.webview.postMessage({ text: "Usage: /" + name + " <your code, file, or question>\n" + skill.description + "\n\nExample: /" + name + " explain this function", type: "assistant" });
      return;
    }
    skillPrompt = skill.prompt;
    text = slash[2].trim();
    }
  }
  // Plain (non-slash) codebase questions are detected too, so "where is X
  // defined?" works without remembering the /qa skill.
  if (!slash && isCodebaseQuestion(text)) {
    isQaRequest = true;
  }
  const cfg = getConfig();
  if (!cfg.chatMemoryEnabled) { conversationHistory = []; }
  currentRequestRoot = buildTargetUri(text, mode);
  agentState = { autoApply, lastOutput: "", mode, step: 1, task: text };
  const online = await providerOnline(cfg);
  // Big-decision gate (asked ONCE, then the user decides or says 'you decide'):
  if (online && (mode === "agent" || mode === "build")) {
    const saidYouDecide = /\b(you decide|anything|do it|go ahead|yes,? (do|build) it|ok,? (do|build) it)\b/i.test(text);
    if (pendingBigDecision && saidYouDecide) {
      view?.webview.postMessage({ text: "You didn't pick an option, so I am going with the better option I suggested: " + pendingBigDecision.recommendation, type: "assistant" });
      pendingBigDecision = null;
    } else if (pendingBigDecision && !saidYouDecide) {
      // The user's reply IS their answer to the one question — clear it and build with it.
      pendingBigDecision = null;
    } else if (!pendingBigDecision && isBigDecision(text)) {
      const rec = recommendOption(text);
      pendingBigDecision = { recommendation: rec, text };
      view?.webview.postMessage({ text: "One question before I build this (this is a big decision, so I am asking once, not deciding it myself):\n\nRecommended (better option): " + rec + "\n\nReply with your choice — or just say 'you decide' and I will go with the recommended option above.", type: "assistant" });
      await refreshStatus(true);
      return;
    }
  }
  // From-scratch folder notice, so the user sees where files will go.
  if (mode === "build" && isFromScratchRequest(text) && currentRequestRoot) {
    view?.webview.postMessage({ text: "Building from scratch in a new folder: " + currentRequestRoot.fsPath + " — files will go there, not loose in your workspace.", type: "assistant" });
  }
  const autoNote = autoDecisionNote(text);
  // Auto-fix and codebase Q&A always inspect the workspace: the diagnostics
  // live in the editor and the Q&A answer must come from real files.
  const inspectWorkspace = needsWorkspaceContext(text) || diagnosticItems.length > 0 || isQaRequest;
  // Speed: Ask questions use a small context (4 files, 30k budget via
  // low-bandwidth mode) — a huge prompt is the main reason CPU answers
  // feel slow. Agent/Build keep the full context.
  const effectiveMaxFiles = mode === "ask" ? 4 : (cfg.lowBandwidth ? Math.max(3, Math.floor(cfg.maxFiles / 2)) : cfg.maxFiles);
  const ctx = inspectWorkspace
    ? await collectContext(text, effectiveMaxFiles, mode === "ask" || cfg.lowBandwidth, { maxFileBytes: cfg.contextMaxFileBytes, maxIndexCharacters: cfg.contextMaxIndexCharacters, maxIndexedFiles: cfg.contextMaxIndexedFiles })
    : { files: [] as any[], summary: "No workspace inspection requested — answering the task directly, without scanning project files." };
  const contextPrompt = inspectWorkspace ? contextToPrompt(ctx.files) : "No workspace files inspected. Answer from the question/task alone.";
  // Grounded evidence for the two new features (0.9.36): the diagnostics
  // themselves for /autofix, and the file:line definitions found by scanning
  // the context files for /qa or a plain codebase question. This goes into
  // the model prompt AND the offline reply, so the grounding is visible
  // even when Ollama is offline.
  let extraContext = "";
  if (diagnosticItems.length) {
    extraContext += "\n\n" + buildAutoFixPrompt(diagnosticItems, diagnosticScope) + "\nRULE: propose fixes as FILE blocks for review; NEVER apply a fix without the user's approval.";
  }
  if (isQaRequest) {
    const grounded = buildCodebaseAnswer(text, ctx.files);
    extraContext += "\n\nGrounded workspace evidence — cite these file:line citations, do not invent others:\n" + grounded.answerText;
    view?.webview.postMessage({ text: "Codebase Q&A — grounded in the workspace files searched:\n" + grounded.answerText, type: "assistant" });
  }
  const lang = detectLanguage(text);
  const langNote = lang ? "\nTarget language: " + lang.name + " (main file " + lang.mainFile + ", run with: " + lang.runCommand + "). Use this language only." + fullLanguageGuidance(lang) : "";
  if (inspectWorkspace) {
    // Step 1, made visible, only when the user asked for a project/file look:
    view?.webview.postMessage({
      text: "Step 1 — Inspect workspace (context before code): " + ctx.summary + (ctx.files.length ? "\nTop files used as context: " + ctx.files.map((f) => f.path).join(", ") : "\nNo workspace files matched — answering from the model alone."),
      type: "assistant"
    });
  }

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
      // Offline grounding (0.9.36): diagnostics + hints, and the codebase
      // answer, are useful without a model — show them, not just "offline".
      ...(extraContext ? [extraContext, ""] : []),
      cfg.provider === "gemini"
        ? "To go live: run “Vyntra: Set Gemini API Key” (key from https://aistudio.google.com/app/apikey), select Provider: Gemini, model gemini-3.8-flash, then press Refresh."
        : "To go live: `ollama serve` in a terminal, then `ollama pull qwen2.5-coder:7b` (or another code model), then press Refresh in this panel. You can also point Vyntra at a remote Ollama host in Settings. No GPU setup is needed — Ollama runs on CPU by default.",
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

  const retrieved = cfg.chatMemoryEnabled ? retrieveOlderChats(text, olderChats, cfg.chatMemoryResultCount, cfg.chatMemoryRetrievedCharacters) : [];
  const olderSection = retrieved.length ? "\n\nOlder chat — BACKGROUND ONLY, do NOT answer these instead of the current request:\n" + retrieved.map((m) => m.role + ": " + m.content).join("\n---\n") : "";
  const modeNote = (mode === "agent" || mode === "build") ? "\n" + autoNote : "";
  const learned = findLearnedAnswers(text);
  if (learned.length) {
    view?.webview.postMessage({ text: "Using your learned answer for a matching question — " + learned.map((x) => "\"" + x.question + "\"").join(", ") + ".", type: "assistant" });
  }
  const learnedSection = learned.length ? "\n\nLearned answers from you (use these FIRST — they are your own correct answers for this type of question, and they override the model's guess):\n" + learned.map((x) => "Q: " + x.question + "\nA: " + x.answer).join("\n---\n") : "";
  const userTurn: LlmMessage = {
    content: "MODE: " + mode + "\n\nCURRENT USER REQUEST — answer exactly this, do not switch topic:\n" + text + langNote + learnedSection + "\n\nWorkspace context (background only, use only if relevant to the current request):\n" + (inspectWorkspace ? ctx.summary + "\n" + contextPrompt : "None — no workspace files inspected.") + extraContext + (contextSummary ? "\n\nSummary of earlier chat (already trimmed, use this instead of the dropped messages):\n" + contextSummary : "") + olderSection + "\n" + platformInfo() + modeNote,
    role: "user"
  };
  conversationHistory = applyHistory([...conversationHistory, userTurn], cfg.historyCharacters);
  ensureSession(); saveCurrentSession(); postSessions(); postContext(mode); if (lastTrimNotice) { view?.webview.postMessage({ text: lastTrimNotice, type: "assistant" }); lastTrimNotice = ""; }
  const messages: LlmMessage[] = [
    { content: systemPrompt(mode, skillPrompt, projectRules), role: "system" },
    ...conversationHistory
  ];

  let full = "";
  let streamError: any = null;
  const startedAt = Date.now();
  const effectiveModel = modelOverride || modelForMode(cfg, mode);
  try {
    for await (const chunk of providerStream(cfg, messages, effectiveModel)) {
      full += chunk;
      view?.webview.postMessage({ text: chunk, type: "stream" });
    }
  } catch (err: any) {
    streamError = err;
  }
  if (!streamError && full) {
    conversationHistory = applyHistory([...conversationHistory, { content: full, role: "assistant" }], cfg.historyCharacters);
    saveCurrentSession(); postSessions(); postContext(mode); if (lastTrimNotice) { view?.webview.postMessage({ text: lastTrimNotice, type: "assistant" }); lastTrimNotice = ""; }
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    view?.webview.postMessage({ type: "streamDone" });
    view?.webview.postMessage({ text: "— " + secs + "s · ~" + estimateTokens(full) + " tokens in this reply (estimate, 1 token ≈ 4 chars) · history: " + conversationHistory.length + " message(s) kept", type: "assistant" });
  }
  if (streamError && String(streamError?.name || "") === "AbortError") {
    view?.webview.postMessage({ text: "Generation stopped by you. The partial reply was not saved to history.", type: "assistant" });
    // Remove the user turn that was not answered, so the next turn is clean.
    conversationHistory = conversationHistory.slice(0, -1);
    return;
  }
  // Ollama-only retry: if the saved model was never pulled, Ollama returns
  // "model not found" — retry the same question with a model the user
  // actually pulled on their desktop, instead of leaving the question
  // unanswered. This never falls back to any cloud model.
  if (streamError && String(streamError?.message || streamError).toLowerCase().includes("not found")) {
    try {
      const installed = await listModels(cfg.host);
      const retryModel = installed.length ? (installed.includes("qwen2.5-coder:7b") ? "qwen2.5-coder:7b" : installed[0]) : "";
      if (retryModel && retryModel !== effectiveModel) {
        view?.webview.postMessage({ text: "Note: model `" + effectiveModel + "` was not found in Ollama, so I retried with your pulled model `" + retryModel + "`. Pick that model in Model to avoid this next time.", type: "assistant" });
        full = "";
        try {
          for await (const chunk of providerStream(cfg, messages, retryModel)) {
            full += chunk;
            view?.webview.postMessage({ text: chunk, type: "stream" });
          }
          streamError = null;
          if (full) {
            conversationHistory = applyHistory([...conversationHistory, { content: full, role: "assistant" }], cfg.historyCharacters);
    saveCurrentSession(); postSessions(); postContext(mode); if (lastTrimNotice) { view?.webview.postMessage({ text: lastTrimNotice, type: "assistant" }); lastTrimNotice = ""; }
          }
        } catch (err2: any) {
          streamError = err2;
        }
      }
    } catch {
      // Keep the original error if the model list itself cannot be read.
    }
  }
  // Never end a question silently: an empty stream is an error, not an answer.
  if (!streamError && !full.trim()) {
    view?.webview.postMessage({ text: "The model returned an empty reply to that question. Try again, try a different pulled model in Model, or press Test my model — if Test also returns empty, the model itself is not responding and needs a different pulled model.", type: "assistant" });
    view?.webview.postMessage({ type: "streamDone" });
    return;
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
    view?.webview.postMessage({ type: "streamDone" });
    // Do not leave a half-streamed bubble or an unanswered user turn in
    // history: the next question would otherwise inherit a broken turn.
    conversationHistory = conversationHistory.slice(0, -1);
    saveCurrentSession();
    view?.webview.postMessage({
      text: "Vyntra could not reach the model: " + String(streamError?.message || streamError) + "\nCheck that " + (cfg.provider === "gemini" ? "your Gemini API key is set and gemini-3.8-flash is enabled for it" : "Ollama is running and the model `" + cfg.model + "` is pulled") + ". If you are offline, Build mode still works from templates. Ask the same question again once it is back — nothing was saved from this failed turn.",
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
    if (proposal.files.length === 0 && mode === "agent" && (/###\s*FILE:/.test(full) || /diff --git/.test(full))) {
      view?.webview.postMessage({ text: "The model tried to send files, but its file format was incomplete, so I could not extract any file safely — nothing was written. Ask again in the same words, or switch to Build mode and I will build a working version from a template.", type: "assistant" });
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

async function chatOnce(cfg: Config, messages: { content: string; role: "assistant" | "system" | "user" }[], modelOverride?: string): Promise<string> {
  let full = "";
  for await (const chunk of providerStream(cfg, messages, modelOverride)) {
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
  if (!root) {
    view?.webview.postMessage({ text: "⚠️ No project folder is open, so Approve cannot write these files yet. Open a folder (File > Open Folder), then ask again — or pick Desktop/Home/Custom as the target. The proposal below is preview-only until then.", type: "assistant" });
    vscode.window.showWarningMessage("LocalNest: no project folder is open — Approve cannot write files until you open a folder.");
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
  if (isUnsafeProposalPath(path)) {
    return "Refused to write " + path + ": it escapes the project folder (.. is not allowed).";
  }
  const _root = currentProposalRoot || workspaceRootUri();
  if (_root && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
    const normRoot = _root.fsPath.replace(/\\/g, "/").replace(/\/$/, "");
    const normPath = path.replace(/\\/g, "/");
    if (!fullAccessEnabled && normPath !== normRoot && !normPath.startsWith(normRoot + "/")) {
      return "Refused to write " + path + ": it is outside the open project folder. Turn on full desktop access, or ask for a path inside the project.";
    }
  }
  const guardFile = currentProposal.files.find((f) => f.path === path);
  if (guardFile && Buffer.byteLength(guardFile.content, "utf8") > getConfig().agentMaxFileBytes) {
    return "Refused to write " + path + ": it exceeds the agent file-size ceiling (" + getConfig().agentMaxFileBytes + " bytes). Split it into smaller files.";
  }
  const file = currentProposal.files.find((f) => f.path === path);
  if (!file) {
    return "That file is not in the proposal.";
  }
  const root = currentProposalRoot || workspaceRootUri();
  if (!root) {
    const msg = "No target folder — open a project folder first (File > Open Folder), then ask again. Nothing was written.";
    vscode.window.showErrorMessage("LocalNest: " + msg);
    return msg;
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
    const destructive = commands.filter((c) => isDangerousCommand(c));
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
  const maxRounds = cfg.agentMaxRounds > 0 ? cfg.agentMaxRounds : 5;
  for (let step = 2; step <= maxRounds; step++) {
    agentState.step = step;
    view?.webview.postMessage({ text: "Agent step " + step + "/" + maxRounds + ": verifying what was built and fixing anything still missing…", type: "assistant" });
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
  view?.webview.postMessage({ text: "Agent loop reached " + maxRounds + " steps. The last batch is applied — check the result and ask for the next fix if anything remains.", type: "assistant" });
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

class LocalNestModelsProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView) {
    modelsView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = "<!DOCTYPE html><html><body style='font-family:var(--vscode-font-family);padding:12px'><h3>Models</h3><p style='color:var(--vscode-descriptionForeground)'>These are the models you pulled in Ollama on your desktop — tap one to use it in chat. The agent chat is in <b>LocalNest Chat</b> — open it below, pick <b>Agent</b>, and type your task there.</p><button id='openAgent' style='width:100%;padding:9px'>Open LocalNest Chat (Agent)</button><button id='installOllama' style='width:100%;padding:9px;margin-top:6px'>Install Ollama (if terminal says ollama is not recognized)</button><div id='list' style='margin-top:10px'>Loading models…</div><script>var vscode=acquireVsCodeApi();document.getElementById('openAgent').addEventListener('click',function(){vscode.postMessage({type:'openAgentChat'});});document.getElementById('installOllama').addEventListener('click',function(){vscode.postMessage({type:'installOllama'});});window.addEventListener('message',function(ev){var m=ev.data;if(m.type==='models'){var el=document.getElementById('list');el.innerHTML='';if(!m.models || !m.models.length){el.innerHTML='No free models installed yet. If the terminal says 'ollama is not recognized', Ollama is NOT installed — tap Install Ollama above first, install it, restart Antigravity, then pull a free model:<br>';['qwen2.5-coder:7b','llama3.2:3b','mistral:7b'].forEach(function(name){var b=document.createElement('button');b.textContent='Pull '+name;b.style.cssText='display:block;width:100%;text-align:left;margin:4px 0;padding:8px';b.addEventListener('click',function(){vscode.postMessage({type:'pullModel',model:name});});el.appendChild(b);});return;}m.models.forEach(function(name){var b=document.createElement('button');b.textContent=name;b.style.cssText='display:block;width:100%;text-align:left;margin:4px 0;padding:8px';b.addEventListener('click',function(){vscode.postMessage({type:'setModel',model:name});});el.appendChild(b);});}});</script></body></html>";
    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === "setModel") {
        await vscode.workspace.getConfiguration("localNest").update("model", String(msg.model), vscode.ConfigurationTarget.Global);
        await refreshStatus(false);
      } else if (msg.type === "downloadModel") {
        const model = String(msg.model || "").trim();
        if (model) { await downloadOllamaModel(model); }
      } else if (msg.type === "continueToChat") {
        const model = String(msg.model || "").trim() || getConfig().model;
        await vscode.workspace.getConfiguration("localNest").update("model", model, vscode.ConfigurationTarget.Global);
        try {
          const installed = await listModels(getConfig().host);
          if (installed.includes(model)) {
            view?.webview.postMessage({ type: "showChat" });
          } else {
            view?.webview.postMessage({ text: "Model " + model + " is not downloaded yet — press Download selected model, wait for the terminal pull to finish, then press Continue to chat again.", type: "setupStatus" });
          }
        } catch {
          view?.webview.postMessage({ text: "Ollama is not reachable at " + getConfig().host + " — start it with ollama serve, then try again.", type: "setupStatus" });
        }
      } else if (msg.type === "pullModel") {
        const model = String(msg.model || "").trim();
        if (model) { await downloadOllamaModel(model); }
      } else if (msg.type === "installOllama") {
        await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
        vscode.window.showInformationMessage("Ollama download opened in your browser. Install it, restart Antigravity, then pull a model.");
      } else if (msg.type === "openAgentChat") {
        await focusChatView();
        setTimeout(() => { view?.webview.postMessage({ mode: "agent", type: "setMode" }); }, 400);
      }
    });
    void refreshStatus(false);
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
        try {
          await handleChat(msg.mode as Mode, String(msg.text || ""), msg.autoApply === true, msg.major === true);
        } catch (err: any) {
          view?.webview.postMessage({ text: "LocalNest chat failed: " + String(err?.message || err) + "\nThis build uses free Ollama only — no API key. Start Ollama first (ollama serve), pull a free model (e.g. ollama pull qwen2.5-coder:7b), then press Refresh.", type: "assistant" });
          view?.webview.postMessage({ type: "streamDone" });
        }
      } else if (msg.type === "setMode") {
        view?.webview.postMessage({ mode: msg.mode, type: "setMode" });
      } else if (msg.type === "stop") {
        stopGeneration();
      } else if (msg.type === "exportChat") {
        if (!conversationHistory.length) { view?.webview.postMessage({ text: "Nothing to export yet — chat first.", type: "assistant" }); }
        else {
          const md = "# LocalNest chat export\n\n" + conversationHistory.map((m) => (m.role === "user" ? "## You\n\n" : "## LocalNest\n\n") + m.content).join("\n\n");
          const doc = await vscode.workspace.openTextDocument({ content: md, language: "markdown" });
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      } else if (msg.type === "newChat") {
        startNewSession();
      } else if (msg.type === "openSession") {
        openSession(String(msg.id || ""));
      } else if (msg.type === "deleteSession") {
        deleteSession(String(msg.id || ""));
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
      } else if (msg.type === "regenerate") {
        if (!lastChatRequest) { view?.webview.postMessage({ text: "Nothing to regenerate yet — ask something first.", type: "assistant" }); }
        else if (!await providerOnline(getConfig()) && lastChatRequest.mode !== "build") { view?.webview.postMessage({ text: "Ollama is offline, so I cannot regenerate this answer yet. Start Ollama and press Regenerate again.", type: "assistant" }); }
        else {
          // Drop the last (user + assistant) turn so the regenerated turn
          // does not duplicate the failed one in history.
          if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === "assistant") { conversationHistory = conversationHistory.slice(0, -1); }
          if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === "user") { conversationHistory = conversationHistory.slice(0, -1); }
          saveCurrentSession();
          view?.webview.postMessage({ messages: displayMessages(conversationHistory), type: "restoreHistory" });
          await handleChat(lastChatRequest.mode, lastChatRequest.text, lastChatRequest.autoApply, lastChatRequest.majorFlag);
        }
      } else if (msg.type === "renameSession") {
        const s = chatSessions.find((x) => x.id === String(msg.id));
        if (!s) { view?.webview.postMessage({ text: "That past chat is gone.", type: "assistant" }); }
        else {
          const name = await vscode.window.showInputBox({ prompt: "Rename this past chat", value: s.title, validateInput: (v) => v.trim() ? undefined : "Give the chat a name." });
          if (name && name.trim()) { s.title = name.trim().slice(0, 80); s.updatedAt = Date.now(); saveSessions(); postSessions(); }
        }
      } else if (msg.type === "approveFile") {
        const result = await applyFile(String(msg.path));
        view?.webview.postMessage({ text: result, type: "assistant" });
        if (result.startsWith("Wrote ")) { view?.webview.postMessage({ path: String(msg.path), type: "fileApproved" }); }
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
            if (file.exists && file.original !== null) {
              // Existing file: show a real diff (old vs proposed), not just
              // the full new file — that is what review actually needs.
              const root = currentProposalRoot || workspaceRootUri();
              const origUri = file.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file.path) ? vscode.Uri.file(file.path) : (root ? vscode.Uri.joinPath(root, file.path) : vscode.Uri.file(file.path));
              const tmpUri = vscode.Uri.file(require("os").tmpdir() + "/" + "localnest-review-" + file.path.replace(/[^A-Za-z0-9._-]/g, "_"));
              await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(file.content, "utf8"));
              await vscode.commands.executeCommand("vscode.diff", origUri, tmpUri, "Review: " + file.path + " (proposed →)");
              view?.webview.postMessage({ text: "Opened a diff for " + file.path + " — left is the current file, right is the proposal. Approve it only if the changes look right; otherwise Discard proposal.", type: "assistant" });
            } else {
              const doc = await vscode.workspace.openTextDocument({ content: file.content, language: ext === "js" ? "javascript" : ext === "ts" ? "typescript" : ext });
              await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
              view?.webview.postMessage({ text: "Opened proposed " + file.path + " beside the editor for review. Approve it only if it looks right; otherwise Discard proposal.", type: "assistant" });
            }
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
        view?.webview.postMessage({ type: "proposalDone" });
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
      } else if (msg.type === "diagnose") {
        await runDiagnose(false);
      } else if (msg.type === "testModel") {
        const testCfg = getConfig();
        view?.webview.postMessage({ text: "Testing model `" + testCfg.model + "` at " + testCfg.host + " — asking it for one short sentence…", type: "assistant" });
        try {
          const reply = await chatOnce(testCfg, [{ content: "Reply with exactly one short sentence: LocalNest test OK.", role: "user" }]);
          view?.webview.postMessage({ text: reply ? "Test OK — model `" + testCfg.model + "` answered: " + reply : "Test failed — model `" + testCfg.model + "` returned an empty reply. Try a different pulled model.", type: "assistant" });
        } catch (err: any) {
          view?.webview.postMessage({ text: "Test failed — model `" + testCfg.model + "` did not answer: " + String(err?.message || err) + "\nCheck: Ollama is running (ollama serve), the model is pulled (ollama list), and Model in this panel matches a pulled model.", type: "assistant" });
        }
      } else if (msg.type === "downloadModel") {
        const model = String(msg.model || "").trim();
        if (model) { await downloadOllamaModel(model); }
      } else if (msg.type === "continueToChat") {
        const model = String(msg.model || "").trim() || getConfig().model;
        await vscode.workspace.getConfiguration("localNest").update("model", model, vscode.ConfigurationTarget.Global);
        try {
          const installed = await listModels(getConfig().host);
          if (installed.includes(model)) {
            view?.webview.postMessage({ type: "showChat" });
          } else {
            view?.webview.postMessage({ text: "Model " + model + " is not downloaded yet — press Download selected model, wait for the terminal pull to finish, then press Continue to chat again.", type: "setupStatus" });
          }
        } catch {
          view?.webview.postMessage({ text: "Ollama is not reachable at " + getConfig().host + " — install Ollama, start it with ollama serve, then try again.", type: "setupStatus" });
        }
      } else if (msg.type === "installOllama") {
        await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
        view?.webview.postMessage({ text: "Ollama download opened in your browser. Install it, restart Antigravity, then download a model.", type: "setupStatus" });
      } else if (msg.type === "pullModel") {
        const model = String(msg.model || "").trim();
        if (model) { await downloadOllamaModel(model); }
      } else if (msg.type === "setModel") {
        const cfg = vscode.workspace.getConfiguration("localNest");
        await cfg.update("model", String(msg.model), vscode.ConfigurationTarget.Global);
        // Remember the pick BEFORE refreshStatus, so refresh does not snap it back.
        try {
          const installedNow = await listModels(getConfig().host);
          userPickedDownloadModel = installedNow.includes(String(msg.model)) ? null : String(msg.model);
        } catch { userPickedDownloadModel = String(msg.model); }
        view?.webview.postMessage({ text: "Model set to " + String(msg.model) + (userPickedDownloadModel ? " — not downloaded yet, press Download selected model." : ".") , type: "assistant" });
        view?.webview.postMessage({ text: "Model set to " + String(msg.model) + (userPickedDownloadModel ? " — not downloaded yet, press Download selected model." : ".") , type: "setupStatus" });
        await refreshStatus(false);
        // If the user picked a model that is already on this system, open
        // chat straight away — no extra Continue press needed.
        try {
          const installed = await listModels(getConfig().host);
          if (installed.includes(String(msg.model))) { view?.webview.postMessage({ type: "showChat" }); }
        } catch { /* stay on setup; refresh already showed the status */ }
      }
    });
    void (async () => {
      const res = await runSystemCheck();
      await refreshStatus(false);
      postSessions();
      postContext("ask");
      if (conversationHistory.length) {
        view?.webview.postMessage({ messages: displayMessages(conversationHistory), type: "restoreHistory" });
      }
      const rules0 = await loadProjectRules();
      if (rules0) { view?.webview.postMessage({ text: "Project rules loaded from " + rules0.file + " — they will be followed for every answer in this project.", type: "assistant" }); }
      const custom0 = await loadCustomSkills();
      if (Object.keys(custom0).length) { view?.webview.postMessage({ text: "Your skills loaded: " + Object.keys(custom0).map((n) => "/" + n).join(", ") + " (from .localnest/skills/). Type /skills to see all skills.", type: "assistant" }); }
      if (res.models.length) {
        view?.webview.postMessage({ type: "showChat" });
      } else if (!res.installed) {
        view?.webview.postMessage({ text: "System check: Ollama is NOT installed on this system, so LocalNest cannot answer yet. Press Install Ollama below, install it from ollama.com/download, restart Antigravity, then download a model.", type: "setupStatus" });
      } else if (!res.online) {
        view?.webview.postMessage({ text: "System check: Ollama is installed but not running. Start it with `ollama serve`, then press Refresh.", type: "setupStatus" });
      } else {
        view?.webview.postMessage({ text: "System check: Ollama is installed, but no model is downloaded yet. Pick a model below and press Download selected model, then chat will open.", type: "setupStatus" });
      }
    })();
  }

  private html(): string {
    return [
      "<!DOCTYPE html><html><head><meta charset='utf-8'>",
      "<style>",
      "body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);margin:0;padding:0;font-size:13px;display:flex;flex-direction:column;height:100vh;overflow:hidden} #chatStage{overflow-y:auto;flex-shrink:1}",
      ".topbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)} .topbar .pill{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:12px;padding:3px 10px;font-weight:700} .topbar .spacer{flex:1} .topbar button{background:none;border:0;color:var(--vscode-foreground);cursor:pointer;font-size:14px}",
      ".head{display:flex;align-items:center;gap:10px;padding:12px 12px 4px} .head .logo{font-size:22px} .head b{font-size:16px}",
      ".autorow{display:flex;align-items:center;gap:8px;padding:6px 12px} .autorow .local{background:#0e7490;color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}",
      ".modes{display:flex;gap:4px;padding:6px 12px;flex-wrap:wrap} .modes button{flex:1;padding:7px 4px;border-radius:8px;border:0;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer} .modes button.on{background:var(--vscode-button-secondaryBackground);color:var(--vscode-foreground);font-weight:700} #fastBtn{flex:0 0 auto;padding:7px 10px}",
      ".intro{margin:8px 12px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-editor-background)} .intro b{display:block} .intro span{color:var(--vscode-descriptionForeground)}",
      "#setup{margin:8px 12px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:12px} select,input,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:8px;padding:8px}",
      "button.primary{width:100%;padding:9px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:8px;cursor:pointer;margin-top:8px}",
      "button.small{padding:5px 8px;margin:4px 4px 0 0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border);border-radius:6px;cursor:pointer}",
      "#chat{flex:1 1 auto;min-height:120px;overflow-y:auto;padding:4px 12px} .msg{white-space:pre-wrap;word-break:break-word;border:1px solid var(--vscode-panel-border);border-radius:12px;padding:10px;margin:8px 0;max-width:92%} .msg.user{margin-left:auto;background:#0e7490;color:#fff;border-color:#0e7490} .msg.ai{margin-right:auto} .msg.error{border-left:4px solid #ef4444} .msg.error b{color:#f87171}",
      "#proposal{border:2px solid var(--vscode-focusBorder);border-radius:10px;padding:10px;margin:8px 12px;display:none;max-height:55vh;overflow-y:auto;flex-shrink:0;position:relative;z-index:1;background:var(--vscode-editor-background)} code{font-family:var(--vscode-editor-font-family)}",
      ".foot{display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:12px;flex-shrink:0;position:relative;z-index:2;background:var(--vscode-sideBar-background)}",
      ".chips{display:flex;gap:6px;flex-wrap:wrap;padding:4px 12px;flex-shrink:0;position:relative;z-index:2;background:var(--vscode-sideBar-background)} .chips button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-foreground);border:0;border-radius:12px;padding:4px 10px;cursor:pointer;font-size:12px}",
      ".composer{padding:8px 12px 12px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0;position:relative;z-index:2;background:var(--vscode-sideBar-background)} textarea{min-height:70px;resize:vertical} .sendrow{display:flex;justify-content:flex-end;margin-top:6px} .sendrow button{background:#0e7490;color:#fff;border:0;border-radius:8px;padding:8px 18px;cursor:pointer}",
      "</style></head><body>",
      "<div class='topbar'><span>Chat</span><span class='pill'>Vyntra</span><span class='spacer'></span><button id='refresh' title='Refresh'>↻</button><button id='newChatTop' title='New chat'>+</button></div>",
      "<div style='display:flex;gap:6px;padding:6px 12px 0'><button class='small' id='toggleSessions' style='margin:0'>Past chats ▾</button><button class='small' id='toggleCtx' style='margin:0'>Context used (tokens) ▾</button></div>",
      "<div id='topSessions' style='margin:8px 12px;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:10px'><b>Past chats</b><input id='sessionSearch' placeholder='Search past chats…' style='margin-top:6px;padding:6px'><div id='sessionList' style='margin-top:6px;color:var(--vscode-descriptionForeground)'>No past chats yet.</div></div>",
      "<div id='topCtx' style='margin:0 12px 8px'><div style='display:flex;justify-content:space-between;font-size:12px;color:var(--vscode-descriptionForeground)'><span>Context used</span><span id='ctxText'>0 tokens</span></div><div style='height:8px;border-radius:4px;background:var(--vscode-panel-border);overflow:hidden;margin-top:4px'><div id='ctxFill' style='height:100%;width:0%;background:#2dd4bf'></div></div><div id='ctxSummary' style='font-size:12px;color:var(--vscode-descriptionForeground);margin-top:4px'></div></div>",
      "<div class='head'><span class='logo'>🪹</span><div><b>Vyntra</b><br><span style='color:var(--vscode-descriptionForeground)'>Local AI coding agent</span></div></div>",
      "<div class='autorow'><span>Auto</span><span class='local'>LOCAL</span><span>▾</span><span id='host' style='color:var(--vscode-descriptionForeground)'>checking…</span></div>",
      "<div class='modes'><button data-mode='ask' class='on'>Ask</button><button data-mode='plan'>Plan</button><button data-mode='agent'>Agent</button><button data-mode='build'>Build</button><button id='fastBtn' title='Fast mode: smaller context, faster answers'>Fast</button></div>",
      "<div class='intro'><b>🪹 Vyntra</b><span>Local AI coding agent · chat, plans, and reviewable changes.<br>Skills: /review /test /fix /explain /docs /refactor /commit /security /summarize /autofix /qa — type /skills for the list.</span></div>",
      "<div id='setup'>",
      "<p><b>Step 1 — Pick a model</b><br>These are Ollama models. Pick one in the single list below, download it, then continue to chat.</p><p style='font-size:12px;color:var(--vscode-descriptionForeground)'>Speed tip: on a normal laptop without a GPU, a 3B model (llama3.2:3b, phi3:mini) answers much faster than a 7B model. The first answer after a download is always slowest — the model has to load into memory first.</p>",
      "<label>Available Ollama models</label><select id='model'><option>qwen2.5-coder:7b</option></select>",
      "<div id='setupStatus' style='margin-top:8px;color:var(--vscode-descriptionForeground)'></div>",
      "<button class='primary' id='downloadModel'>Download selected model</button>",
      "<button class='primary' id='continueChat'>Continue to chat →</button>",
      "<button class='small' id='installOllama'>Install Ollama (if terminal says ollama is not recognized)</button>",
      "</div>",
      "<div id='chatStage' style='display:none;flex:1;flex-direction:column;min-height:0'>",
      "<div style='padding:0 12px'><button class='small' id='changeModel'>← Change model</button><button class='small' id='stopBtn'>Stop generation</button><button class='small' id='newChat'>New chat</button><button class='small' id='regenerateBtn'>Regenerate</button><button class='small' id='copyLastBtn'>Copy last answer</button><button class='small' id='exportChat'>Export chat</button><button class='small' id='undo'>Undo last apply</button></div>",
      "<button class='small' id='buildPlan' style='display:none;margin:8px 12px'>Build this plan (Agent mode)</button>",
      "<div id='proposal'><b>Proposal — nothing written yet</b><div id='files'></div><div id='cmds'></div>",
      "<button class='primary' id='approveAll'>Approve all files</button>",
      "<button class='small' id='runCmds'>Run approved commands</button><button class='small' id='reject'>Discard proposal</button></div>",
      "<div id='chat'></div>",
      "</div>",
      "<div class='foot'><span>⎇ Changes <span id='changesCount'>0</span> &nbsp; &gt;_ Terminal <span id='terminalCount'>0</span></span><span id='readyText'>Ready</span></div>",
      "<div class='chips'><button data-chip='@file'>@file</button><button data-chip='@selection'>@selection</button><button data-chip='@terminal'>@terminal</button><button data-chip='@diagnostics'>@diagnostics</button><button data-chip='@git'>@git</button></div>",
      "<div class='composer'><textarea id='input' placeholder='Type a task, question, or / for commands…'></textarea><div class='sendrow'><button id='send'>Send</button></div></div>",
      "<div style='display:none'><select id='target'><option value='workspace'>This project folder</option></select><input id='customPath'><input type='checkbox' id='fullAccess'><input type='checkbox' id='autoApply'><input type='checkbox' id='majorProject'><input type='checkbox' id='agenticLoop' checked><input type='checkbox' id='lowBandwidth'><input id='temperature' type='number' value='0.2'></div>",
      "<script>",
      "var vscode = acquireVsCodeApi(); var mode = 'ask'; var currentBubble = null; var lastPlan = ''; var approvedCount = 0;",
      "function addMsg(text, cls){ var d=document.createElement('div'); d.className='msg '+cls; if(cls==='ai' && /No local LLM|failed|not installed|offline/i.test(text)){ d.className+=' error'; if(text.indexOf('Task Failed')<0){ var b=document.createElement('b'); b.textContent='Task Failed'; d.appendChild(b); d.appendChild(document.createElement('br')); } } d.appendChild(document.createTextNode(text)); document.getElementById('chat').appendChild(d); var c=document.getElementById('chat'); c.scrollTop=c.scrollHeight; return d; }",
      "function targetInfo(){ return {target: document.getElementById('target').value, customPath: document.getElementById('customPath').value, fullAccess: document.getElementById('fullAccess').checked}; }",
      "function send(){ var t=document.getElementById('input').value.trim(); if(!t) return; document.getElementById('input').value=''; if(document.getElementById('chatStage').style.display==='none'){ document.getElementById('setup').style.display='none'; document.getElementById('chatStage').style.display='flex'; } addMsg(t,'user'); currentBubble = addMsg('Thinking…','ai'); var ti=targetInfo(); vscode.postMessage({type:'chat', mode:mode, text:t, autoApply: document.getElementById('autoApply').checked, major: document.getElementById('majorProject').checked, agenticLoop: document.getElementById('agenticLoop').checked, lowBandwidth: document.getElementById('lowBandwidth').checked, provider: 'ollama', target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); }",
      "document.getElementById('stopBtn').addEventListener('click', function(){ vscode.postMessage({type:'stop'}); });",
      "document.getElementById('newChat').addEventListener('click', function(){ document.getElementById('chat').innerHTML=''; vscode.postMessage({type:'newChat'}); });",
      "document.getElementById('exportChat').addEventListener('click', function(){ vscode.postMessage({type:'exportChat'}); });",
      "document.getElementById('regenerateBtn').addEventListener('click', function(){ vscode.postMessage({type:'regenerate'}); });",
      "document.getElementById('copyLastBtn').addEventListener('click', function(){ var msgs=document.querySelectorAll('#chat .msg.ai'); var last=null; for(var i=msgs.length-1;i>=0;i--){ var cand=msgs[i].textContent; if(cand && cand.indexOf('— ')!==0 && cand.indexOf('Context note')!==0 && cand.indexOf('Step ')!==0){ last=msgs[i]; break; } } if(!last){ return; } var txt=last.textContent; if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt); } else { var ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(e){} ta.remove(); } document.getElementById('copyLastBtn').textContent='Copied ✓'; setTimeout(function(){ document.getElementById('copyLastBtn').textContent='Copy last answer'; }, 1500); });",
      "document.getElementById('sessionSearch').addEventListener('input', function(){ if(window._lastSessions){ renderSessions(window._lastSessions); } });",
      "document.getElementById('newChatTop').addEventListener('click', function(){ document.getElementById('chat').innerHTML=''; vscode.postMessage({type:'newChat'}); });",
      "document.getElementById('undo').addEventListener('click', function(){ vscode.postMessage({type:'undo'}); });",
      "document.getElementById('fastBtn').addEventListener('click', function(e){ var cb=document.getElementById('lowBandwidth'); cb.checked=!cb.checked; e.target.classList.toggle('on', cb.checked); });",
      "document.querySelectorAll('.chips button').forEach(function(b){ b.addEventListener('click', function(){ var inp=document.getElementById('input'); inp.value += (inp.value ? ' ' : '') + b.getAttribute('data-chip') + ' '; inp.focus(); }); });",
      "document.getElementById('downloadModel').addEventListener('click', function(){ var m=document.getElementById('model').value; vscode.postMessage({type:'downloadModel', model:m}); });",
      "document.getElementById('continueChat').addEventListener('click', function(){ var m=document.getElementById('model').value; vscode.postMessage({type:'continueToChat', model:m}); });",
      "document.getElementById('installOllama').addEventListener('click', function(){ vscode.postMessage({type:'installOllama'}); });",
      "document.getElementById('changeModel').addEventListener('click', function(){ document.getElementById('chatStage').style.display='none'; document.getElementById('setup').style.display='block'; vscode.postMessage({type:'refresh'}); });",
      "document.getElementById('model').addEventListener('change', function(e){ vscode.postMessage({type:'setModel', model:e.target.value}); });",
      "document.getElementById('temperature').addEventListener('change', function(e){ vscode.postMessage({type:'temperature', value:e.target.value}); });",
      "document.getElementById('send').addEventListener('click', send);",
      "document.getElementById('buildPlan').addEventListener('click', function(){ if(!lastPlan) return; addMsg('Build this plan','user'); currentBubble = addMsg('Thinking…','ai'); var ti=targetInfo(); mode='agent'; document.querySelectorAll('.modes button').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-mode')==='agent'); }); vscode.postMessage({type:'chat', mode:'agent', text:'Build this plan exactly:\\n'+lastPlan, autoApply: document.getElementById('autoApply').checked, major: document.getElementById('majorProject').checked, agenticLoop: document.getElementById('agenticLoop').checked, lowBandwidth: document.getElementById('lowBandwidth').checked, provider: 'ollama', target: ti.target, customPath: ti.customPath, fullAccess: ti.fullAccess}); document.getElementById('buildPlan').style.display='none'; });",
      "document.getElementById('input').addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); } });",
      "document.querySelectorAll('.modes button[data-mode]').forEach(function(b){ b.addEventListener('click', function(){ mode=b.getAttribute('data-mode'); document.querySelectorAll('.modes button[data-mode]').forEach(function(x){ x.classList.toggle('on', x===b); }); }); });",
      "document.getElementById('refresh').addEventListener('click', function(){ vscode.postMessage({type:'refresh'}); });",
      "document.getElementById('toggleSessions').addEventListener('click', function(){ var b=document.getElementById('topSessions'); var hidden=b.style.display==='none'; b.style.display=hidden?'block':'none'; document.getElementById('toggleSessions').textContent=hidden?'Past chats ▾':'Past chats ▸'; });",
      "document.getElementById('toggleCtx').addEventListener('click', function(){ var b=document.getElementById('topCtx'); var hidden=b.style.display==='none'; b.style.display=hidden?'block':'none'; document.getElementById('toggleCtx').textContent=hidden?'Context used (tokens) ▾':'Context used (tokens) ▸'; });",
      "document.getElementById('approveAll').addEventListener('click', function(){ approvedCount++; document.getElementById('changesCount').textContent=approvedCount; document.getElementById('approveAll').disabled=true; document.getElementById('approveAll').textContent='Approving…'; vscode.postMessage({type:'approveAll'}); });",
      "document.getElementById('reject').addEventListener('click', function(){ document.getElementById('proposal').style.display='none'; vscode.postMessage({type:'rejectProposal'}); });",
      "document.getElementById('runCmds').addEventListener('click', function(){ vscode.postMessage({type:'runCommands'}); });",
      "function renderSessions(sessions){ var list=document.getElementById('sessionList'); var q=(document.getElementById('sessionSearch').value||'').toLowerCase(); list.innerHTML=''; var shown=sessions.filter(function(s){ return !q || s.title.toLowerCase().indexOf(q)>=0; }); if(!shown.length){ list.textContent=sessions.length?'No past chats match that search.':'No past chats yet.'; return; } shown.forEach(function(s){ var row=document.createElement('div'); row.style.cssText='display:flex;justify-content:space-between;align-items:center;margin:4px 0'; var b=document.createElement('button'); b.className='small'; b.style.cssText='flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; b.textContent=s.title+' ('+s.count+')'; b.addEventListener('click', function(){ vscode.postMessage({type:'openSession', id:s.id}); }); row.appendChild(b); var r=document.createElement('button'); r.className='small'; r.textContent='✎'; r.title='Rename this chat'; r.addEventListener('click', function(){ vscode.postMessage({type:'renameSession', id:s.id}); }); row.appendChild(r); var d=document.createElement('button'); d.className='small'; d.textContent='✕'; d.title='Delete this chat'; d.addEventListener('click', function(){ vscode.postMessage({type:'deleteSession', id:s.id}); }); row.appendChild(d); list.appendChild(row); }); }",
      "window.addEventListener('message', function(ev){ var m=ev.data;",
      " if(m.type==='status'){ document.getElementById('host').textContent = m.host + (m.online ? ' — ' + m.models.length + ' model(s)' : ' — start Ollama to go live'); document.getElementById('readyText').textContent = m.online ? 'Ready' : 'Ollama offline'; var sel=document.getElementById('model'); var cur=sel.value; var installed=m.models||[]; var popular=['qwen2.5-coder:7b','llama3.2:3b','mistral:7b','phi3:mini','codellama:7b','llama3.1:8b']; var all=installed.slice(); popular.forEach(function(n){ if(all.indexOf(n)<0) all.push(n); }); sel.innerHTML=''; all.forEach(function(name){ var o=document.createElement('option'); o.value=name; o.textContent=installed.indexOf(name)>=0 ? name : name+' (download)'; if(name===(m.model||cur)) o.selected=true; sel.appendChild(o); }); }",
      " else if(m.type==='stream'){ if(!currentBubble) currentBubble=addMsg('','ai'); if(currentBubble.textContent==='Thinking…') currentBubble.textContent=''; currentBubble.textContent += m.text; }",
      " else if(m.type==='assistant'){ if(currentBubble && (currentBubble.textContent==='Thinking…' || currentBubble.textContent==='')){ currentBubble.remove(); } currentBubble=null; addMsg(m.text,'ai'); }",
      " else if(m.type==='streamDone'){ if(currentBubble && currentBubble.textContent==='Thinking…'){ currentBubble.remove(); } currentBubble=null; }",
      " else if(m.type==='sessions'){ window._lastSessions=m.sessions||[]; renderSessions(window._lastSessions); }",
      " else if(m.type==='context'){ var fill=document.getElementById('ctxFill'); var txt=document.getElementById('ctxText'); var sum=document.getElementById('ctxSummary'); if(fill){ fill.style.width=m.pct+'%'; fill.style.background = m.pct>=90 ? '#ef4444' : (m.pct>=70 ? '#f59e0b' : '#2dd4bf'); } if(txt){ txt.textContent=m.tokens+' / '+m.window+' tokens ('+m.pct+'%)'; } if(sum){ sum.textContent = m.summaryCount ? m.summaryCount+' older message(s) summarised and kept in context.' : ''; } }",
      " else if(m.type==='restoreHistory'){ document.getElementById('setup').style.display='none'; document.getElementById('chatStage').style.display='flex'; document.getElementById('chat').innerHTML=''; (m.messages||[]).forEach(function(msg){ addMsg(msg.content, msg.role==='user' ? 'user' : 'ai'); }); currentBubble=null; }",
      " else if(m.type==='setupStatus'){ document.getElementById('setupStatus').textContent=m.text; } else if(m.type==='showChat'){ document.getElementById('setup').style.display='none'; document.getElementById('chatStage').style.display='flex'; } else if(m.type==='planReady'){ lastPlan=m.text; document.getElementById('buildPlan').style.display='block'; }",
      " else if(m.type==='prefill'){ document.getElementById('input').value=m.text; mode=m.mode||'ask'; document.querySelectorAll('.modes button[data-mode]').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-mode')===mode); }); send(); }",
      " else if(m.type==='setMode'){ mode=m.mode; document.querySelectorAll('.modes button[data-mode]').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-mode')===mode); }); }",
      " else if(m.type==='fileApproved'){ var rows=document.querySelectorAll('#files button'); rows.forEach(function(btn){ if((btn.textContent==='Approve this file' || btn.textContent==='Approving…') && btn.parentNode && btn.parentNode.textContent.indexOf(m.path)>=0){ btn.disabled=true; btn.textContent='Approved ✓'; } }); }",
      " else if(m.type==='proposalDone'){ document.getElementById('proposal').style.display='none'; }",
      " else if(m.type==='proposal'){ var box=document.getElementById('proposal'); box.style.display='block'; var aa=document.getElementById('approveAll'); if(aa){ aa.disabled=false; aa.textContent='Approve all files'; } var files=document.getElementById('files'); files.innerHTML=''; m.proposal.files.forEach(function(f){ var row=document.createElement('div'); row.textContent=(f.exists?'Update: ':'New file: ')+f.path+' '; var vb=document.createElement('button'); vb.className='small'; vb.textContent='View (review)'; vb.addEventListener('click', function(){ vscode.postMessage({type:'viewProposalFile', path:f.path}); }); row.appendChild(vb); var b=document.createElement('button'); b.className='small'; b.textContent='Approve this file'; b.addEventListener('click', function(){ approvedCount++; document.getElementById('changesCount').textContent=approvedCount; b.disabled=true; b.textContent='Approving…'; vscode.postMessage({type:'approveFile', path:f.path}); }); row.appendChild(b); files.appendChild(row); if(f.preview){ var pre=document.createElement('pre'); pre.style.cssText='white-space:pre-wrap;max-height:200px;overflow:auto;background:#111;color:#ddd;padding:6px;font-size:11px'; pre.textContent=f.preview; files.appendChild(pre); } }); var cmds=document.getElementById('cmds'); cmds.textContent = m.proposal.commands.length ? 'Commands (run only on approval): '+m.proposal.commands.join('  •  ') : 'No commands proposed.'; }",
      "});",
      "</script></body></html>"
    ].join("");
  }

}
