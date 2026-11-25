// Git diff reading (0.9.40) — pure helpers plus one small async reader, so
// the parsing can be unit-tested from compiled JS without an editor running.
// Used by four features:
//   1. Commit messages straight from the git diff — "/commit" with no
//      description reads the diff (staged first, then unstaged) and writes
//      a conventional-commit message from it.
//   2. Code review of staged changes — "/review staged" reviews exactly
//      what is about to be committed (git diff --cached).
//   3. PR descriptions from the diff (0.9.42) — "/pr" writes a title,
//      summary, what changed, why, and how to test, from the same diff.
//   4. Release notes from commits (0.9.42) — "/release" groups the commits
//      since the last tag (or the last 20 commits when there is no tag).
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

/** Plain-words request to write a pull request description, e.g. "write a PR description". */
export function isPrRequest(text: string): boolean {
  return /^\s*(write|generate|create|give me)\s+(a\s+|the\s+)?(pr|pull request)(\s+description)?(\s+for\s+(this|the|my)\s+(changes|diff|branch))?\s*[?.!]*\s*$/i.test(text.trim());
}

/** Plain-words request to write release notes, e.g. "write the release notes". */
export function isReleaseNotesRequest(text: string): boolean {
  return /^\s*(write|generate|create|give me)\s+(a\s+|the\s+)?release\s+notes?(\s+for\s+(this|the)\s+(version|release))?\s*[?.!]*\s*$/i.test(text.trim());
}

export interface GitCommit {
  /** Short hash, e.g. "a1b2c3d". */
  hash: string;
  /** Subject line, e.g. "feat: add /pr from the diff". */
  subject: string;
  /** Body lines, without the subject. May be empty. */
  body: string;
}

/** Conventional-commit type of a subject line ("feat", "fix", "docs", ...), or "other". */
export function commitType(subject: string): string {
  const m = subject.match(/^\s*([a-z]+)(\([^)]*\))?\s*:/i);
  if (!m) {
    return "other";
  }
  const t = m[1].toLowerCase();
  return ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "style", "build", "ci"].includes(t) ? t : "other";
}

export interface GitLogResult {
  /** Commits, newest first. */
  commits: GitCommit[];
  /** Plain-words error when the log could not be read. Empty when it worked. */
  error: string;
  /** What the range covers, e.g. "since tag v0.9.41 (3 commits)" or "last 20 commits (no tag found)". */
  rangeLabel: string;
}

const RELEASE_GROUP_HEADINGS: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  docs: "Docs",
  refactor: "Changed",
  perf: "Changed",
  test: "Tests",
  chore: "Chore",
  style: "Changed",
  build: "Chore",
  ci: "Chore",
  other: "Other changes"
};

/** Group commits by type, in release-notes order, for the model prompt. */
export function groupCommitsForRelease(commits: GitCommit[]): { heading: string; items: GitCommit[] }[] {
  const order = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "style", "build", "ci", "other"];
  const groups: { heading: string; items: GitCommit[] }[] = [];
  for (const type of order) {
    const items = commits.filter((c) => commitType(c.subject) === type);
    if (items.length) {
      groups.push({ heading: RELEASE_GROUP_HEADINGS[type] || "Other changes", items });
    }
  }
  return groups;
}

/** Model- and human-readable rendering of a commit list. */
export function formatCommitsForPrompt(result: GitLogResult): string {
  if (result.error) {
    return result.error;
  }
  const lines: string[] = ["Commits (" + result.rangeLabel + "):"];
  for (const g of groupCommitsForRelease(result.commits)) {
    lines.push("");
    lines.push(g.heading + ":");
    for (const c of g.items) {
      lines.push("- " + c.hash + " " + c.subject + (c.body ? " — " + c.body.replace(/\s+/g, " ").slice(0, 200) : ""));
    }
  }
  return lines.join("\n");
}

/** Suggested next version bump from the commits: "minor" when any feature landed, else "patch". */
export function suggestedBump(commits: GitCommit[]): "minor" | "patch" {
  return commits.some((c) => commitType(c.subject) === "feat") ? "minor" : "patch";
}

/**
 * Read the commits for release notes: since the last tag when one exists,
 * otherwise the last 20 commits. Read-only — never creates a tag or a commit.
 */
export async function getGitLog(cwd: string): Promise<GitLogResult> {
  const repo = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (repo.spawnError === "ENOENT") {
    return { commits: [], error: "git is not installed or could not be run — install git and try again.", rangeLabel: "" };
  }
  if (repo.code !== 0 || /not a git repository/.test((repo.stdout + "\n" + repo.stderr).toLowerCase())) {
    return { commits: [], error: "This folder is not a git repository — open a git project folder first.", rangeLabel: "" };
  }
  const tag = await runGit(cwd, ["describe", "--tags", "--abbrev=0"]);
  const lastTag = tag.code === 0 ? tag.stdout.trim() : "";
  const range = lastTag ? lastTag + "..HEAD" : "HEAD";
  const count = lastTag ? 200 : 20;
  const out = await runGit(cwd, ["log", range, "--format=%h%x00%s%x00%b%x1e", "-n", String(count)]);
  if (out.code !== 0) {
    // A repo with no commits yet: `git log HEAD` fails with "ambiguous
    // argument 'HEAD'" — that is not a git error worth showing, it just
    // means there is nothing to write notes about.
    if (/ambiguous argument 'HEAD'|unknown revision/.test(out.stderr)) {
      return { commits: [], error: "No commits in this repository yet — commit something first, then run /release again.", rangeLabel: "" };
    }
    return { commits: [], error: "git reported an error reading the log: " + (out.stderr.trim().split("\n")[0] || "unknown git error") + ".", rangeLabel: "" };
  }
  const commits: GitCommit[] = [];
  for (const record of out.stdout.split("\x1e")) {
    const parts = record.trim().split("\x00");
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
      commits.push({ body: (parts[2] || "").trim(), hash: parts[0].trim(), subject: parts[1].trim() });
    }
  }
  if (!commits.length) {
    return { commits: [], error: lastTag ? "No commits since tag " + lastTag + " — nothing to write release notes about yet." : "No commits in this repository yet — commit something first, then run /release again.", rangeLabel: "" };
  }
  return {
    commits,
    error: "",
    rangeLabel: lastTag ? "since tag " + lastTag + " (" + commits.length + " commit(s))" : "last " + commits.length + " commit(s) (no tag found)"
  };
}
