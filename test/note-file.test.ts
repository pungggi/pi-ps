import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearNote, readNote, writeNote } from "../src/note/note-file.js";

const tmpDirs: string[] = [];

function tmpFile(name = "note.md"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ps-note-"));
  tmpDirs.push(d);
  return path.join(d, "sub", name);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("readNote / writeNote", () => {
  it("returns empty for missing file", () => {
    const p = tmpFile();
    const n = readNote(p);
    expect(n.exists).toBe(false);
    expect(n.body).toBe("");
    expect(n.mtime).toBeNull();
  });

  it("writes, creates parents, and reads back", () => {
    const p = tmpFile();
    const written = writeNote(p, "hello\nworld");
    expect(written.exists).toBe(true);
    expect(written.body).toBe("hello\nworld");
    expect(written.mtime).toMatch(/^\d{4}-/);
    expect(fs.readFileSync(p, "utf8")).toBe("hello\nworld\n");
  });

  it("strips trailing newlines on read", () => {
    const p = tmpFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x\n\n\n");
    expect(readNote(p).body).toBe("x");
  });

  it("clearNote empties the file", () => {
    const p = tmpFile();
    writeNote(p, "stuff");
    const cleared = clearNote(p);
    expect(cleared.body).toBe("");
    expect(cleared.exists).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("");
  });
});
