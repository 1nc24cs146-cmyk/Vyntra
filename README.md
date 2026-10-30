# Vyntra for Antigravity

![Vyntra logo](media/icon.png)

Vyntra is a local-first AI coding agent that lives in the sidebar of your editor. You talk to it, it understands your project, and it changes code only after you review and approve it.

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

**8. It works with the model you connect.**
By default it talks to a local model through Ollama on your own machine, so your code does not leave your machine. You can also point it at your own remote Ollama host, or switch to a cloud model. If the model you picked is not reachable, it tries the other one, and if no model is reachable, Ask still searches your workspace and Build still creates a working app from a built-in template.

**9. Build works the same way, for whole apps.**
In Build mode, tell it what to build — a website, an app, or a larger multi-file project. It generates the complete files, shows them as one proposal for review, and only writes them after approval, following the same steps above.
