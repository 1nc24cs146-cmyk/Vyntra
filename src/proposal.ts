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

const DANGEROUS = [/rm\s+-rf\s+\//, /\bsudo\b/, /\bmkfs\b/, /:\(\)\s*\{/, />\s*\/dev\/sd/];

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
export function parseProposal(raw: string): Proposal {
  const files: ProposedFile[] = [];
  const fileRe = /###\s*FILE:\s*([^\n`]+)\n```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(raw)) !== null) {
    files.push({
      content: match[2].replace(/\n$/, ""),
      exists: false,
      original: null,
      path: match[1].trim()
    });
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
