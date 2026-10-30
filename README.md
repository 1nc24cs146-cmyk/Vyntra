# Vyntra for Antigravity

Developed by NitinKumar Hiremath.

Vyntra is an AI coding agent that lives in the sidebar of your editor. You talk to it, it understands your project, and it changes code only after you review and approve it.

## How it works

**1. You open a project and ask a question.**
Type a question or a task in the Vyntra panel. You can pick a mode first: Ask, Plan, Agent, or Build.

**2. It inspects your workspace first.**
Before it answers, it looks through your project files and picks the ones that match your question. That context is sent to the model along with your question, so the answer is about your code, not generic code.

**3. Ask answers, Plan plans, Agent proposes.**
- **Ask** answers your question in the panel. It never changes a file.
- **Plan** writes only a plan: the goal, the exact files to change, the risks, and how to check it worked. It never changes a file. When you are happy with a plan, press “Build this plan” and it moves into Agent mode with that plan.
- **Agent** prepares a proposal: complete new or updated files, in one card. It does not write anything yet.

**4. You review every change before it is written.**
Each proposed file shows a preview in the panel. Press “View” to open the proposed file beside the editor and read the full version. Then approve files one by one, approve them all, or discard the proposal. Nothing is written until you approve it.

**5. Approved commands run, and only approved commands run.**
If the proposal includes commands, such as installing packages or running tests, they run only after you press “Run approved commands”. Dangerous commands are refused, even if they are proposed.

**6. It verifies the result after you approve.**
After you approve all files, it checks the approved files, runs the checks, and shows the output in the panel. If something is still missing or broken, it proposes a fix, and that fix goes through the same review and approval again. It repeats this verify-and-fix loop up to 5 steps.

**7. You can always undo.**
The original contents of every file are recorded before approval. “Undo last approved changes” restores edited files and deletes newly created files from that batch.

**8. It works with the model you pull in Ollama on your desktop.**
First, on your desktop, install Ollama, run `ollama serve`, then pull whichever model you want — for example `ollama pull qwen2.5-coder:7b`, `ollama pull llama3.2:3b`, or any other Ollama model. Then pick that model in the panel (or type its exact name), and chat uses that model. No API key, no fixed model, no cloud model — the model you pulled is the model chat uses. If no model is reachable, Ask still searches your workspace and Build still creates a working app from a built-in template.

**9. Build works the same way, for whole apps.**
In Build mode, tell it what to build — a website, an app, or a larger multi-file project. It generates the complete files, shows them as one proposal for review, and only writes them after approval, following the same steps above.

## How to use

1. Install it in Antigravity from Open VSX, or from Extensions > Install from VSIX.
2. Open a project folder, then open the LocalNest panel from the nest icon in the activity bar, or from the Command Palette > LocalNest: Open Chat. You can also type `@localnest` in chat.
3. First, pull a model in Ollama on your desktop: run `ollama serve`, then `ollama pull` whichever model you want (for example `qwen2.5-coder:7b`). Then in the panel, pick that model in Model, or type its exact name and press Use this model in chat — chat will use the model you pulled.
4. Pick a mode — Ask, Plan, Agent, or Build — type your question or task, and press Send.
5. Review the proposal: press View to read a proposed file, then approve files one by one or approve them all, or discard the proposal. Commands run only after you press Run approved commands.
6. If a result is wrong, ask for a fix, press Verify & fix, or press Undo last approved changes to restore the previous files.
