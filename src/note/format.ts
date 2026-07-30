/**
 * Build the payload injected into the agent context.
 */

import type { NoteSource } from "./paths.js";

export const CUSTOM_TYPE = "pi-ps-note";

export interface NotePayloadInput {
  body: string;
  source: NoteSource;
  path: string;
  /** Instant the payload was built (ISO-like local offset). */
  updatedAt: string;
  /** File mtime ISO, if known. */
  mtime: string | null;
  /** Compact git line, or null when disabled / not a repo. */
  gitLine: string | null;
}

export interface BuiltPayload {
  content: string;
  details: {
    source: NoteSource;
    path: string;
    updatedAt: string;
    mtime: string | null;
    hasBody: boolean;
    hasGit: boolean;
  };
  hasContent: boolean;
}

export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

export function buildPayload(input: NotePayloadInput): BuiltPayload {
  const hasBody = input.body.trim().length > 0;
  const hasGit = Boolean(input.gitLine);

  const header = `[pi-ps note · ${input.updatedAt} · ${input.source}]`;
  const lines: string[] = [header];

  if (hasGit && input.gitLine) {
    lines.push(input.gitLine);
  }

  if (hasBody) {
    if (hasGit) lines.push("");
    lines.push(input.body.trimEnd());
  } else if (!hasGit) {
    lines.push(`(no note — /note set <text> or edit ${input.path})`);
  }

  return {
    content: lines.join("\n"),
    details: {
      source: input.source,
      path: input.path,
      updatedAt: input.updatedAt,
      mtime: input.mtime,
      hasBody,
      hasGit,
    },
    hasContent: true,
  };
}

/** Keep only the newest pi-ps-note custom message in a message list. */
export function pruneNoteMessages<T extends { role?: string; customType?: string }>(
  messages: T[],
): T[] {
  let lastIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "custom" && m.customType === CUSTOM_TYPE) {
      lastIdx = i;
    }
  }
  if (lastIdx < 0) return messages;

  return messages.filter((m, i) => {
    if (m.role === "custom" && m.customType === CUSTOM_TYPE) {
      return i === lastIdx;
    }
    return true;
  });
}
