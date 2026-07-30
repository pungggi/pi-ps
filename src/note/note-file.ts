/**
 * Read / write the freeform note body.
 */

import * as fs from "node:fs";
import { ensureParentDir } from "./paths.js";

export interface NoteFile {
  body: string;
  /** ISO mtime, or null if the file does not exist. */
  mtime: string | null;
  exists: boolean;
}

export function readNote(filePath: string): NoteFile {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { body: "", mtime: null, exists: false };
    }
    const body = fs.readFileSync(filePath, "utf8");
    return {
      body: stripTrailingNewlines(body),
      mtime: stat.mtime.toISOString(),
      exists: true,
    };
  } catch {
    return { body: "", mtime: null, exists: false };
  }
}

export function writeNote(filePath: string, body: string): NoteFile {
  ensureParentDir(filePath);
  const normalized = stripTrailingNewlines(body) + (body.trim().length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, normalized, "utf8");
  return readNote(filePath);
}

export function clearNote(filePath: string): NoteFile {
  return writeNote(filePath, "");
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/(?:\r?\n)+$/u, "");
}
