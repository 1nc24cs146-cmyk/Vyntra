export interface ProposedFile {
  content: string;
  exists: boolean;
  original: string | null;
  path: string;
}

export interface Proposal {
  commands: string[];
  files: ProposedFile[];
  raw: string;
}

const DANGEROUS = [/rm\s+-rf\s+(\/|~|\.)/, /\bsudo\b/, /\bmkfs\b/, /:\(\)\s*\{/, />\s*\/dev\/sd/, /\brd\s+\/s\b/i, /\bdel\s+\/[a-z]*\s*\*/i, /\bformat\s+[a-z]:/i, /Remove-Item\b.*-Recurse/i];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

/**
 * Agent replies must use this exact format, so a proposal is machine-readable
 * instead of prose the extension has to guess at:
 *
 * ### FILE: src/example.ts
 * ```ts
 * ...full new file contents...
 * ```
 *
 * ### COMMANDS
 * ```sh
 * npm test
 * ```
 */
export function isUnsafeProposalPath(path: string): boolean {
  // A model must never be able to escape the project: no ".." segments,
  // no empty path, no directory-only path. Absolute paths are checked
  // again in applyFile against the actual target folder.
  const norm = path.replace(/\\/g, "/").trim();
  if (!norm || norm.endsWith("/")) { return true; }
  return norm.split("/").some((seg) => seg === "..");
}
export function parseProposal(raw: string): Proposal {
  const files: ProposedFile[] = [];
  const seen = new Map<string, number>();
  const fileRe = /###\s*FILE:\s*([^\n`]+)\n```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(raw)) !== null) {
    const path = match[1].trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (isUnsafeProposalPath(path)) { continue; }
    const file: ProposedFile = {
      content: match[2].replace(/\n$/, ""),
      exists: false,
      original: null,
      path
    };
    // Same file proposed twice: keep the last version, do not write it twice.
    if (seen.has(path)) { files[seen.get(path)!] = file; } else { seen.set(path, files.length); files.push(file); }
  }
  const commands: string[] = [];
  const cmdRe = /###\s*COMMANDS\s*\n```(?:sh|bash|shell)?\n([\s\S]*?)```/i;
  const cmdMatch = cmdRe.exec(raw);
  if (cmdMatch) {
    for (const line of cmdMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        commands.push(trimmed);
      }
    }
  }
  return { commands, files, raw };
}

/**
 * Apply a unified diff to original text. Returns null if the diff cannot
 * be applied cleanly. Supports "--- a/path", "+++ b/path", "@@ -a,b +c,d @@"
 * hunks, and " " / "-" / "+" lines. Used when a model replies with a diff
 * instead of a full file — much cheaper than rewriting a large file.
 */
export function applyUnifiedDiff(original: string, diff: string): string | null {
  const origLines = original ? original.split("\n") : [];
  const out: string[] = [];
  let origIdx = 0;
  const lines = diff.split("\n");
  let i = 0;
  // Skip diff headers.
  while (i < lines.length && (lines[i].startsWith("--- ") || lines[i].startsWith("+++ ") || lines[i].startsWith("diff ") || lines[i].startsWith("index "))) {
    i++;
  }
  let sawHunk = false;
  while (i < lines.length) {
    const line = lines[i];
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      sawHunk = true;
      const start = Math.max(0, parseInt(hunk[1], 10) - 1);
      // Copy unchanged lines up to the hunk start.
      while (origIdx < start && origIdx < origLines.length) {
        out.push(origLines[origIdx]);
        origIdx++;
      }
      i++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      if (origIdx < origLines.length) {
        out.push(origLines[origIdx]);
        origIdx++;
      }
      i++;
      continue;
    }
    if (line.startsWith("-")) {
      // Remove one original line (verify it matches when possible).
      if (origIdx < origLines.length) {
        origIdx++;
      }
      i++;
      continue;
    }
    if (line.startsWith("+")) {
      out.push(line.slice(1));
      i++;
      continue;
    }
    if (line.startsWith("\\")) {
      i++;
      continue;
    }
    // Unknown line inside a diff — stop, do not guess.
    break;
  }
  if (!sawHunk) {
    return null;
  }
  while (origIdx < origLines.length) {
    out.push(origLines[origIdx]);
    origIdx++;
  }
  return out.join("\n");
}

/** Parse "### DIFF: path" blocks, or ```diff blocks with ---/+++ headers. */
export function parseDiffProposal(raw: string): Proposal {
  const files: ProposedFile[] = [];
  const diffRe = /###\s*DIFF:\s*([^\n`]+)\n```diff\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = diffRe.exec(raw)) !== null) {
    files.push({ content: match[2].trim(), exists: false, original: null, path: match[1].trim() });
  }
  // Bare ```diff blocks: infer the path from +++ b/path.
  if (files.length === 0) {
    const bareRe = /```diff\n([\s\S]*?)```/g;
    while ((match = bareRe.exec(raw)) !== null) {
      const diffText = match[1];
      const plus = diffText.match(/^\+\+\+ b\/(.+)$/m) || diffText.match(/^\+\+\+ (.+)$/m);
      if (plus) {
        files.push({ content: diffText.trim(), exists: false, original: null, path: plus[1].trim() });
      }
    }
  }
  return { commands: [], files, raw };
}
