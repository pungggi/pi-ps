/**
 * pi-ps — Open a new PowerShell tab/window
 *
 * Lets you spin up a fresh PowerShell session beside the running pi
 * process (which is occupying your current terminal):
 *
 *   - `new`   → open at the "standard location"
 *               (Windows Terminal default-profile starting dir,
 *                or the user's home directory in the fallback)
 *   - `clone` → open at pi's current working directory (same path)
 *
 * Host detection:
 *   - Inside Windows Terminal (WT_SESSION set) → `wt.exe new-tab`
 *   - Otherwise → open a new console window via `Start-Process`
 *
 * The spawn implementation is injectable so the unit tests never
 * actually launch tabs/windows.
 */

import { spawn as realSpawn, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import type { ResolvedShell } from "./shell-resolve.js";

export type OpenTabMode = "new" | "clone";

export interface OpenTabOptions {
  mode: OpenTabMode;
  /** pi's current working directory (used when mode === "clone"). */
  cwd: string;
  /** resolved shell to launch (guarantees a PowerShell tab). */
  shell: ResolvedShell;
}

export interface OpenTabResult {
  ok: boolean;
  method: "wt" | "window";
  message: string;
}

/** Minimal child handle used by openTab (subset of ChildProcess). */
interface ChildHandle {
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
  unref(): unknown;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildHandle;

/** Default spawn impl wrapping node's spawn. */
const defaultSpawn: SpawnImpl = (command, args, options) =>
  realSpawn(command, args, options) as unknown as ChildHandle;

/** Quote a token for a cmd.exe double-quoted context (paths have no "). */
function cmdQuote(s: string): string {
  return `"${String(s)}"`;
}

/** Escape a string for safe PowerShell single-quoted interpolation. */
function psSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function openTab(
  opts: OpenTabOptions,
  spawnImpl: SpawnImpl = defaultSpawn,
): Promise<OpenTabResult> {
  return new Promise((resolve) => {
    const inWindowsTerminal = Boolean(process.env.WT_SESSION);
    const clone = opts.mode === "clone";
    const shellExe = opts.shell.exe;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (r: OpenTabResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let method: "wt" | "window";
    let child: ChildHandle;

    if (inWindowsTerminal) {
      // ── Windows Terminal: open a real new tab ───────────────
      method = "wt";
      // -w 0 forces the tab into the most-recently-used window.
      // Without it, wt.exe spawned as a *detached* child (which is how
      // we launch it) opens a brand-new window instead of reusing the
      // current one — see microsoft/terminal#5447. "0" / "last" targets
      // the MRU window, which is the WT window hosting this pi process.
      // shell:true so cmd resolves wt.exe (an app execution alias).
      const argsLine = clone
        ? `-w 0 new-tab -d ${cmdQuote(opts.cwd)} ${cmdQuote(shellExe)}`
        : `-w 0 new-tab ${cmdQuote(shellExe)}`;
      try {
        child = spawnImpl(`wt.exe ${argsLine}`, [], {
          detached: true,
          stdio: "ignore",
          shell: true,
          windowsHide: true,
        });
      } catch (e) {
        return done({
          ok: false,
          method,
          message: `Failed to launch wt.exe: ${(e as Error).message}`,
        });
      }
    } else {
      // ── Fallback: open a new console window ─────────────────
      method = "window";
      const dir = clone ? opts.cwd : homedir();
      const psCommand =
        `Start-Process -FilePath ${psSingleQuote(shellExe)}` +
        ` -WorkingDirectory ${psSingleQuote(dir)}`;
      try {
        child = spawnImpl(shellExe, ["-NoProfile", "-Command", psCommand], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (e) {
        return done({
          ok: false,
          method,
          message: `Failed to launch ${shellExe}: ${(e as Error).message}`,
        });
      }
    }

    const where = clone ? `at: ${opts.cwd}` : "(standard location)";
    const kind = method === "wt" ? "tab" : "window";
    const okMessage = `Opened new PowerShell ${kind} ${where}`;

    child.on("error", (err) =>
      done({ ok: false, method, message: `Failed to open: ${err.message}` }),
    );
    child.on("close", () => done({ ok: true, method, message: okMessage }));

    // Safety net: if the launcher neither errors nor reports close within
    // 2s, assume it launched — the target runs independently of us.
    timer = setTimeout(() => done({ ok: true, method, message: okMessage }), 2000);
    child.unref();
  });
}

// ── Run a command in a new visible window ─────────────────

export interface RunWindowOptions {
  /** Command to execute in the new window. */
  command: string;
  /** Working directory for the new window. */
  cwd: string;
  /** Resolved shell to launch. */
  shell: ResolvedShell;
}

export interface RunWindowResult {
  ok: boolean;
  message: string;
}

/**
 * Run a command in a new, *visible* PowerShell window (detached).
 *
 * Successor to the old run-bg.ps1: `Start-Process -WindowStyle Normal`.
 * The window stays open for as long as the command runs — ideal for dev
 * servers you want to watch live. The launcher itself is hidden and
 * fire-and-forget, independent of the calling pi process.
 *
 * Use `startJob()` (the /ps job subsystem) instead when you want a
 * tracked, hidden job with output captured to a log file.
 */
export function runInWindow(
  opts: RunWindowOptions,
  spawnImpl: SpawnImpl = defaultSpawn,
): Promise<RunWindowResult> {
  return new Promise((resolve) => {
    const shellExe = opts.shell.exe;

    // Argument line handed to the launched shell: run the command, no profile.
    const innerArgs = `-NoProfile -Command ${psSingleQuote(opts.command)}`;

    // Launch a visible window running that shell. Works inside Windows
    // Terminal and in a plain console (opens a new conhost window).
    const psCommand =
      `Start-Process -FilePath ${psSingleQuote(shellExe)}` +
      ` -ArgumentList ${psSingleQuote(innerArgs)}` +
      ` -WorkingDirectory ${psSingleQuote(opts.cwd)}` +
      ` -WindowStyle Normal`;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (r: RunWindowResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let child: ChildHandle;
    try {
      child = spawnImpl(shellExe, ["-NoProfile", "-Command", psCommand], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (e) {
      return done({
        ok: false,
        message: `Failed to launch ${shellExe}: ${(e as Error).message}`,
      });
    }

    const okMessage = `Running in new window at: ${opts.cwd}\n  ${opts.command}`;

    child.on("error", (err) =>
      done({ ok: false, message: `Failed to run: ${err.message}` }),
    );
    child.on("close", () => done({ ok: true, message: okMessage }));

    // Safety net: the launcher is fire-and-forget; if it neither errors nor
    // reports close within 2s, assume the target window launched fine.
    timer = setTimeout(() => done({ ok: true, message: okMessage }), 2000);
    child.unref();
  });
}
