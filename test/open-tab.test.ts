/**
 * pi-ps — open-tab tests
 *
 * Uses an injectable spawn implementation so the tests never actually
 * launch Windows Terminal tabs or new console windows.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { homedir } from "node:os";
import { openTab, runInWindow, type SpawnImpl } from "../src/open-tab.js";
import type { ResolvedShell } from "../src/shell-resolve.js";

const shell: ResolvedShell = {
  exe: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  version: "7.4.0",
  isPwsh7: true,
};

const CWD = "C:\\dev\\pi-ps";

/** Build a fake spawn that records calls and emits close|error async. */
function makeFake(emit: "close" | "error" = "close") {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const spawnImpl: SpawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const handlers: Record<string, Array<(v: unknown) => void>> = {};
    const handle = {
      on(ev: string, cb: (v: unknown) => void) {
        (handlers[ev] ??= []).push(cb);
        return handle;
      },
      unref() {
        /* noop */
      },
    };
    queueMicrotask(() => {
      if (emit === "error") handlers["error"]?.forEach((f) => f(new Error("boom")));
      else handlers["close"]?.forEach((f) => f(0));
    });
    return handle as never;
  };
  return { spawnImpl, calls };
}

describe("openTab", () => {
  const originalWt = process.env.WT_SESSION;

  beforeEach(() => {
    delete process.env.WT_SESSION;
  });

  afterEach(() => {
    if (originalWt === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = originalWt;
  });

  // ── Windows Terminal path ────────────────────────────────

  it("clone in Windows Terminal opens a tab at the cwd via wt.exe", async () => {
    process.env.WT_SESSION = "session-id";
    const { spawnImpl, calls } = makeFake();

    const res = await openTab({ mode: "clone", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    expect(res.method).toBe("wt");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain("wt.exe");
    expect(calls[0].cmd).toContain("new-tab");
    expect(calls[0].cmd).toContain(`-d "${CWD}"`);
    expect(calls[0].cmd).toContain(shell.exe);
    expect(calls[0].opts.shell).toBe(true);
  });

  it("new in Windows Terminal opens a tab at the standard location (no -d)", async () => {
    process.env.WT_SESSION = "session-id";
    const { spawnImpl, calls } = makeFake();

    const res = await openTab({ mode: "new", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    expect(res.method).toBe("wt");
    expect(calls[0].cmd).toContain("new-tab");
    expect(calls[0].cmd).not.toContain("-d");
    expect(calls[0].cmd).toContain(shell.exe);
  });

  // ── Fallback path (no Windows Terminal) ──────────────────

  it("clone fallback opens a window at cwd via Start-Process", async () => {
    const { spawnImpl, calls } = makeFake();

    const res = await openTab({ mode: "clone", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    expect(res.method).toBe("window");
    expect(calls[0].cmd).toBe(shell.exe);
    expect(calls[0].args).toContain("-NoProfile");
    const psCmd = calls[0].args.join(" ");
    expect(psCmd).toContain("Start-Process");
    expect(psCmd).toContain(`-WorkingDirectory '${CWD}'`);
  });

  it("new fallback opens a window at the user's home directory", async () => {
    const { spawnImpl, calls } = makeFake();

    const res = await openTab({ mode: "new", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    expect(res.method).toBe("window");
    const psCmd = calls[0].args.join(" ");
    expect(psCmd).toContain(`-WorkingDirectory '${homedir()}'`);
  });

  it("reports failure when the spawn emits an error", async () => {
    process.env.WT_SESSION = "session-id";
    const { spawnImpl } = makeFake("error");

    const res = await openTab({ mode: "clone", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("boom");
  });

  it("escapes single quotes in paths for PowerShell", async () => {
    const weirdCwd = "C:\\a'b\\dir";
    const { spawnImpl, calls } = makeFake();

    await openTab({ mode: "clone", cwd: weirdCwd, shell }, spawnImpl);

    const psCmd = calls[0].args.join(" ");
    // Single quote doubled → '' inside the single-quoted string.
    expect(psCmd).toContain(`'C:\\a''b\\dir'`);
  });
});

describe("runInWindow", () => {
  it("launches a visible window via Start-Process -WindowStyle Normal", async () => {
    const { spawnImpl, calls } = makeFake();

    const res = await runInWindow({ command: "npm run dev", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(shell.exe);
    expect(calls[0].args).toContain("-NoProfile");
    const psCmd = calls[0].args.join(" ");
    expect(psCmd).toContain("Start-Process");
    expect(psCmd).toContain("-WindowStyle Normal");
    expect(psCmd).toContain(`-FilePath '${shell.exe}'`);
    expect(psCmd).toContain(`-WorkingDirectory '${CWD}'`);
    // The launcher itself is hidden + detached; the *target* is visible.
    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].opts.windowsHide).toBe(true);
  });

  it("embeds the command in the launched shell's -Command", async () => {
    const { spawnImpl, calls } = makeFake();

    await runInWindow({ command: "npm run dev", cwd: CWD, shell }, spawnImpl);

    const psCmd = calls[0].args.join(" ");
    // The command text is carried through into the nested -Command.
    expect(psCmd).toContain("npm run dev");
    expect(psCmd).toContain("-Command");
  });

  it("keeps a command containing single quotes intact", async () => {
    const { spawnImpl, calls } = makeFake();

    const res = await runInWindow({ command: "echo 'hi'", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(true);
    const psCmd = calls[0].args.join(" ");
    expect(psCmd).toContain("echo");
    expect(psCmd).toContain("hi");
  });

  it("reports failure when the spawn emits an error", async () => {
    const { spawnImpl } = makeFake("error");

    const res = await runInWindow({ command: "npm run dev", cwd: CWD, shell }, spawnImpl);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("boom");
  });
});
