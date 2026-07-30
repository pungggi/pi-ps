import { describe, expect, it } from "vitest";
import {
  buildPayload,
  CUSTOM_TYPE,
  formatTimestamp,
  pruneNoteMessages,
} from "../src/note/format.js";

describe("formatTimestamp", () => {
  it("returns local offset ISO-like string", () => {
    const ts = formatTimestamp(new Date("2026-03-30T16:42:11.000Z"));
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});

describe("buildPayload", () => {
  it("includes header, git, and body", () => {
    const p = buildPayload({
      body: "Ship via tag only",
      source: "project",
      path: "/repo/.pi/note.md",
      updatedAt: "2026-03-30T18:42:11+02:00",
      mtime: "2026-03-30T18:40:00.000Z",
      gitLine: "git: note ≡ clean",
    });
    expect(p.content).toBe(
      [
        "[pi-ps note · 2026-03-30T18:42:11+02:00 · project]",
        "git: note ≡ clean",
        "",
        "Ship via tag only",
      ].join("\n"),
    );
    expect(p.details.hasBody).toBe(true);
    expect(p.details.hasGit).toBe(true);
  });

  it("shows placeholder when empty and no git", () => {
    const p = buildPayload({
      body: "",
      source: "global",
      path: "/home/u/.pi-ps/note.md",
      updatedAt: "2026-03-30T18:42:11+02:00",
      mtime: null,
      gitLine: null,
    });
    expect(p.content).toContain("(no note — /note set");
    expect(p.details.hasBody).toBe(false);
    expect(p.details.hasGit).toBe(false);
  });

  it("git-only when body empty", () => {
    const p = buildPayload({
      body: "  ",
      source: "project",
      path: "x",
      updatedAt: "t",
      mtime: null,
      gitLine: "git: main ↑1 clean",
    });
    expect(p.content).toBe("[pi-ps note · t · project]\ngit: main ↑1 clean");
    expect(p.details.hasBody).toBe(false);
    expect(p.details.hasGit).toBe(true);
  });
});

describe("pruneNoteMessages", () => {
  it("keeps only the last pi-ps-note custom message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: CUSTOM_TYPE, content: "old" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: CUSTOM_TYPE, content: "new" },
      { role: "custom", customType: "other", content: "keep" },
    ];
    const pruned = pruneNoteMessages(messages);
    expect(pruned).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: CUSTOM_TYPE, content: "new" },
      { role: "custom", customType: "other", content: "keep" },
    ]);
  });

  it("is a no-op when no note messages", () => {
    const messages = [{ role: "user" as const }];
    expect(pruneNoteMessages(messages)).toBe(messages);
  });

  it("prunes even when role is missing (role-agnostic match)", () => {
    type Msg = { role?: string; customType?: string; content: string };
    const messages: Msg[] = [
      { customType: CUSTOM_TYPE, content: "old" },
      { customType: CUSTOM_TYPE, content: "new" },
    ];
    const pruned = pruneNoteMessages(messages);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.content).toBe("new");
  });
});
