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
