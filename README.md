# Vyntra for Antigravity

**Developed by NitinKumar Hiremath.**

Vyntra is a AI coding agent for Antigravity. It runs on the models already on your own computer, in your own editor, with no cloud account, no API key, and no code sent to a remote service to answer you.

You ask it a question, plan a change, or build a whole app — and it never writes a file until you have reviewed and approved it.

---

## Why local-first?

- **Your code stays on your machine.** The model runs through Ollama on your desktop. Vyntra does not send your project to a cloud model.
- **No subscription, no API key.** The models are free Ollama models. You pull the one you want, once, and use it as much as you like.
- **No GPU setup.** Ollama runs on CPU by default. A smaller model (3B) answers much faster on a normal laptop than a larger one (7B).
- **You stay in control.** Every file change and every command passes through you first.

## Quick start

1. **Install Ollama** on your desktop from [ollama.com/download](https://ollama.com/download), then start it. On Windows, Ollama runs in the system tray after install.
2. **Pull a model** you want, in a terminal:
   ```sh
   ollama pull llama3.2:3b
   ```
   Or pull a coding model instead, for example `qwen2.5-coder:7b`. Any Ollama model works.
3. **Install Vyntra** in Antigravity — from Open VSX, or from Extensions > Install from VSIX.
4. **Open Vyntra Chat** from the nest icon in the activity bar, or from the Command Palette > Vyntra: Open Chat.
5. **Pick your model.** The panel first shows the Ollama models available on your machine. Pick one, press **Download selected model** if it is not downloaded yet, then **Continue to chat**. Chat opens only when that model is actually ready.
6. **Ask, plan, or build.** Pick a mode, type your task, and press Send.

That's it. No sign-in, no key, no extra IDE.

## The panel at a glance

The panel is deliberately simple, in two stages:

**Stage 1 — Get ready**
- A status line showing whether Ollama is running and which models are available
- One dropdown: **Available Ollama models** — models already on your machine first, then popular free models marked "(download)"
- **Download selected model** and **Continue to chat** — chat opens when the model is ready, not before

**Stage 2 — Chat**
- A top bar with the Vyntra name, refresh, and new chat
- **Auto + LOCAL** — showing that answers come from your local model
- Tabs: **Ask / Plan / Agent / Build**, plus a **Fast** toggle for quicker, smaller-context answers
- Your messages on the right, Vyntra's answers on the left, errors clearly marked as **Task Failed** with the reason in plain words
- A footer showing **Changes / Terminal / Ready** (or "Ollama offline" when the model is not reachable)
- **@ chips** — @file, @selection, @terminal, @diagnostics, @git — tap one to point Vyntra at exactly that thing
- Input at the bottom with Send, Stop, and New chat

Everything else lives in the Command Palette, not in the panel, so the panel stays clean.

## First open: the system check

The first time Vyntra opens, it checks your machine and tells you plainly what is missing, instead of failing silently:

| What it finds | What you see |
|---|---|
| Ollama is not installed | "Ollama is NOT installed on this system, so Vyntra cannot answer yet. Install Ollama to continue." — with an Install button |
| Ollama is installed but not running | How to start it with `ollama serve` |
| Ollama is running, but no model is pulled | Pick a model and press Download |
| A model is already pulled | "Chat is ready" — and chat opens straight away |

If Ollama is already installed, Vyntra will also try to start it automatically when it is offline, on your machine only. It never downloads a model without you pressing Download.

## Modes

| Mode | What it does | Does it change files? |
|---|---|---|
| **Ask** | Answers your question in the panel | No, never |
| **Plan** | Writes only a plan: goal, exact files to change, risks, and how to check it worked | No, never. Press "Build this plan" to carry the plan into Agent mode |
| **Agent** | Prepares a complete proposal of new or updated files, for your review | Only after you approve, file by file or all at once |
| **Build** | Builds a complete website, app, or multi-file project, as one proposal | Only after you approve, same as Agent |

You can switch modes at any time. Ask and Plan are safe to use freely — they cannot change a file, even by accident.

## Skills

Type a skill at the start of your message, in any mode, with your local Ollama model — no key, no extra install:

| Skill | What it does |
|---|---|
| `/review` | Reviews code for bugs, security, performance and style, grouped Critical / Major / Minor |
| `/test` | Generates tests for the code you give, main path plus edge and failure cases |
| `/fix` | Explains the cause in a line or two, then gives the corrected code |
| `/explain` | Explains code in simple steps, then technical detail |
| `/docs` | Writes documentation / README for the code or project |
| `/refactor` | Refactors for readability without changing behaviour |
| `/commit` | Writes a conventional-commit message for a change you describe |
| `/security` | Security audit: SQLi, XSS, secrets, weak crypto, SSRF, missing auth, and more, each with a risk level and a secure fix |
| `/summarize` | Summarises a file, project or workspace |

Type `/skills` any time to see the list again. Example: `/review look at this function and tell me what is wrong`

You can also export a whole chat: press **Export chat** in the panel (or run "LocalNest: Export Chat to Markdown"). It opens as a document for you to save — nothing is written to disk automatically.

## How it works

1. **You give a task.** Type it in the panel, in any mode, in any programming language.
2. **It looks at your project only when you ask it to.** If you mention your project, a file, or a folder, use an @ chip, name a file, or select code in the editor, Vyntra inspects that project first and shows you which files it used as context. If you just ask a general question or give a new task, it works on that task directly, with no project scan slowing it down.
3. **It answers, plans, or proposes.** Ask gives an answer. Plan gives a plan. Agent and Build give a proposal: complete file contents, not snippets or descriptions.
4. **You review before anything is written.** Each proposed file has a preview in the panel. Press **View** to read the full proposed file beside your editor. Then approve files one by one, approve them all, or discard the proposal. Nothing is written until you approve it.
5. **Commands run only after approval.** If a proposal includes commands — installing packages, running tests, starting a server — they run only after you press **Run approved commands**. Dangerous commands are refused, even if proposed.
6. **It verifies after approval.** After you approve files, Vyntra checks the result and shows the output. If something is still missing or broken, it proposes a fix, and that fix goes through the same review again, up to 5 steps.
7. **You can always undo.** The original contents of every file are recorded before approval. **Undo last approved changes** restores edited files and deletes newly created files from that batch.

## Choosing a model

Any Ollama model works, and you can type an exact model name in the panel if it is not in the list. A few good starting points:

- `llama3.2:3b` — small, fast, good for general questions and small tasks on a laptop
- `qwen2.5-coder:7b` — larger, stronger for code, slower on CPU without a GPU
- Any other model you have pulled — pick it in the dropdown and chat uses that model

Practical notes:

- The **first answer after a download is always the slowest** — the model is loading into memory. Later answers get faster as it stays loaded.
- **Fast mode** uses a smaller context, so first words arrive sooner. Turn it on for quick questions.
- If an answer seems stuck, press **Stop**, turn Fast on, and ask once again. Do not send the same question twice in a row.
- Chat keeps a short history, so follow-up questions ("now do the same for the other file") work without repeating everything.

## Building whole apps

In **Build** mode, tell Vyntra what to build — a website, a desktop app, a Python project, a game, anything. It generates every file needed to run it, shows them as one proposal, and writes them only after your approval, with the same review, command, verify, and undo steps as Agent mode.

If no model is reachable, Build still works offline: it creates a working website or app from a built-in template, so you are never blocked by Ollama being off.

## Safety, in short

- Ask and Plan never write files.
- Agent and Build write only after your approval, unless you deliberately turn on "Auto-create without review" (off by default, and clearly labelled as skipping approval).
- Commands run only after "Run approved commands", and destructive commands are refused.
- API keys, if you ever use a cloud option in future, go into the editor's Secret Storage — never into a file.
- No telemetry. No account. No code leaves your machine to answer you.
- File writes are capped by a size setting, so a runaway proposal cannot silently replace a huge file.

## Requirements

- Antigravity (any recent version)
- Ollama installed on the same machine, with at least one model pulled
- That's all. No account, no key, no GPU, no separate IDE.

## Troubleshooting

- **"Ollama is NOT installed"** — install it from ollama.com/download, restart Antigravity, and open Vyntra Chat again.
- **"Ollama is offline"** — start it with `ollama serve` in a terminal, or let Vyntra try to start it automatically, then press Refresh in the panel.
- **Model download sits at 0%** — a 3B model is about 2 GB. 0% can sit for minutes, especially on a VPN. Turn the VPN off for the download, do not press Download again (Vyntra will say "already downloading"), and do not close Antigravity.
- **First answer is slow** — normal on CPU, especially the first answer after a download. It gets faster as the model stays loaded. Try Fast mode for quick questions.
- **"Model not found"** — the saved model was not pulled. Pick a model that is actually on your machine in the dropdown, or type its exact pulled name.
- **Chat is not opening** — press **Diagnose chat** in the panel, or open Vyntra Chat from the Command Palette.

## Commands

The main commands, all in the Command Palette under "Vyntra: …":

- Open Chat, Open Models, New Chat, Stop Generation
- Ask / Plan / Agent / Build (switch mode and ask)
- Approve All / Discard Proposal / Undo Last Approved Changes / Verify & Fix
- Refresh Models, Test My Model, Diagnose Chat
- Set Ollama Host, Set Model

## License

MIT License. Copyright (c) 2026 NitinKumar Hiremath. See LICENSE for the full text.

---

*Vyntra for Antigravity — Developed by NitinKumar Hiremath. Local-first, review-first, and yours to run on your own machine.*
