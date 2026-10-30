# LocalNest for Antigravity

![LocalNest logo](media/icon.png)

*New, original logo (2026-10-30): a teal circuit-woven nest cradling a glowing amber code bracket, on deep navy. Created fresh for LocalNest — not taken from any existing extension logo, and not TuxNest's logo.*

An original, local-first AI engineering extension inspired by the TuxNest
workflow — built for Google Antigravity (a VS Code fork). It is not TuxNest,
and it does not copy TuxNest code.

## What it does (v0.8)

- **Ask** — answer ANY question, coding or general, about the open repo
  or not. Workspace files are used as context when relevant, otherwise
  the model answers from its own knowledge.
- **Plan** — produce a concrete plan only: goal, numbered steps with exact
  file paths, risks, validation. No code is written in Plan mode.
- **Agent** — propose multi-file changes in a machine-readable format.
  Nothing is written until you approve a file (or Approve all). Proposed
  commands run only after you press “Run approved commands”, and dangerous
  commands (`sudo`, `rm -rf /`, disk formatting) are refused outright.
- **Build — major projects** — tick “Major project” in Build mode, or just ask for a shop, blog, dashboard or full-stack app. LocalNest first asks the model for a project blueprint (name, 8–20 files, commands), then generates the project in batches of 3 files so a local model does not truncate a large project into one huge reply, with progress shown per batch. All files are then delivered as one approval card (or auto-created if that box is ticked). If Ollama is offline or the blueprint fails, Build falls back to a complete major template: a shop (12 products, search, filters, cart, checkout), a blog/CMS (posts, search, publishing), a dashboard (projects, tasks, progress, stats), or a full-stack Node app (REST API persisted to data.json + frontend that uses it, run with `node server.js`).
- **Build** — create a complete website or app from one request, e.g.
  “create a todo website”, “create a weather app”, “create my portfolio”.
  With Ollama running, the model generates the full, runnable files.
  Without Ollama, Build still works from built-in working templates
  (todo, weather via free Open-Meteo, calculator, quiz, notes, portfolio,
  generic website) — so a request always produces a real app, not a
  description of one. Tick “Auto-create without review” in Build mode
  to write the files immediately; otherwise Build shows the same
  approval card as Agent. Either way, Undo still works.
- **Undo** — the last approved/auto-created batch can be undone; new files
  are deleted again, edited files are restored to their pre-approval
  contents.
- **Validation** — run the proposal's commands (for example `npm test`)
  from the panel and see the output there.
- **Local only** — chat goes to the Ollama host in Settings
  (`localNest.ollamaHost`, default `http://localhost:11434`). Point it at
  your own remote GPU host if you prefer. This extension never sends code
  to a cloud AI itself.

## Exactly how TuxNest works, step by step (v0.8)

TuxNest's own description is: understand repositories, plan changes,
review edits, execute approved commands and verify results, with
local Ollama or your own remote GPU host — “Your models. Your code.
Visible evidence.” LocalNest v0.8 follows that exact sequence, with
each step shown in the panel (not hidden):

1. **Inspect the workspace — context before code.** Every Ask/Plan/
   Agent request first inspects the workspace and posts “Step 1 —
   Inspect workspace” with the files used as context. Ask never writes.
2. **Ask / Plan / Agent, in that order.** Ask answers. Plan writes
   only a plan, never files, and then shows “Build this plan (Agent
   mode)” to carry that exact plan into Agent. Agent prepares a
   proposal, never writes directly.
3. **Prepare a reviewed proposal — multi-file, snapshot checks.**
   The panel shows “Step 2 — Reviewed proposal, snapshot checks”
   with update/new counts, a preview per file, and a View (review)
   button. Originals are recorded for Undo.
4. **Explicit approval, then approved commands only.** Approve per
   file or Approve all. Commands run only after you press “Run
   approved commands” (or after you explicitly tick Auto-create,
   which is labelled as skipping per-file approval and is off by
   default). Dangerous commands are still refused.
5. **Validation after accepted edits — visible.** After Approve all,
   LocalNest automatically posts “Step 3 — Validation after accepted
   edits”, checks the approved files, and if anything is still
   missing, proposes fixes that go through review again (up to 5
   steps). Command output is shown in the panel as evidence.
6. **Your models.** Default is LOCAL OLLAMA (status shows it), or
   your own remote Ollama host via the Ollama Host setting. Gemini
   3.8 Flash remains as an extra cloud option you asked for earlier,
   not the default. No separate IDE, no GPU settings in the
   extension.

Honest limit: LocalNest is original code inspired by TuxNest, not
TuxNest itself — it does not claim to be TuxNest, does not use its
source or branding, and cannot copy internal prompts or a
marketplace listing that are not public. What it does copy exactly
is the publicly described workflow above.

## Like TuxNest: plug-and-play, local-first, reviewable, verified (v0.7)

TuxNest's promise, in its own words, is: install the extension,
connect a supported local or cloud model, and build with reviewable
changes and visible verification — no separate IDE, no GPU
configuration. LocalNest v0.7 is built to that exact list:

- **Install the extension, nothing else to configure in it**: install
  the VSIX in VS Code or Antigravity and the LocalNest panel is there.
  No config is required to start — Ask still searches the workspace
  and Build still creates working templates offline, with no model at
  all.
- **Connect a supported local or cloud model**: Local = any Ollama
  model (qwen, llama, codellama, deepseek-coder, any model you pull —
  the panel lists what you actually have). Cloud = Gemini, default
  `gemini-3.8-flash` / `gemini-2.5-flash`, plus any other Gemini model
  ID you set. Pick Provider in the panel, press Refresh.
- **Reviewable changes**: Plan mode plans without writing. Agent/Build
  proposals are NEVER written until you approve them — each file now
  shows a preview in the panel, plus a “View (review)” button that
  opens the proposed file beside the editor (untitled, nothing written
  to disk) so you can read it first. Approve per file, Approve all,
  or Discard. Undo restores the last approved batch.
- **Visible verification**: after files are written, the agent runs
  the commands and shows their output in the panel, then verifies
  whether the task is done and fixes what is missing (agentic loop,
  up to 5 steps, “Agent step 2/5…”). With approval on, press
  “Verify & fix (Continue agent)” after approving to run that
  verification step. Nothing is verified silently.
- **Local-first**: with Ollama, code never leaves this machine.
  LocalNest has no telemetry and makes no network call except to the
  model host you chose (localhost Ollama, or the Gemini API).
- **No separate IDE, no GPU configuration**: it lives inside VS Code /
  Antigravity as a sidebar panel — there is no separate app to open.
  There are no GPU/CUDA settings anywhere in the extension; Ollama
  manages hardware itself and runs on CPU by default.

## Any language, any device, any network (v0.6)

- **Any coding language**: LocalNest is a general LLM for Antigravity,
  not a web-only tool. Ask in Python, Java, Go, Rust, C, C++, C#,
  Kotlin, Swift, TypeScript, JavaScript, PHP, Ruby, SQL or any other
  language — the model is told to use ONLY that language, its idioms,
  its project files (go.mod, Cargo.toml, pom.xml, requirements.txt,
  package.json) and its run commands. It never defaults to JavaScript
  unless you asked for it. Offline, Build still gives you a runnable
  starter in the language you named (Python, Java, Go, Rust, C/C++,
  Kotlin, Swift, PHP, Ruby, C#, TypeScript, SQL) with its run command
  in the README; online, Gemini/Ollama generate the full logic.
- **Any desktop / laptop, smoothly**: pure JavaScript/TypeScript, zero
  runtime dependencies, no native binaries, a ~37 KB VSIX, activation
  only when you open the panel (not at startup), streaming replies,
  and a capped workspace context. It runs on Windows, macOS and Linux,
  x64 and arm64, on old or low-RAM machines, in VS Code 1.85+ and
  Antigravity. Commands are generated for YOUR device — the model is
  told your OS, architecture and shell, so Windows gets `python` and
  PowerShell/cmd commands, macOS/Linux get `python3` and bash.
- **Any network**: three tiers, in order. (1) Online: Gemini 3.8 Flash
  via API. (2) Local/offline: Ollama on your machine, no internet
  needed. (3) No model at all: workspace search, plus Build templates
  and language starters. If the selected provider fails on this
  network, auto-fallback (on by default) tries the other provider
  before giving up, and tells you it switched. Tick “Low-bandwidth /
  slow network” for smaller context and smaller replies on hotspots
  and slow connections. It does not need a fast connection to work —
  it needs one only for the Gemini model itself.

## Works like a Gemini 3.8 Flash agent (v0.5)

Gemini 3.8 Flash (model `gemini-3.8-flash`, released 2 September 2026,
1M-token context) is Google's Flash workhorse for autonomous software
engineering and long-horizon, multi-step tasks, with iterative tool
calls. LocalNest v0.5 copies that behaviour, and can use that exact
model:

- **Provider: Gemini** in the panel, model `gemini-3.8-flash`.
  Get a free key at https://aistudio.google.com/app/apikey, then press
  “Set Gemini API Key” in the panel (or Command Palette →
  “LocalNest: Set Gemini API Key”). The key goes into VS Code Secret
  Storage, never into settings files or chat. Without a key, Gemini
  shows “no API key” and LocalNest falls back to telling you how to set
  it — it never pretends to be Gemini.
- **Provider: Ollama** still works exactly as before, local and private,
  with the same agent loop — just slower and weaker on small models.
- **Agentic loop (on by default)**: in Agent/Build mode, LocalNest does
  not stop at one answer. It plans, writes files, runs the commands,
  feeds the output back to the model, verifies whether the task is done,
  and fixes what is missing, up to 5 steps, posting “Agent step 2/5…”
  as it goes. With auto-create on, this is hands-free. With approval
  on, approve a batch, then press “Continue agent” to run the next
  verify-and-fix step.
- **Important, honest note**: this extension is not Google's Antigravity
  agent and does not use Antigravity's built-in Gemini for free. If you
  want the real `gemini-3.8-flash` model, you need your own Gemini API
  key (intro pricing $0.75 / $3.75 per 1M input/output tokens through
  31 Dec 2026, per Google). With Ollama, you get agent-like behaviour
  with a local model, at no API cost.

## Full desktop access (v0.4)

LocalNest runs as you, in Antigravity, so it can in principle reach any
file you can reach. v0.4 makes that explicit and opt-in, instead of
silently limiting everything to the open folder:

- **Build target** in the panel: This project folder (default), Desktop,
  Home, or a custom folder like `~/Projects/my-app`.
- **Full desktop access checkbox**: tick it when you want files and
  commands outside the open folder. Without it, Agent/Build stay in the
  workspace as before.
- **Desktop builds go in their own folder**: choosing Desktop for
  “create an ecommerce shop” creates `~/Desktop/ecommerce-shop/`, not
  loose files all over your Desktop. Same for Home/Custom.
- **Any building task**: use “Run any command in the target folder”
  for `npm install`, `git clone`, `git status`, `pip install`,
  `python3 -m http.server 8000`, `node server.js`, tests, builds —
  output comes back into the panel, in the target folder.
- **Open target folder** opens that folder in Antigravity;
  **List Desktop** lists what is on your Desktop.
  Command Palette also has “LocalNest: Open Desktop Folder” and
  “LocalNest: List Desktop Files”.
- **Absolute paths work too**: if a model proposal gives an absolute
  path, LocalNest writes to that path (with the same approval/Undo flow),
  instead of forcing it under the workspace.

What full access does NOT mean: it never runs `rm -rf /`, disk
formatting, or `sudo` — those are refused even with full access on,
because they are destruction or need a terminal password, not building.
Run those yourself in a terminal if you really mean them. File writes
and commands still go through the same approval/auto-create choice you
picked, and Undo still restores the last batch, wherever it was written.

## Install in Antigravity (the important part)

Antigravity uses OpenVSX by default, not the Microsoft VS Code Marketplace,
so do **not** expect to find this by searching the Marketplace inside
Antigravity until it is published to OpenVSX. Install the packaged file:

1. In Antigravity: Extensions view → `...` → **Install from VSIX…**
   (or from a terminal: `antigravity --install-extension localnest-antigravity-0.8.0.vsix`)
2. Reload Antigravity.
3. Click the LocalNest (house) icon in the Activity Bar.

If you also use plain VS Code, the same `.vsix` installs there with
`code --install-extension localnest-antigravity-0.8.0.vsix`.

## Start Ollama

```sh
ollama serve
ollama pull qwen2.5-coder:7b
# smaller / faster alternatives:
# ollama pull qwen2.5-coder:1.5b
# ollama pull llama3.1:8b
```

Then in the LocalNest panel press **Refresh** — the status should read
`◉ LOCAL OLLAMA` and the model dropdown should list your pulled models.
If Ollama is offline, Ask still shows a workspace search summary, and
Plan/Agent explain what to start — it never pretends a model answered.

## Use it

1. Open a project folder.
2. Ask: “Where is authentication handled?” — Plan: “Add a login rate
   limit” — Agent: “Add a health-check endpoint and a test for it”.
3. In Agent mode, review the proposal card, approve files one by one,
   then run its commands to validate.
4. `Ctrl/Cmd+Shift+P` → “LocalNest: Explain Selection” explains selected
   code; “LocalNest: Undo Last Approved Changes” rolls a batch back.

## Settings

- `localNest.ollamaHost` — Ollama base URL (local or your remote host).
- `localNest.model` — default model; the panel dropdown overrides it.
- `localNest.maxContextFiles` — how many workspace files are sent as
  context (default 8, capped at ~60k characters total).

## Build from source

```sh
npm install
npm run compile
npm run package   # produces localnest-antigravity-0.8.0.vsix
```

## Publish to OpenVSX (so Antigravity users can find it)

1. Create an OpenVSX account and namespace, get a personal access token.
2. `npx ovsx publish localnest-antigravity-0.8.0.vsix -p <token>`
3. Optionally publish the same package to the VS Code Marketplace with
   `vsce publish` for plain VS Code users.

## License

LocalNest is released under the **MIT License** — see the [LICENSE](LICENSE) file in this repo.

That means anyone can use, copy, modify, merge, publish, distribute, sublicense, and sell it, free of charge, as long as the copyright and permission notices are kept in copies. The software is provided “as is”, without warranty.

## Limits of v0.8

- No embeddings / vector RAG yet — context matching is keyword scoring
  over filenames and file contents. Good for small-to-medium repos.
- No inline ghost completions — chat + proposals only.
- Agent proposals need a code-capable model; a 1.5b model may ignore
  the `### FILE:` format. In Build mode this is covered by the template
  fallback, but in Agent mode the panel then shows the raw reply
  and no file is written.
