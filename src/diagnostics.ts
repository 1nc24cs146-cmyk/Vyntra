// Auto-fix diagnostics (0.9.36) — pure helpers, no vscode import, so they
// can be unit-tested from compiled JS without an editor running.
// The editor side (extension.ts) reads vscode.languages.getDiagnostics()
// into DiagnosticItem[] and feeds it here; the model then proposes fixes
// as FILE blocks through the EXISTING proposal/approval flow. Nothing in
// this file ever writes a file or applies a fix on its own.

export interface DiagnosticItem {
  code?: number | string;
  column: number;
  file: string;
  line: number;
  message: string;
  severity: "error" | "hint" | "info" | "warning";
  source?: string;
}

export function severityLabel(severity: DiagnosticItem["severity"]): string {
  return severity === "error" ? "Error" : severity === "warning" ? "Warning" : severity === "info" ? "Info" : "Hint";
}

export function countBySeverity(items: DiagnosticItem[]): { errors: number; hints: number; infos: number; total: number; warnings: number } {
  const counts = { errors: 0, hints: 0, infos: 0, total: items.length, warnings: 0 };
  for (const item of items) {
    if (item.severity === "error") { counts.errors++; }
    else if (item.severity === "warning") { counts.warnings++; }
    else if (item.severity === "info") { counts.infos++; }
    else { counts.hints++; }
  }
  return counts;
}

export function groupDiagnosticsByFile(items: DiagnosticItem[]): Map<string, DiagnosticItem[]> {
  const grouped = new Map<string, DiagnosticItem[]>();
  for (const item of items) {
    const list = grouped.get(item.file) || [];
    list.push(item);
    grouped.set(item.file, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.line - b.line || a.column - b.column);
  }
  return grouped;
}

function oneLine(item: DiagnosticItem): string {
  const code = item.code !== undefined && item.code !== "" ? " [" + String(item.code) + "]" : "";
  const source = item.source ? " (" + item.source + ")" : "";
  const hint = fixHintFor(item.message, item.code);
  return item.file + ":" + item.line + ":" + item.column + " [" + severityLabel(item.severity) + "]" + code + " " + item.message + source + (hint ? " — Hint: " + hint : "");
}

/** Human- and model-readable rendering of a diagnostic list. */
export function formatDiagnostics(items: DiagnosticItem[], max = 20): string {
  if (!items.length) {
    return "No diagnostics — no errors, warnings or hints reported for the current file/workspace.";
  }
  const counts = countBySeverity(items);
  const shown = items.slice(0, max);
  const lines = [
    "Diagnostics: " + counts.total + " total (" + counts.errors + " error(s), " + counts.warnings + " warning(s), " + counts.infos + " info, " + counts.hints + " hint(s))" + (items.length > max ? " — showing first " + max : "")
  ];
  for (const item of shown) {
    lines.push("- " + oneLine(item));
  }
  return lines.join("\n");
}

/** Short, deterministic hint for a well-known diagnostic, "" when unknown. */
export function fixHintFor(message: string, code?: number | string): string {
  const lower = message.toLowerCase();
  const codeStr = String(code || "");
  if (/cannot find name|ts2304/.test(lower) || codeStr === "2304") {
    return "Check the spelling and that the name is imported or declared in this file.";
  }
  if (/cannot find module|ts2307/.test(lower) || codeStr === "2307") {
    return "Check the import path exists, or install the missing package.";
  }
  if (/has no exported member|ts2305/.test(lower) || codeStr === "2305") {
    return "Check the exported name in the source file — it may be renamed or a default export.";
  }
  if (/declared but (its value is )?never read|is declared but never used|ts6133|ts6196/.test(lower) || codeStr === "6133" || codeStr === "6196") {
    return "Remove the unused variable/import, or prefix it with _ if it must stay.";
  }
  if (/is not assignable to|type .* is not assignable|ts2322|ts2345/.test(lower) || codeStr === "2322" || codeStr === "2345") {
    return "The value's type does not match the expected type — change the value or the declared type, not both blindly.";
  }
  if (/property .* does not exist|ts2339/.test(lower) || codeStr === "2339") {
    return "Check the property name and the object's type — it may be misspelled or only present on another type.";
  }
  if (/is possibly 'null'|is possibly 'undefined'|possibly null|ts18047|ts18048/.test(lower) || codeStr === "18047" || codeStr === "18048") {
    return "Add a null/undefined check (or optional chaining) before using the value.";
  }
  if (/';' expected|',' expected|expression expected|ts1005|ts1109/.test(lower) || codeStr === "1005" || codeStr === "1109") {
    return "A syntax error nearby — check the previous line for a missing bracket, comma or semicolon.";
  }
  if (/missing return|not all code paths return|ts7030/.test(lower) || codeStr === "7030") {
    return "Every code path must return a value of the declared type — add the missing return.";
  }
  if (/implicitly has type 'any'|implicit any|ts7006|ts7053/.test(lower) || codeStr === "7006" || codeStr === "7053") {
    return "Give the parameter or value an explicit type instead of relying on implicit any.";
  }
  if (/unused|never used/.test(lower)) {
    return "Remove it if it is genuinely unused.";
  }
  return "";
}

/** Prompt fragment for the model: fix these diagnostics as reviewable FILE blocks. */
export function buildAutoFixPrompt(items: DiagnosticItem[], scope: string): string {
  return "AUTO-FIX DIAGNOSTICS (" + scope + "). Fix EVERY diagnostic listed below, in priority order: errors first, then warnings, then info/hints. "
    + "For each diagnostic, explain the cause in one line, then give the corrected code. "
    + "In Agent/Build mode output the corrected files ONLY as ### FILE: blocks, so each fix goes through the normal review-and-approve flow — NEVER claim a fix has been applied, and NEVER write a file yourself. "
    + "Change only the lines needed to fix the diagnostics; do not change unrelated behaviour, do not rename things, and do not invent new files. "
    + "If a diagnostic cannot be fixed from the context given, say which one and what file you would need, instead of guessing.\n\n"
    + formatDiagnostics(items, 20);
}

/** "file.ts:12:3" style location, for citing a diagnostic in chat. */
export function diagnosticLocation(item: DiagnosticItem): string {
  return item.file + ":" + item.line + ":" + item.column;
}
