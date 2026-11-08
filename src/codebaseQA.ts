// Codebase Q&A (0.9.36) — pure helpers, no vscode import, so they can be
// unit-tested from compiled JS without an editor running.
// Answers are grounded in the actual workspace files handed in: definitions
// are found by scanning those files (with file:line citations), never
// invented. When nothing matches, the answer says so plainly.

export interface QaFile {
  content: string;
  path: string;
}

export interface DefinitionCandidate {
  file: string;
  kind: "class" | "const" | "function" | "interface" | "method" | "type";
  line: number;
  name: string;
  snippet: string;
}

export interface UsageHit {
  file: string;
  line: number;
  snippet: string;
}

const STOPWORDS = new Set([
  "about", "above", "after", "again", "all", "and", "any", "are", "ask", "been", "being", "but", "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has", "have", "having", "her", "here", "hers", "him", "his", "how", "into", "its", "just", "like", "more", "most", "not", "now", "off", "once", "only", "our", "out", "over", "own", "same", "she", "should", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "too", "under", "until", "very", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "work", "works", "would", "you", "your"
]);

/** True when the user is asking about their own codebase, not a general question. */
export function isCodebaseQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return /\bwhere is\b/.test(lower)
    || /\bwhere (is|are|do|does)\b.*\b(defined|declared|implemented|used|called|handled)\b/.test(lower)
    || /\bhow does\b.*\b(work|handle|get|run|load|save)\b/.test(lower)
    || /\bwhat does\b.*\b(do|handle|return)\b/.test(lower)
    || /\b(who|what) calls\b/.test(lower)
    || /\b(find|show|locate)\b.*\b(definition|where)\b/.test(lower)
    || /\bexplain\b.*\b(in|of)\b.*\b(this|my|the)\b.*\b(project|codebase|code|file|function|module)\b/.test(lower)
    || /\b(in|of) (this|my|the) (project|codebase|repo|repository|workspace)\b/.test(lower)
    || /\bcodebase\b/.test(lower);
}

/** Significant search terms from a question: quoted phrases first, then words. */
export function extractQuestionTerms(question: string): string[] {
  const terms: string[] = [];
  const quoted = question.match(/["'`]([^"'`]+)["'`]/g) || [];
  for (const q of quoted) {
    const inner = q.slice(1, -1).trim().toLowerCase();
    if (inner.length > 1) { terms.push(inner); }
  }
  const rest = question.replace(/["'`]([^"'`]+)["'`]/g, " ");
  for (const token of rest.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2)) {
    if (!STOPWORDS.has(token) && !terms.includes(token)) {
      terms.push(token);
    }
  }
  return terms;
}

const DEFINITION_PATTERNS: { kind: DefinitionCandidate["kind"]; re: RegExp }[] = [
  { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
  { kind: "function", re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: "function", re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/ },
  { kind: "class", re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "const", re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "method", re: /^\s*(?:public\s+|private\s+|protected\s+|async\s+|static\s+)*(?:[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/ },
  { kind: "function", re: /^\s*def\s+([A-Za-z_$][\w$]*)\s*\(/ },
  { kind: "class", re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/ }
];

/** Find definitions of the question's terms in the given files, best first. */
export function findDefinitions(files: QaFile[], terms: string[], max = 10): DefinitionCandidate[] {
  const found: DefinitionCandidate[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) { return; }
      for (const pattern of DEFINITION_PATTERNS) {
        const match = pattern.re.exec(line);
        if (!match) { continue; }
        const name = match[1];
        if (!name) { continue; }
        const lowerName = name.toLowerCase();
        const matchedTerm = terms.find((t) => lowerName === t || lowerName.includes(t) || t.includes(lowerName));
        if (!matchedTerm) { continue; }
        const key = file.path + ":" + (idx + 1) + ":" + name;
        if (seen.has(key)) { continue; }
        seen.add(key);
        // Exact name match scores higher than a partial one.
        const score = lowerName === matchedTerm ? 3 : lowerName.includes(matchedTerm) ? 2 : 1;
        found.push({ file: file.path, kind: pattern.kind, line: idx + 1, name, snippet: rawLine.trim().slice(0, 160) });
        void score;
        break;
      }
    });
  }
  found.sort((a, b) => {
    const aExact = terms.some((t) => a.name.toLowerCase() === t);
    const bExact = terms.some((t) => b.name.toLowerCase() === t);
    return Number(bExact) - Number(aExact);
  });
  return found.slice(0, max);
}

/** Lines that mention a term, excluding lines that DEFINE that term itself. */
export function findUsages(files: QaFile[], term: string, max = 10): UsageHit[] {
  const hits: UsageHit[] = [];
  const lowerTerm = term.toLowerCase();
  // A line defines the term only when the term is the declared name, e.g.
  // "function parseProposal(" or "const parseProposal = ..." — a line like
  // "const p = parseProposal(text);" is a usage, not a definition.
  const definesTerm = new RegExp("^\\s*(?:export\\s+)?(?:function\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b|(?:const|let|var)\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=|class\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b|interface\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b|type\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=|def\\s+" + lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b)", "i");
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((rawLine, idx) => {
      if (hits.length >= max) { return; }
      if (rawLine.toLowerCase().includes(lowerTerm) && !definesTerm.test(rawLine)) {
        hits.push({ file: file.path, line: idx + 1, snippet: rawLine.trim().slice(0, 160) });
      }
    });
  }
  return hits.slice(0, max);
}

/** Grounded offline answer: definitions + usages with file:line citations. */
export function buildCodebaseAnswer(question: string, files: QaFile[]): { answerText: string; candidates: DefinitionCandidate[]; terms: string[]; usages: UsageHit[] } {
  const terms = extractQuestionTerms(question);
  const candidates = findDefinitions(files, terms);
  const usages = candidates.length ? findUsages(files, candidates[0].name, 5) : (terms.length ? findUsages(files, terms[0], 5) : []);
  if (!files.length) {
    return { answerText: "No workspace files were inspected for that question — open a project folder first, then ask again.", candidates, terms, usages };
  }
  if (!candidates.length && !usages.length) {
    return {
      answerText: "I could not find " + (terms.length ? "'" + terms.join("', '") + "'" : "that") + " defined or used in the " + files.length + " workspace file(s) searched (" + files.map((f) => f.path).join(", ") + "). It may live in a file outside the searched context, be named differently, or not exist in this workspace — check the spelling or name the file.",
      candidates, terms, usages
    };
  }
  const lines: string[] = [];
  if (candidates.length) {
    lines.push("Found in this workspace:");
    for (const c of candidates) {
      lines.push("- " + c.kind + " `" + c.name + "` — " + c.file + ":" + c.line + " — `" + c.snippet + "`");
    }
  }
  if (usages.length) {
    lines.push("Used at:");
    for (const u of usages) {
      lines.push("- " + u.file + ":" + u.line + " — `" + u.snippet + "`");
    }
  }
  lines.push("These citations are from the workspace files actually searched. Anything beyond them still needs the model (or the file) to confirm.");
  return { answerText: lines.join("\n"), candidates, terms, usages };
}

/** Prompt fragment for the model: answer only from the cited files. */
export function buildCodebaseQAPrompt(question: string, candidates: DefinitionCandidate[]): string {
  return "CODEBASE QUESTION — answer ONLY from the workspace files given as context, and cite every claim as file:line (e.g. src/extension.ts:123). "
    + "Do NOT invent functions, files or APIs that are not in the context — do not guess. If the answer is not in the context, say plainly that it was not found in the searched files and name what file you would need. "
    + "Keep the answer short and structured: the definition first, then how it is used, then anything risky or worth knowing.\n"
    + "Question: " + question + "\n"
    + (candidates.length
      ? "Grounded definitions already found (verify them against the context before citing): " + candidates.map((c) => c.kind + " `" + c.name + "` in " + c.file + ":" + c.line).join("; ") + "."
      : "No definition matching the question was found by the workspace scan — do not guess one.");
}
