/**
 * pi-ps — PowerShell execution engine
 *
 * Spawns pwsh with proper flags, UTF-8 prefix, optional strict mode,
 * and kill-tree on abort.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { ResolvedShell } from "./shell-resolve.js";
import { translate } from "./translator/index.js";

// ── Types ──────────────────────────────────────────────────

export interface PsExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** Translation mode: off | hint | auto */
  translateMode: "off" | "hint" | "auto";
  /** Enable $ErrorActionPreference = 'Stop' */
  strict: boolean;
  /** Enable UTF-8 prefix */
  utf8: boolean;
  /** Kill entire process tree on abort (taskkill /T /F) */
  killTreeOnAbort: boolean;
}

export interface PsExecResult {
  exitCode: number | null;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Execute a command through PowerShell, returning operations that
 * conform to pi's BashOperations interface.
 */
export function exec(
  shell: ResolvedShell,
  command: string,
  cwd: string,
  options: PsExecOptions,
): Promise<PsExecResult> {
  return new Promise((resolve) => {
    // ── Translation ───────────────────────────────────────
    const tResult = translate(command, options.translateMode);
    const effectiveCommand = tResult.command;

    // Emit hints/rewrites to stderr via onData
    if (tResult.hint) {
      options.onData(Buffer.from(`[pi-ps][translate] ${tResult.hint}\n`));
    }
    if (tResult.warning) {
      options.onData(Buffer.from(`[pi-ps][warn] ${tResult.warning}\n`));
    }

    // ── Build PS command string ────────────────────────────
    const parts: string[] = [];

    if (options.utf8) {
      parts.push(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "$OutputEncoding = [System.Text.Encoding]::UTF8;",
      );
    }

    if (options.strict || process.env.PI_PS_STRICT === "1") {
      parts.push("$ErrorActionPreference = 'Stop';");
    }

    parts.push(effectiveCommand);
    const psCommand = parts.join(" ");

    // ── Spawn ──────────────────────────────────────────────
    const args = ["-NoProfile", "-NonInteractive", "-Command", psCommand];

    if (process.env.PI_PS_LOAD_PROFILE === "1") {
      const idx = args.indexOf("-NoProfile");
      if (idx >= 0) args.splice(idx, 1);
    }

    const child = spawn(shell.exe, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code });
    };

    child.stdout?.on("data", (data: Buffer) => options.onData(data));
    child.stderr?.on("data", (data: Buffer) => options.onData(data));

    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code));

    // ── Timeout ────────────────────────────────────────────
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        killTree(child, options.killTreeOnAbort);
        finish(null);
      }, options.timeout * 1000);
    }

    // ── Abort signal ───────────────────────────────────────
    const onAbort = () => {
      killTree(child, options.killTreeOnAbort);
      finish(null);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

// ── Kill tree ──────────────────────────────────────────────

function killTree(child: ChildProcess, useTreeKill: boolean): void {
  if (!child.pid) return;
  // CR-1: validate PID is a positive integer before interpolation
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;

  try {
    if (useTreeKill) {
      execSync(`taskkill /T /F /PID ${child.pid}`, {
        windowsHide: true,
        timeout: 3000,
      });
    } else {
      child.kill();
    }
  } catch {
    try { child.kill(); } catch { /* best effort */ }
  }
}

/**
 * Build BashOperations-compatible exec function bound to a shell.
 */
export function createExecOps(
  shell: ResolvedShell,
  translateMode: "off" | "hint" | "auto",
  strict: boolean,
  utf8: boolean,
  killTreeOnAbort: boolean,
) {
  return {
    exec(
      command: string,
      cwd: string,
      opts: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number | null }> {
      return exec(shell, command, cwd, {
        ...opts,
        translateMode,
        strict,
        utf8,
        killTreeOnAbort,
      });
    },
  };
}
