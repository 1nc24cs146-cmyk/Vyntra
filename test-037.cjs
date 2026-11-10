// Tests for 0.9.37 inline (ghost-text) code completion.
// Plain Node, no VS Code host: the vscode module is stubbed via Module._load
// and global fetch is stubbed per test. Run: node test-037.cjs
const Module = require("module");
const assert = require("assert");

// --- Fake vscode -----------------------------------------------------------
const notifications = [];
const registrations = [];
let configValues = {};
class FakeRange {
  constructor(start, end) { this.start = start; this.end = end; }
}
class FakeInlineCompletionItem {
  constructor(text, range) { this.text = text; this.range = range; }
}
const fakeVscode = {
  InlineCompletionItem: FakeInlineCompletionItem,
  Range: FakeRange,
  languages: {
    registerInlineCompletionItemProvider(selector, provider) {
      registrations.push({ provider, selector });
      return { dispose() {} };
    }
  },
  window: {
    showErrorMessage: (...a) => { notifications.push(["error", ...a]); },
    showWarningMessage: (...a) => { notifications.push(["warning", ...a]); },
    showInformationMessage: (...a) => { notifications.push(["info", ...a]); }
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => (key in configValues ? configValues[key] : def)
    })
  }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") { return fakeVscode; }
  return origLoad.call(this, request, ...rest);
};

const ic = require("./out/inlineCompletion.js");
const { LocalNestInlineCompletionProvider, registerInlineCompletion } = require("./out/inlineCompletionProvider.js");

// --- Fakes for documents ---------------------------------------------------
function fakeDocument(text, languageId = "python") {
  const lines = text.split("\n");
  return {
    getText: () => text,
    languageId,
    offsetAt: (pos) => {
      let off = 0;
      for (let i = 0; i < pos.line; i++) { off += lines[i].length + 1; }
      return off + pos.character;
    }
  };
}
const fakeToken = { onCancellationRequested: () => ({ dispose() {} }) };
const fakeContext = { subscriptions: [] };

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL " + name + " — " + (err && err.message));
  }
}
function setFetch(stub) {
  globalThis.fetch = stub;
  return stub;
}
let fetchCalls = [];
function fetchReturning(responseText, ok = true) {
  fetchCalls = [];
  return setFetch(async (url, init) => {
    fetchCalls.push({ init, url });
    return { json: async () => ({ response: responseText }), ok, status: ok ? 200 : 500 };
  });
}
function fetchThrowing() {
  fetchCalls = [];
  return setFetch(async (url, init) => {
    fetchCalls.push({ init, url });
    throw new Error("ECONNREFUSED");
  });
}

(async () => {
  console.log("0.9.37 inline completion tests");

  // 1. Provider registration path
  await test("registerInlineCompletion registers a provider for code languages", () => {
    registrations.length = 0;
    fakeContext.subscriptions.length = 0;
    const d = registerInlineCompletion(fakeContext);
    assert.ok(d, "expected a disposable");
    assert.strictEqual(registrations.length, 1);
    const langs = registrations[0].selector.map((s) => s.language);
    for (const lang of ["python", "javascript", "typescript", "go", "rust"]) {
      assert.ok(langs.includes(lang), "selector missing " + lang);
    }
    assert.strictEqual(fakeContext.subscriptions.length, 1, "disposable pushed to subscriptions");
    assert.ok(registrations[0].provider instanceof LocalNestInlineCompletionProvider);
  });

  // 2. Setting defaults
  await test("setting defaults: enabled=true, delayMs=300, model=qwen2.5-coder:7b", () => {
    configValues = {};
    const cfg = ic.readInlineCompletionConfig(fakeVscode.workspace.getConfiguration());
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.delayMs, 300);
    assert.strictEqual(cfg.model, "qwen2.5-coder:7b");
    assert.strictEqual(cfg.host, "http://localhost:11434");
  });
  await test("delayMs is clamped (negative->0, huge->5000, non-number->300)", () => {
    configValues = { "inlineCompletion.delayMs": -50 };
    assert.strictEqual(ic.readInlineCompletionConfig(fakeVscode.workspace.getConfiguration()).delayMs, 0);
    configValues = { "inlineCompletion.delayMs": 99999 };
    assert.strictEqual(ic.readInlineCompletionConfig(fakeVscode.workspace.getConfiguration()).delayMs, 5000);
    configValues = { "inlineCompletion.delayMs": "fast" };
    assert.strictEqual(ic.readInlineCompletionConfig(fakeVscode.workspace.getConfiguration()).delayMs, 300);
  });
  await test("configured model/host are respected", () => {
    configValues = { model: "deepseek-coder:6.7b", ollamaHost: "http://192.168.1.5:11434/" };
    const cfg = ic.readInlineCompletionConfig(fakeVscode.workspace.getConfiguration());
    assert.strictEqual(cfg.model, "deepseek-coder:6.7b");
    assert.strictEqual(cfg.host, "http://192.168.1.5:11434/");
  });

  // 3. Prompt includes prefix/suffix context
  await test("FIM prompt for qwen2.5-coder:7b includes prefix and suffix", () => {
    const p = ic.buildCompletionPrompt("def add(a, b):\n    ", "\n\nprint(add(1, 2))", "python", "qwen2.5-coder:7b");
    assert.ok(p.includes("<|fim_prefix|>"), "missing fim_prefix marker");
    assert.ok(p.includes("def add(a, b):"), "prefix missing from prompt");
    assert.ok(p.includes("print(add(1, 2))"), "suffix missing from prompt");
    assert.ok(p.endsWith("<|fim_middle|>"), "prompt must end at fim_middle");
  });
  await test("plain prompt for non-FIM model still includes prefix and suffix", () => {
    const p = ic.buildCompletionPrompt("const x = ", ";\nconsole.log(x);", "javascript", "llama3:8b");
    assert.ok(!p.includes("<|fim_prefix|>"), "non-FIM model must not get FIM tokens");
    assert.ok(p.includes("const x = "), "prefix missing from prompt");
    assert.ok(p.includes("console.log(x);"), "suffix missing from prompt");
  });
  await test("supportsFim detects known code models only", () => {
    assert.strictEqual(ic.supportsFim("qwen2.5-coder:7b"), true);
    assert.strictEqual(ic.supportsFim("codellama:13b"), true);
    assert.strictEqual(ic.supportsFim("deepseek-coder:6.7b"), true);
    assert.strictEqual(ic.supportsFim("llama3:8b"), false);
    assert.strictEqual(ic.supportsFim(""), false);
  });

  // 4. cleanCompletion
  await test("cleanCompletion strips fences and drops prefix echo", () => {
    const out = ic.cleanCompletion("```python\n    return x + 1\n```", "def f(x):\n    ");
    assert.strictEqual(out, "return x + 1");
    const echoed = ic.cleanCompletion("    return x\n    return x + 1", "def f(x):\n    return x");
    assert.strictEqual(echoed, "return x + 1");
    assert.strictEqual(ic.cleanCompletion("", "x"), "");
    assert.strictEqual(ic.cleanCompletion("   \n  ", "x"), "");
  });
  await test("cleanCompletion caps lines and chars", () => {
    const long = Array.from({ length: 30 }, (_, i) => "line" + i).join("\n");
    const out = ic.cleanCompletion(long, "");
    assert.ok(out.split("\n").length <= ic.INLINE_COMPLETION_MAX_LINES);
    assert.ok(out.length <= ic.INLINE_COMPLETION_MAX_CHARS);
  });

  // 5. fetchInlineCompletion — happy path, prompt goes to Ollama
  await test("fetchInlineCompletion posts prefix/suffix prompt to /api/generate", async () => {
    fetchReturning("    return a + b");
    const prefix = "def add(a, b):\n    ";
    const suffix = "\n\nprint(add(1, 2))";
    const prompt = ic.buildCompletionPrompt(prefix, suffix, "python", "qwen2.5-coder:7b");
    const res = await ic.fetchInlineCompletion("http://localhost:11434", "qwen2.5-coder:7b", prompt, prefix);
    assert.strictEqual(res, "return a + b");
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith("/api/generate"));
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.strictEqual(body.model, "qwen2.5-coder:7b");
    assert.strictEqual(body.prompt, prompt);
    assert.strictEqual(body.stream, false);
  });

  // 6. Silent behaviour when Ollama is unreachable
  await test("fetchInlineCompletion returns null when fetch throws", async () => {
    fetchThrowing();
    const res = await ic.fetchInlineCompletion("http://localhost:11434", "qwen2.5-coder:7b", "prompt", "prefix");
    assert.strictEqual(res, null);
  });
  await test("fetchInlineCompletion returns null on non-OK status", async () => {
    fetchReturning("x", false);
    const res = await ic.fetchInlineCompletion("http://localhost:11434", "qwen2.5-coder:7b", "prompt", "prefix");
    assert.strictEqual(res, null);
  });
  await test("provider returns [] silently when Ollama is unreachable (no notifications)", async () => {
    configValues = { "inlineCompletion.delayMs": 5 };
    notifications.length = 0;
    fetchThrowing();
    const provider = new LocalNestInlineCompletionProvider();
    const doc = fakeDocument("def add(a, b):\n    ");
    const items = await provider.provideInlineCompletionItems(doc, { character: 4, line: 1 }, {}, fakeToken);
    assert.deepStrictEqual(items, []);
    assert.strictEqual(notifications.length, 0, "no popups allowed, got: " + JSON.stringify(notifications));
  });

  // 7. Debounce behaviour
  await test("debounce: two rapid keystrokes fire only one Ollama call (the latest)", async () => {
    configValues = { "inlineCompletion.delayMs": 60 };
    fetchReturning("    return a + b");
    const provider = new LocalNestInlineCompletionProvider();
    const docA = fakeDocument("def add(a, b):\n    ");
    const docB = fakeDocument("def add(a, b):\n    return ");
    const p1 = provider.provideInlineCompletionItems(docA, { character: 4, line: 1 }, {}, fakeToken);
    const p2 = provider.provideInlineCompletionItems(docB, { character: 11, line: 1 }, {}, fakeToken);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, [], "stale first request must yield nothing");
    assert.strictEqual(r2.length, 1, "latest request must yield the suggestion");
    assert.strictEqual(fetchCalls.length, 1, "Ollama must be called exactly once, got " + fetchCalls.length);
  });

  // 8. Provider happy path + disabled + empty prefix
  await test("provider returns one ghost-text item at the cursor", async () => {
    configValues = { "inlineCompletion.delayMs": 5 };
    fetchReturning("    return a + b");
    const provider = new LocalNestInlineCompletionProvider();
    const doc = fakeDocument("def add(a, b):\n    ");
    const pos = { character: 4, line: 1 };
    const items = await provider.provideInlineCompletionItems(doc, pos, {}, fakeToken);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, "return a + b");
    assert.deepStrictEqual(items[0].range.start, pos);
    assert.deepStrictEqual(items[0].range.end, pos);
  });
  await test("provider returns [] and never calls Ollama when disabled", async () => {
    configValues = { "inlineCompletion.delayMs": 5, "inlineCompletion.enabled": false };
    fetchReturning("    return a + b");
    const provider = new LocalNestInlineCompletionProvider();
    const items = await provider.provideInlineCompletionItems(fakeDocument("def f():\n    "), { character: 4, line: 1 }, {}, fakeToken);
    assert.deepStrictEqual(items, []);
    assert.strictEqual(fetchCalls.length, 0);
  });
  await test("provider returns [] with no fetch when the prefix is empty", async () => {
    configValues = { "inlineCompletion.delayMs": 5 };
    fetchReturning("x = 1");
    const provider = new LocalNestInlineCompletionProvider();
    const items = await provider.provideInlineCompletionItems(fakeDocument(""), { character: 0, line: 0 }, {}, fakeToken);
    assert.deepStrictEqual(items, []);
    assert.strictEqual(fetchCalls.length, 0);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
