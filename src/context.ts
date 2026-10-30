import * as vscode from "vscode";

export interface ContextFile {
  content: string;
  path: string;
  score: number;
}

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".localnest",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
  "out",
  "venv"
]);

export async function collectContext(query: string, maxFiles: number, lowBandwidth = false): Promise<{ files: ContextFile[]; summary: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { files: [], summary: "No folder is open. Open a project folder first so Vyntra can read its files." };
  }
  const root = folders[0].uri;
  const all = await vscode.workspace.findFiles(
    "**/*",
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.pdf,**/*.zip,**/*.lock}"
  );
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
  const candidates = all
    .map((uri) => vscode.workspace.asRelativePath(uri))
    .filter((rel) => !rel.split("/").some((part) => SKIP_DIRS.has(part)))
    .slice(0, 400);

  // Score by filename first — cheap, and usually the right file wins here.
  const scoredPaths = candidates
    .map((rel) => {
      const lower = rel.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (lower.includes(token)) {
          score += lower.endsWith(token) || lower.includes(`/${token}`) ? 3 : 1;
        }
      }
      return { rel, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(20, maxFiles * 3));

  const files: ContextFile[] = [];
  let budget = lowBandwidth ? 30000 : 60000; // characters total, so a small local model is not drowned
  for (const candidate of scoredPaths) {
    if (files.length >= maxFiles && candidate.score === 0) {
      break;
    }
    try {
      const uri = vscode.Uri.joinPath(root, candidate.rel);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 60000) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      if (text.includes("\0")) {
        continue; // binary slipped through
      }
      let score = candidate.score;
      const lowerText = text.toLowerCase();
      for (const token of tokens) {
        if (lowerText.includes(token)) {
          score += 1;
        }
      }
      const snippet = text.slice(0, lowBandwidth ? 4000 : 8000);
      files.push({ content: snippet, path: candidate.rel, score });
      budget -= snippet.length;
      if (budget <= 0) {
        break;
      }
    } catch {
      // unreadable file — skip it, don't fail the whole question
    }
  }
  files.sort((a, b) => b.score - a.score);
  const picked = files.slice(0, maxFiles);

  const editor = vscode.window.activeTextEditor;
  let summary = `Workspace: ${folders[0].name} (${candidates.length} files indexed). Context files: ${picked.map((f) => f.path).join(", ") || "none"}.`;
  if (editor) {
    const doc = editor.document;
    const sel = editor.selection;
    const selected = sel && !sel.isEmpty ? doc.getText(sel).slice(0, 4000) : "";
    summary += `\nOpen file: ${vscode.workspace.asRelativePath(doc.uri)}.`;
    if (selected) {
      summary += `\nSelected code:\n${selected}`;
    }
  }
  return { files: picked, summary };
}

export function contextToPrompt(files: ContextFile[]): string {
  if (files.length === 0) {
    return "No workspace files matched. Answer from the question alone and say what file you would need to be sure.";
  }
  return files.map((f) => `--- FILE: ${f.path} ---\n${f.content}`).join("\n\n");
}
