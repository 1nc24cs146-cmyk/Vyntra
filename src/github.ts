// GitHub in LocalNest (0.9.41) — connect a GitHub account, push changes,
// and publish a project to GitHub, from the chat panel.
//
// Security model — the token is the crown jewel, so:
//   * It lives ONLY in the editor's Secret Storage (key below), never in
//     settings, globalState, a file, chat history, or a log line.
//   * It is never put in a git remote URL or a .git/config entry.
//   * git push authenticates through a per-command credential helper:
//     `git -c credential.helper=<shell>` answers git's credential prompt
//     from environment variables set only on that one child process. The
//     token never appears in a command line, a file, or an error message —
//     every user-facing git error is passed through redactSecrets first.
//     (GIT_ASKPASS was tried first and does NOT work here: git execs its
//     value as one program path, so a `node -e ...` command fails.)
//   * Nothing is pushed, committed, or published without the user saying
//     so in the chat first ("/push" then "push it", "/publish" then a
//     confirm). /push and /publish never run on their own.
//
// This file has no vscode dependency, so the pure helpers and the API
// layer can be tested from compiled JS without an editor running. The
// only vscode touchpoint is the caller passing secretStorage in.

import { execFile } from "child_process";

export const GITHUB_TOKEN_KEY = "localNest.githubToken";

/** Where the token is created: classic token, `repo` scope (or a
 *  fine-grained token with Contents read + write on the repos used). */
export const GITHUB_TOKEN_URL = "https://github.com/settings/tokens";

const API_BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Plain-words request detectors (like isCommitMessageRequest in git.ts)
// ---------------------------------------------------------------------------

/** "connect github" / "connect my github account" — start the token flow. */
export function isGitHubConnectRequest(text: string): boolean {
  return /^\s*(connect|link|sign in to|log ?in to|add)\s+(my\s+|to\s+)?(github|git hub)(\s+account)?\s*[?.!]*\s*$/i.test(text.trim());
}

/** "github status" — who is connected + what this folder's git state is. */
export function isGitHubStatusRequest(text: string): boolean {
  return /^\s*(github|git hub)\s+status\s*[?.!]*\s*$/i.test(text.trim());
}

/** "disconnect github" — forget the stored token. */
export function isGitHubDisconnectRequest(text: string): boolean {
  return /^\s*(disconnect|unlink|sign out of|log ?out of|remove|forget)\s+(my\s+|from\s+)?(github|git hub)(\s+account)?\s*[?.!]*\s*$/i.test(text.trim());
}

/** "push to github" / "push my changes" — start the push flow. */
export function isPushToGitHubRequest(text: string): boolean {
  return /^\s*push(\s+(my\s+|the\s+|these\s+)?(changes|code|project|work|commits?)?)?(\s+to\s+(github|git hub))?\s*[?.!]*\s*$/i.test(text.trim());
}

/** "publish to github" / "upload my project to github" — start publish. */
export function isPublishToGitHubRequest(text: string): boolean {
  return /^\s*(publish|upload|put|share)(\s+(my\s+|the\s+|this\s+)?(project|code|work|app|folder|repo(sitory)?))?(\s+to\s+(github|git hub))?\s*[?.!]*\s*$/i.test(text.trim());
}

/** "push it" / "yes, push" — the confirm step for a pending /push. */
export function isPushConfirm(text: string): boolean {
  return /^\s*(push it|yes[ ,]? push|push now|go ahead( and)? push|push please|confirm push)\s*[?.!]*\s*$/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface GitHubRemote { owner: string; repo: string; }

/**
 * owner/repo from a git remote URL. Accepts:
 *   https://github.com/owner/repo(.git)
 *   https://github.com/owner/repo/
 *   git@github.com:owner/repo(.git)
 * Anything else (other hosts, local paths) returns null.
 */
export function parseGitHubRemote(url: string): GitHubRemote | null {
  const trimmed = (url || "").trim();
  let m = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) {
    return { owner: m[1], repo: m[2] };
  }
  m = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) {
    return { owner: m[1], repo: m[2] };
  }
  return null;
}

/** A folder name turned into a valid GitHub repo name: lowercase, letters,
 *  digits, -, _, . only; anything else becomes "-"; never empty. */
export function sanitizeRepoName(name: string): string {
  const cleaned = (name || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^\.+/, "");
  return cleaned || "my-project";
}

/** Defensive redaction: the token must never reach a chat line, a log, or
 *  an error message, even if git or the API echoes it back. */
export function redactSecrets(text: string, token?: string): string {
  if (!token || !text) {
    return text;
  }
  return text.split(token).join("[token]");
}

// ---------------------------------------------------------------------------
// GitHub API (global fetch; baseUrl is overridable so tests can point at a
// local fake server instead of api.github.com)
// ---------------------------------------------------------------------------

export interface GitHubApiResult<T> {
  data: T | null;
  /** Plain-words error, empty when the call worked. */
  error: string;
  status: number;
}

function apiError(status: number, bodyText: string): string {
  if (status === 401) {
    return "GitHub said the token is invalid or expired — connect again with a fresh token (/github connect).";
  }
  if (status === 403) {
    return /rate limit/i.test(bodyText)
      ? "GitHub rate limit reached — wait a few minutes and try again."
      : "GitHub refused — the token may not have the 'repo' permission. Create a token with the repo scope at github.com/settings/tokens, then /github connect again.";
  }
  if (status === 404) {
    return "Not found on GitHub — check the name and that the token can see it.";
  }
  if (status === 422) {
    return "A repository with that name already exists on your account — pick another name.";
  }
  return "GitHub returned an error (" + status + ")" + (bodyText ? ": " + bodyText.slice(0, 200) : "") + ".";
}

export async function githubApi<T>(token: string, path: string, method: "GET" | "POST", body?: unknown, baseUrl: string = API_BASE): Promise<GitHubApiResult<T>> {
  const url = baseUrl.replace(/\/$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      method,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      return { data: null, error: apiError(res.status, text), status: res.status };
    }
    return { data: (text ? JSON.parse(text) : null) as T, error: "", status: res.status };
  } catch (err: any) {
    const msg = String(err?.name === "AbortError" ? "timed out" : err?.message || err);
    return { data: null, error: "Could not reach GitHub (" + msg + ") — check your network and try again.", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export interface GitHubUser { login: string; name: string; }

/** Validate a token and learn who it belongs to. */
export async function getGitHubUser(token: string, baseUrl?: string): Promise<GitHubApiResult<GitHubUser>> {
  const res = await githubApi<any>(token, "/user", "GET", undefined, baseUrl);
  if (res.error || !res.data) {
    return { data: null, error: res.error, status: res.status };
  }
  return { data: { login: String(res.data.login || ""), name: String(res.data.name || res.data.login || "") }, error: "", status: res.status };
}

export interface GitHubRepo { cloneUrl: string; fullName: string; htmlUrl: string; }

/** Create a repository on the user's own account. */
export async function createGitHubRepo(token: string, opts: { description: string; isPrivate: boolean; name: string }, baseUrl?: string): Promise<GitHubApiResult<GitHubRepo>> {
  const res = await githubApi<any>(token, "/user/repos", "POST", { description: opts.description || undefined, name: opts.name, private: opts.isPrivate }, baseUrl);
  if (res.error || !res.data) {
    return { data: null, error: res.error, status: res.status };
  }
  return {
    data: { cloneUrl: String(res.data.clone_url || ""), fullName: String(res.data.full_name || ""), htmlUrl: String(res.data.html_url || "") },
    error: "",
    status: res.status
  };
}

/** True when the repo exists and the token can see it; false on 404.
 *  Any other failure comes back as { error }. */
export async function checkGitHubRepo(token: string, owner: string, name: string, baseUrl?: string): Promise<boolean | { error: string }> {
  const res = await githubApi<any>(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name), "GET", undefined, baseUrl);
  if (res.status === 404) {
    return false;
  }
  if (res.error) {
    return { error: res.error };
  }
  return true;
}

// ---------------------------------------------------------------------------
// git — local operations for push / publish (git.ts stays read-only)
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv, timeoutMs: number = 60000): Promise<{ code: number; spawnError: string; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: extraEnv ? { ...process.env, ...extraEnv } : process.env, maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, spawnError: err && typeof err.code === "string" ? err.code : "", stderr: stderr || "", stdout: stdout || "" });
    });
  });
}

export interface RepoState {
  /** Commits on this branch that the remote does not have yet. */
  ahead: number;
  behind: number;
  branch: string;
  /** Plain-words error when the folder is not a repo or git is missing. */
  error: string;
  /** True when the branch has commits the remote lacks, or has commits and no upstream yet. */
  hasUnpushed: boolean;
  /** True when anything is staged, unstaged, or untracked. */
  hasChanges: boolean;
  /** True when the branch has at least one commit. */
  hasCommits: boolean;
  isRepo: boolean;
  remoteOwner: string;
  remoteRepo: string;
  remoteUrl: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

/**
 * The git credential helper used for push. It is a shell function (the `!`
 * form git runs through the shell) that answers git's `get` call from
 * environment variables set only on the git child process — the token
 * never lands in a command line, a file, or git config. The empty
 * `credential.helper=` first clears any helper the user has configured,
 * so a stale stored login cannot answer before this one.
 * NOTE: GIT_ASKPASS cannot do this — git execs its value as one program
 * path, so a command with arguments fails ("cannot exec ...").
 */
export function buildCredentialHelper(): string {
  return "!f() { if [ \"$1\" = get ]; then printf 'username=%s\\npassword=%s\\n' \"$LN_GH_USER\" \"$LN_GH_TOKEN\"; fi; }; f";
}

function credentialEnv(login: string, token: string): NodeJS.ProcessEnv {
  return { GIT_TERMINAL_PROMPT: "0", LN_GH_TOKEN: token, LN_GH_USER: login };
}

export async function getRepoState(cwd: string): Promise<RepoState> {
  const empty: RepoState = {
    ahead: 0, behind: 0, branch: "", error: "", hasChanges: false, hasCommits: false, hasUnpushed: false, isRepo: false,
    remoteOwner: "", remoteRepo: "", remoteUrl: "", stagedCount: 0, unstagedCount: 0, untrackedCount: 0
  };
  const repo = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (repo.spawnError === "ENOENT") {
    return { ...empty, error: "git is not installed or could not be run — install git and try again." };
  }
  if (repo.code !== 0 || /not a git repository/.test((repo.stdout + "\n" + repo.stderr).toLowerCase())) {
    return { ...empty, error: "This folder is not a git repository yet — use /publish to put it on GitHub, or open a git project folder." };
  }
  const state: RepoState = { ...empty, isRepo: true };
  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code === 0) {
    state.branch = branch.stdout.trim();
  } else {
    // No commits yet: HEAD does not resolve, but the branch name still
    // exists (e.g. a fresh `git init -b main`) — read it from the ref.
    const sym = await runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    state.branch = sym.code === 0 ? sym.stdout.trim() : "";
  }
  const remote = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (remote.code === 0) {
    state.remoteUrl = remote.stdout.trim();
    const parsed = parseGitHubRemote(state.remoteUrl);
    if (parsed) {
      state.remoteOwner = parsed.owner;
      state.remoteRepo = parsed.repo;
    }
  }
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
  if (status.code === 0) {
    const lines = status.stdout.split("\n").filter(Boolean);
    const head = lines.find((l) => l.startsWith("## ")) || "";
    const aheadMatch = head.match(/ahead (\d+)/);
    const behindMatch = head.match(/behind (\d+)/);
    state.ahead = aheadMatch ? parseInt(aheadMatch[1], 10) : 0;
    state.behind = behindMatch ? parseInt(behindMatch[1], 10) : 0;
    const noUpstream = !/\.\.\./.test(head);
    const noCommits = /No commits yet/.test(head);
    for (const line of lines) {
      if (line.startsWith("## ")) {
        continue;
      }
      const x = line[0] || " ";
      const y = line[1] || " ";
      if (x === "?" && y === "?") {
        state.untrackedCount++;
      } else {
        if (x !== " " && x !== "?") {
          state.stagedCount++;
        }
        if (y !== " " && y !== "?") {
          state.unstagedCount++;
        }
      }
    }
    state.hasChanges = state.stagedCount + state.unstagedCount + state.untrackedCount > 0;
    state.hasCommits = !noCommits;
    // No upstream + commits + a remote means the first push still has to
    // happen (push -u); ahead alone covers the normal case.
    state.hasUnpushed = state.ahead > 0 || (noUpstream && !noCommits && !!state.remoteUrl);
  }
  return state;
}

/** One-line human summary of a repo state, for /github status replies. */
export function formatRepoState(s: RepoState): string {
  if (s.error) {
    return s.error;
  }
  const parts: string[] = [];
  parts.push("branch " + (s.branch || "(no branch yet)"));
  if (s.remoteUrl) {
    parts.push("remote " + (s.remoteOwner && s.remoteRepo ? s.remoteOwner + "/" + s.remoteRepo : s.remoteUrl));
  } else {
    parts.push("no remote yet");
  }
  if (s.ahead > 0) {
    parts.push(s.ahead + " commit(s) not pushed yet");
  }
  if (s.behind > 0) {
    parts.push(s.behind + " commit(s) behind the remote");
  }
  if (s.hasChanges) {
    const bits: string[] = [];
    if (s.stagedCount) {
      bits.push(s.stagedCount + " staged");
    }
    if (s.unstagedCount) {
      bits.push(s.unstagedCount + " unstaged");
    }
    if (s.untrackedCount) {
      bits.push(s.untrackedCount + " untracked");
    }
    parts.push("uncommitted changes: " + bits.join(", "));
  } else {
    parts.push("working tree clean");
  }
  return parts.join(" — ");
}

export async function stageAll(cwd: string): Promise<string> {
  const out = await runGit(cwd, ["add", "-A"]);
  if (out.code !== 0) {
    return "Could not stage the changes: " + (out.stderr.trim().split("\n")[0] || "git add failed") + ".";
  }
  return "";
}

export async function commitStaged(cwd: string, message: string): Promise<{ error: string; hash: string }> {
  const out = await runGit(cwd, ["commit", "-m", message]);
  if (out.code !== 0) {
    const first = (out.stderr.trim() || out.stdout.trim()).split("\n")[0] || "git commit failed";
    return { error: /nothing to commit/i.test(first) ? "Nothing to commit — the changes were already committed, or staging found nothing new." : "Could not commit: " + first + ".", hash: "" };
  }
  const hash = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return { error: "", hash: hash.code === 0 ? hash.stdout.trim() : "" };
}

/** Push the current branch to origin, authenticating with the stored token
 *  through the credential helper (see buildCredentialHelper). Returns a
 *  plain-words error, or "" on success. The token is redacted out of any
 *  git output before it is returned. */
export async function pushCurrentBranch(cwd: string, branch: string, login: string, token: string): Promise<string> {
  const state = await getRepoState(cwd);
  if (state.error) {
    return state.error;
  }
  const hasUpstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const pushArgs = hasUpstream.code === 0 ? ["push"] : ["push", "-u", "origin", branch || "HEAD"];
  const args = ["-c", "credential.helper=", "-c", "credential.helper=" + buildCredentialHelper(), ...pushArgs];
  const out = await runGit(cwd, args, credentialEnv(login, token));
  if (out.code !== 0) {
    const raw = (out.stderr.trim() || out.stdout.trim()).split("\n").filter(Boolean).slice(-3).join(" ");
    const clean = redactSecrets(raw, token);
    if (/authentication failed|invalid username or password|permission denied/i.test(clean)) {
      return "GitHub rejected the sign-in — the token may be expired or missing the 'repo' permission. Connect again with a fresh token (/github connect).";
    }
    if (/could not resolve host|failed to connect|network is unreachable|timed out/i.test(clean)) {
      return "Could not reach github.com — check your network and try again.";
    }
    return "Push failed: " + (clean || "git push exited with an error") + ".";
  }
  return "";
}

export async function initRepo(cwd: string): Promise<string> {
  const out = await runGit(cwd, ["init", "-b", "main"]);
  if (out.code !== 0) {
    // Older git has no -b: fall back to plain init (default branch then).
    const retry = await runGit(cwd, ["init"]);
    if (retry.code !== 0) {
      return "Could not start a git repository here: " + (retry.stderr.trim().split("\n")[0] || "git init failed") + ".";
    }
  }
  return "";
}

export async function setRemoteOrigin(cwd: string, url: string): Promise<string> {
  const existing = await runGit(cwd, ["remote", "get-url", "origin"]);
  const args = existing.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url];
  const out = await runGit(cwd, args);
  if (out.code !== 0) {
    return "Could not set the GitHub remote: " + (out.stderr.trim().split("\n")[0] || "git remote failed") + ".";
  }
  return "";
}
