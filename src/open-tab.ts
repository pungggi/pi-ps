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
      // shell:true so cmd resolves wt.exe (an app execution alias).
      const argsLine = clone
        ? `new-tab -d ${cmdQuote(opts.cwd)} ${cmdQuote(shellExe)}`
        : `new-tab ${cmdQuote(shellExe)}`;
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
