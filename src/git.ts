// Git diff reading (0.9.40) — pure helpers plus one small async reader, so
// the parsing can be unit-tested from compiled JS without an editor running.
// Used by two features:
//   1. Commit messages straight from the git diff — "/commit" with no
//      description reads the diff (staged first, then unstaged) and writes
//      a conventional-commit message from it.
//   2. Code review of staged changes — "/review staged" reviews exactly
//      what is about to be committed (git diff --cached).
// This file only READS. It never stages, commits, or writes anything, and
// the diff is sent only to the user's own local Ollama model, like the
// workspace context already is.

import { execFile } from "child_process";

export type GitDiffScope = "staged" | "unstaged" | "all" | "auto";

export interface GitDiffResult {
  /** The diff text itself, capped at MAX_DIFF_CHARS. */
  diff: string;
  /** Error in plain words when no diff could be read (git missing, not a repo, nothing changed). Empty when the read worked. */
  error: string;
  /** Changed file paths, in diff order. */
  files: string[];
  /** The scope that was actually read ("staged" or "unstaged" for auto). */
  scope: "staged" | "unstaged" | "all";
  /** Human label for the scope, e.g. "staged changes". */
  scopeLabel: string;
  /** True when the diff was cut at MAX_DIFF_CHARS. */
  truncated: boolean;
}

export const MAX_DIFF_CHARS = 30000;

/** File paths from a unified diff, in order, deduplicated. */
export function parseDiffFiles(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    let file = "";
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      file = gitHeader[2];
    } else {
      const plusHeader = line.match(/^\+\+\+ b\/(.+)$/);
      if (plusHeader) {
        file = plusHeader[1];
      }
    }
    if (file && file !== "/dev/null" && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function scopeLabel(scope: "staged" | "unstaged" | "all"): string {
  return scope === "staged" ? "staged changes" : scope === "unstaged" ? "unstaged changes" : "all changes vs HEAD";
}

function runGit(cwd: string, args: string[]): Promise<{ code: number; spawnError: string; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, spawnError: err && typeof err.code === "string" ? err.code : "", stderr: stderr || "", stdout: stdout || "" });
    });
  });
}

function noDiffResult(scope: "staged" | "unstaged" | "all", error: string): GitDiffResult {
  return { diff: "", error, files: [], scope, scopeLabel: scopeLabel(scope), truncated: false };
}

async function readScope(cwd: string, scope: "staged" | "unstaged" | "all"): Promise<GitDiffResult> {
  // Gate on the repo first: outside a repo, `git diff` does NOT say "not a
  // git repository" — it falls back to --no-index mode and complains about
  // the --cached flag instead. rev-parse is the reliable check.
  const repo = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (repo.spawnError === "ENOENT") {
    return noDiffResult(scope, "git is not installed or could not be run — install git and try again.");
  }
  if (repo.code !== 0 || /not a git repository/.test((repo.stdout + "\n" + repo.stderr).toLowerCase())) {
    return noDiffResult(scope, "This folder is not a git repository — open a git project folder first, or use /commit with a description of the change instead.");
  }
  const args = scope === "staged" ? ["diff", "--cached"] : scope === "unstaged" ? ["diff"] : ["diff", "HEAD"];
  let out: { code: number; spawnError: string; stderr: string; stdout: string };
  try {
    out = await runGit(cwd, args);
  } catch {
    return noDiffResult(scope, "git is not installed or could not be run — install git and try again.");
  }
  const combined = (out.stdout + "\n" + out.stderr).toLowerCase();
  if (out.code === 129 || /unknown option|usage: git diff/.test(combined)) {
    return noDiffResult(scope, "This git version did not understand the diff command — update git and try again.");
  }
  if (/fatal:/.test(combined) && !out.stdout.trim()) {
    return noDiffResult(scope, "git reported an error: " + (out.stderr.trim().split("\n")[0] || "unknown git error") + ".");
  }
  const raw = out.stdout;
  if (!raw.trim()) {
    return noDiffResult(scope, scope === "staged"
      ? "Nothing is staged — stage changes first (git add), or use /commit on its own to write a message from the unstaged changes instead."
      : scope === "unstaged"
        ? "No unstaged changes — everything is either committed or staged. Use /commit staged for the staged changes."
        : "No changes vs HEAD — nothing to write a message about yet.");
  }
  const truncated = raw.length > MAX_DIFF_CHARS;
  const diff = truncated ? raw.slice(0, MAX_DIFF_CHARS) : raw;
  return { diff, error: "", files: parseDiffFiles(raw), scope, scopeLabel: scopeLabel(scope), truncated };
}

/**
 * Read a git diff from a project folder. "auto" (the default for /commit)
 * reads the staged diff when there is one, and falls back to the unstaged
 * diff when nothing is staged — the diff you are about to commit is the
 * staged one, so it wins when it exists.
 */
export async function getGitDiff(cwd: string, scope: GitDiffScope): Promise<GitDiffResult> {
  if (scope === "auto") {
    const staged = await readScope(cwd, "staged");
    if (!staged.error) {
      return staged;
    }
    // Only fall back when the problem is "nothing staged" — a missing git
    // or a non-repo folder must not silently become an unstaged read.
    if (!/Nothing is staged/.test(staged.error)) {
      return staged;
    }
    return readScope(cwd, "unstaged");
  }
  return readScope(cwd, scope);
}

/** Model- and human-readable rendering of a diff result. */
export function formatGitDiffForPrompt(result: GitDiffResult): string {
  if (result.error) {
    return result.error;
  }
  const head = "Git diff (" + result.scopeLabel + " — " + result.files.length + " file(s): " + (result.files.join(", ") || "none listed") + "):";
  const tail = result.truncated ? "\n(Diff truncated to " + MAX_DIFF_CHARS + " characters — review only what is shown.)" : "";
  return head + "\n```diff\n" + result.diff + "\n```" + tail;
}

/** Plain-words request to review the staged changes, e.g. "review staged changes". */
export function isStagedReviewRequest(text: string): boolean {
  return /^\s*review\s+(the\s+|my\s+)?staged(\s+changes?)?\s*[?.!]*\s*$/i.test(text.trim());
}

/** Plain-words request to write a commit message, e.g. "write a commit message". */
export function isCommitMessageRequest(text: string): boolean {
  return /^\s*(write|generate|create|give me)\s+(a\s+|the\s+)?commit\s+message(\s+for\s+(this|the|my)\s+(changes|diff))?\s*[?.!]*\s*$/i.test(text.trim());
}
