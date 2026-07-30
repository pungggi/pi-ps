/**
 * Resolve where the active note file lives.
 *
 * Priority:
 *   1. PI_PS_NOTE_PATH env override
 *   2. <cwd>/.pi/note.md   (project) — wins if the file exists
 *   3. ~/.pi-ps/note.md    (global, under the pi-ps config dir)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type NoteSource = "override" | "project" | "global";

export interface ResolvedNotePath {
  path: string;
  source: NoteSource;
  /** True when the file currently exists on disk. */
  exists: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function globalNoteDir(): string {
  return path.join(os.homedir(), ".pi-ps");
}

export function globalNotePath(): string {
  return path.join(globalNoteDir(), "note.md");
}

export function projectNotePath(cwd: string): string {
  return path.join(cwd, ".pi", "note.md");
}

/**
 * Pick the active note path for a working directory.
 * Project file wins whenever it exists (even if empty).
 * Override always wins when PI_PS_NOTE_PATH is set.
 */
export function resolveNotePath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNotePath {
  const override = env.PI_PS_NOTE_PATH?.trim();
  if (override) {
    const p = path.resolve(expandHome(override));
    return { path: p, source: "override", exists: fs.existsSync(p) };
  }

  const project = projectNotePath(cwd);
  if (fs.existsSync(project)) {
    return { path: project, source: "project", exists: true };
  }

  const global = globalNotePath();
  return { path: global, source: "global", exists: fs.existsSync(global) };
}

/** Ensure parent directory exists before writing. */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
