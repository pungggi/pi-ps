import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandHome,
  globalNotePath,
  projectNotePath,
  resolveNotePath,
} from "../src/note/paths.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ps-note-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("expandHome", () => {
  it("expands ~ and ~/", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("leaves absolute paths alone", () => {
    const abs = path.resolve("/tmp/x");
    expect(expandHome(abs)).toBe(abs);
  });
});

describe("resolveNotePath", () => {
  it("prefers PI_PS_NOTE_PATH override", () => {
    const cwd = tmpDir();
    const override = path.join(cwd, "custom.md");
    fs.writeFileSync(override, "hi");
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(projectNotePath(cwd), "project");

    const r = resolveNotePath(cwd, { PI_PS_NOTE_PATH: override });
    expect(r.source).toBe("override");
    expect(r.path).toBe(path.resolve(override));
    expect(r.exists).toBe(true);
  });

  it("prefers project note when it exists", () => {
    const cwd = tmpDir();
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(projectNotePath(cwd), "project body");

    const r = resolveNotePath(cwd, {});
    expect(r.source).toBe("project");
    expect(r.path).toBe(projectNotePath(cwd));
    expect(r.exists).toBe(true);
  });

  it("falls back to global when project missing", () => {
    const cwd = tmpDir();
    const r = resolveNotePath(cwd, {});
    expect(r.source).toBe("global");
    expect(r.path).toBe(globalNotePath());
  });

  it("expands ~ in override", () => {
    const r = resolveNotePath(tmpDir(), { PI_PS_NOTE_PATH: "~/my-note.md" });
    expect(r.path).toBe(path.join(os.homedir(), "my-note.md"));
    expect(r.source).toBe("override");
  });
});
