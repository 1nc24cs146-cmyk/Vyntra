// Workspace-wide rename (0.9.42) — pure helpers, so the parsing and the
// safety checks can be unit-tested from compiled JS without an editor.
// The actual search reads the files directly (findSymbolOccurrences below)
// and the apply step uses a WorkspaceEdit — both live in extension.ts. This
// file never touches a file itself.
//
// Safety model, same as every other write in LocalNest: nothing is changed
// until the user confirms. /rename shows every occurrence first — file,
// line, and the line itself — and waits for a "yes, rename" / "apply it"
// reply. The confirm expires after 10 minutes, like the /push confirm.

import { promises as fs } from "fs";
import * as path from "path";

/** True for a character that can sit inside an identifier (letter, digit, _ or $). */
export function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * True when an occurrence of `symbol` at `offset` in `line` is a whole
 * symbol, not part of a longer name — the character before and after must
 * not be an identifier character. "foo" in "fooBar" is not a rename target;
 * "foo" in "foo()" or " foo " is.
 */
export function isWholeSymbol(line: string, offset: number, symbol: string): boolean {
  if (offset < 0 || offset + symbol.length > line.length) {
    return false;
  }
  if (line.slice(offset, offset + symbol.length) !== symbol) {
    return false;
  }
  const before = offset > 0 ? line[offset - 1] : "";
  const after = offset + symbol.length < line.length ? line[offset + symbol.length] : "";
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

/** All whole-symbol offsets of `symbol` in `line`, left to right. */
export function findWholeSymbolOffsets(line: string, symbol: string): number[] {
  if (!symbol) {
    return [];
  }
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const at = line.indexOf(symbol, from);
    if (at < 0) {
      return offsets;
    }
    if (isWholeSymbol(line, at, symbol)) {
      offsets.push(at);
    }
    from = at + Math.max(1, symbol.length);
  }
}

/** Escape a string for use as a literal in a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A symbol worth renaming: 2+ characters, no spaces, not a bare keyword-ish word. */
export function isValidSymbol(symbol: string): boolean {
  return symbol.length >= 2 && !/\s/.test(symbol);
}

export interface RenameRequest {
  from: string;
  to: string;
}

/**
 * Parse "/rename oldName newName" or "rename oldName to newName".
 * Returns null when the text is not a rename request with both names.
 */
export function parseRenameRequest(text: string): RenameRequest | null {
  const trimmed = text.trim();
  const slash = trimmed.match(/^\/rename\s+(\S+)\s+(\S+)\s*$/i);
  if (slash) {
    return { from: slash[1], to: slash[2] };
  }
  const words = trimmed.match(/^\s*rename\s+(\S+)\s+to\s+(\S+)\s*[?.!]*\s*$/i);
  if (words) {
    return { from: words[1], to: words[2] };
  }
  return null;
}

/** Plain-words rename request, e.g. "rename foo to bar" or "/rename foo bar". */
export function isRenameRequest(text: string): boolean {
  return parseRenameRequest(text) !== null;
}

/** Confirm reply for a pending rename, e.g. "yes, rename" / "apply it" / "rename it". */
export function isRenameConfirm(text: string): boolean {
  return /^\s*(yes,?\s*(rename|apply)( it| this| them)?|apply( it| this| the rename)?|rename it|go ahead( and rename( it)?)?|do it)\s*[?.!]*\s*$/i.test(text.trim());
}

/** Directories the rename search never enters. */
export const RENAME_SKIP_DIRS = new Set(["node_modules", ".git", "out", "dist", "build", ".vscode", "coverage"]);

/** File extensions the rename search never reads (binary or generated). */
export const RENAME_SKIP_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".vsix", ".exe", ".dll", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".map"]);

/** Most occurrences shown before asking the user to narrow the search. */
export const MAX_RENAME_OCCURRENCES = 200;

/** Largest single file the rename search reads (512 KB) — bigger files are skipped, not read. */
export const MAX_RENAME_FILE_BYTES = 512 * 1024;

/** Most files the rename search reads in one run — past that it stops and says so. */
export const MAX_RENAME_FILES = 2000;

export interface SymbolOccurrence {
  /** 0-based character offset of the symbol in the line. */
  character: number;
  /** Path relative to the searched root, e.g. "src/extension.ts". */
  file: string;
  /** 0-based line number. */
  line: number;
  /** The full line text, for showing the user what will change. */
  lineText: string;
}

export interface SymbolSearchResult {
  /** True when the search stopped early because the file cap was hit. */
  capped: boolean;
  /** Files actually read. */
  filesScanned: number;
  /** Whole-symbol occurrences found, in file order. */
  occurrences: SymbolOccurrence[];
  /** True when more than MAX_RENAME_OCCURRENCES were found (list is cut). */
  tooMany: boolean;
}

async function walkFiles(root: string, dir: string, out: string[], state: { capped: boolean }): Promise<void> {
  if (state.capped || out.length >= MAX_RENAME_FILES) {
    state.capped = true;
    return;
  }
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.capped || out.length >= MAX_RENAME_FILES) {
      state.capped = true;
      return;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (RENAME_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      await walkFiles(root, full, out, state);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".min.js") || RENAME_SKIP_EXTS.has(path.extname(lower))) {
        continue;
      }
      out.push(full);
    }
  }
}

/**
 * Find every whole-symbol use of `symbol` under `root`, by reading the files
 * directly — no external binary (no rg, no git grep), so it works in any
 * folder, not just a git repo. Skips node_modules, .git and build output,
 * binary files, and files over 512 KB.
 */
export async function findSymbolOccurrences(root: string, symbol: string): Promise<SymbolSearchResult> {
  const files: string[] = [];
  const state = { capped: false };
  await walkFiles(root, root, files, state);
  const occurrences: SymbolOccurrence[] = [];
  let filesScanned = 0;
  for (const full of files) {
    let stat: any;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_RENAME_FILE_BYTES) {
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    // A NUL byte means binary despite the extension — skip it.
    if (content.indexOf("\0") >= 0) {
      continue;
    }
    filesScanned++;
    const rel = path.relative(root, full).split(path.sep).join("/");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const at of findWholeSymbolOffsets(lines[i], symbol)) {
        occurrences.push({ character: at, file: rel, line: i, lineText: lines[i] });
        if (occurrences.length > MAX_RENAME_OCCURRENCES) {
          return { capped: state.capped, filesScanned, occurrences, tooMany: true };
        }
      }
    }
  }
  return { capped: state.capped, filesScanned, occurrences, tooMany: false };
}
