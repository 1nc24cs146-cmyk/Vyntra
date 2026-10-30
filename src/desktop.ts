import * as os from "os";
import * as path from "path";

export type TargetKind = "workspace" | "desktop" | "home" | "custom";

export function homeDir(): string {
  return os.homedir();
}

export function desktopDir(): string {
  return path.join(os.homedir(), "Desktop");
}

export function expandHomePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Turn a free-text request into a safe folder name, e.g. "create an ecommerce shop" -> "ecommerce-shop". */
export function sanitizeProjectName(prompt: string): string {
  let t = prompt
    .replace(/^(please\s+)?(create|build|make|develop|design|generate)\s+(an|a|the)?\s*/i, "")
    .replace(/\s+(website|web\s*app|app|site|page|project)\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!t) {
    t = "localnest-app";
  }
  if (t.length > 40) {
    t = t.slice(0, 40).replace(/-+$/, "");
  }
  return t;
}

/**
 * Resolve the base target folder for a build.
 * Workspace returns the open folder (or undefined). Desktop/Home/Custom
 * return absolute paths under the user's own account — this is the
 * "full desktop access" the user asked for: the extension, running as
 * the user, can write anywhere the user themselves can write.
 * It deliberately does NOT resolve paths outside the home folder for
 * custom input unless the user typed an absolute path themselves.
 */
export function resolveTargetRoot(kind: TargetKind, customPath: string, workspaceRoot: string | undefined): string | undefined {
  if (kind === "workspace") {
    return workspaceRoot;
  }
  if (kind === "desktop") {
    return desktopDir();
  }
  if (kind === "home") {
    return os.homedir();
  }
  if (kind === "custom") {
    const expanded = expandHomePath(customPath);
    return expanded || undefined;
  }
  return workspaceRoot;
}

export function buildRootForPrompt(kind: TargetKind, customPath: string, workspaceRoot: string | undefined, prompt: string): string | undefined {
  const base = resolveTargetRoot(kind, customPath, workspaceRoot);
  if (!base) {
    return undefined;
  }
  if (kind === "workspace") {
    return base;
  }
  // Outside the workspace, never dump files loose on the Desktop/Home:
  // put the project in its own named folder.
  return path.join(base, sanitizeProjectName(prompt));
}
