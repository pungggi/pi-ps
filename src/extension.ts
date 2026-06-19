/**
 * pi-ps — PowerShell extension for pi (v2)
 *
 * Robust, tested, opinionated PowerShell routing for pi on Windows.
 * Replaces the old pi-powershell regex-based translator with a
 * token-based parser, structured diagnostics, background jobs,
 * and local telemetry.
 *
 * Install:
 *   pi install ./pi-ps
 *   (or) pi -e ./src/extension.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveShell, type ResolvedShell } from "./shell-resolve.js";
import { createExecOps } from "./ps-exec.js";
import { translate, type TranslateMode } from "./translator/index.js";
import { startJob, listJobs, getJobLog, killJob, cleanupJobs } from "./jobs/runner.js";
import { runDoctor, formatDoctor, recordTranslation } from "./diagnostics.js";
import { recordMetric } from "./telemetry.js";
import { openTab, runInWindow } from "./open-tab.js";

// ── Settings ───────────────────────────────────────────────

interface PsSettings {
  executable: string;
  translate: TranslateMode;
  strict: boolean;
  utf8: boolean;
  killTreeOnAbort: boolean;
  aliasFile: string;
}

/** H-4: simplified — single source of truth for env var reading */
function loadSettings(_pi: ExtensionAPI): PsSettings {
  const rawMode = process.env.PI_PS_TRANSLATE;
  const translate: TranslateMode =
    rawMode === "off" || rawMode === "hint" || rawMode === "auto" ? rawMode : "hint";

  return {
    executable: "auto",
    translate,
    strict: process.env.PI_PS_STRICT === "1",
    utf8: process.env.PI_PS_UTF8 !== "0",
    killTreeOnAbort: process.env.PI_PS_KILL_TREE !== "0",
    aliasFile: process.env.PI_PS_ALIAS_FILE ?? "~/.pi-ps/aliases.json",
  };
}

// ── Extension Entry ────────────────────────────────────────

export default function piPsExtension(pi: ExtensionAPI): void {
  const settings = loadSettings(pi);

  // ── Resolve shell ────────────────────────────────────────
  const shell = resolveShell();

  if (!shell) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        "[pi-ps][error] No PowerShell found. pi-ps disabled.\n" +
        "Set PI_PS_EXEC to your pwsh.exe path or install PowerShell 7+.",
        "error",
      );
    });
    return;
  }

  // Log version at startup
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `[pi-ps] ${shell.isPwsh7 ? "pwsh" : "Windows PowerShell"} ${shell.version} at ${shell.exe}`,
      "info",
    );
  });

  // ── Register user_bash handler ──────────────────────────
  const execOps = createExecOps(
    shell,
    settings.translate,
    settings.strict,
    settings.utf8,
    settings.killTreeOnAbort,
  );

  pi.on("user_bash", (_event, _ctx) => {
    return { operations: execOps };
  });

  // ── Register commands ───────────────────────────────────

  pi.registerCommand("pi-ps", {
    description: "pi-ps: show status, doctor, translate, exec, new/clone tab, job management",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "";

      switch (sub) {
        case "":
        case "status": {
          ctx.ui.notify(
            `[pi-ps] ${shell.isPwsh7 ? "pwsh" : "Windows PowerShell"} ${shell.version}\n` +
            `  Translate: ${settings.translate}\n` +
            `  Strict: ${settings.strict}\n` +
            `  UTF-8: ${settings.utf8}\n` +
            `  Kill tree: ${settings.killTreeOnAbort}\n` +
            `  Use /pi-ps doctor for full diagnostics.`,
            "info",
          );
          break;
        }

        case "doctor": {
          const result = runDoctor(shell);
          ctx.ui.notify(formatDoctor(result), "info");
          break;
        }

        case "translate": {
          const cmd = parts.slice(1).join(" ");
          if (!cmd) {
            ctx.ui.notify("Usage: /pi-ps translate \"<bash command>\"", "error");
            break;
          }
          const tResult = translate(cmd, "auto");
          if (tResult.translated) {
            ctx.ui.notify(
              `[pi-ps] Translation:\n  ${cmd}\n  → ${tResult.command}`,
              "info",
            );
            recordTranslation(cmd, tResult.command, true);
          } else {
            ctx.ui.notify(
              `[pi-ps] No translation needed (already PS-native or unrecognized)`,
              "info",
            );
          }
          break;
        }

        case "exec": {
          const cmd = parts.slice(1).join(" ");
          if (!cmd) {
            ctx.ui.notify("Usage: /pi-ps exec \"<command>\"", "error");
            break;
          }
          // H-6: use execOps which streams through pi's onData pipeline
          const startTime = Date.now();
          const outputChunks: Buffer[] = [];
          execOps.exec(cmd, ctx.cwd, {
            onData: (data) => { outputChunks.push(data); },
            signal: ctx.signal,
          }).then((result) => {
            const duration = Date.now() - startTime;
            recordMetric({ command: cmd, translated: false, exitCode: result.exitCode, durationMs: duration });

            // Show output as a single notify
            const output = Buffer.concat(outputChunks).toString("utf-8").trim();
            if (output) {
              ctx.ui.notify(`[pi-ps] ${output}`, "info");
            }
            ctx.ui.notify(
              `[pi-ps] Exit code: ${result.exitCode ?? "killed"}`,
              result.exitCode === 0 ? "info" : "warning",
            );
          });
          break;
        }

        case "new":
        case "clone": {
          const result = await openTab({ mode: sub, cwd: ctx.cwd, shell });
          ctx.ui.notify(`[pi-ps] ${result.message}`, result.ok ? "info" : "error");
          break;
        }

        case "run": {
          const cmd = parts.slice(1).join(" ");
          if (!cmd) {
            ctx.ui.notify('Usage: /pi-ps run "<command>"  (opens a live window)', "error");
            break;
          }
          const result = await runInWindow({ command: cmd, cwd: ctx.cwd, shell });
          ctx.ui.notify(`[pi-ps] ${result.message}`, result.ok ? "info" : "error");
          break;
        }

        case "job": {
          handleJobCommand(parts.slice(1), ctx, shell);
          break;
        }

        default: {
          ctx.ui.notify(
            `[pi-ps] Unknown subcommand: ${sub}\n` +
            `Available: status, doctor, translate, exec, new, clone, run, job`,
            "warning",
          );
        }
      }
    },
  });

  // ── Job subcommand handler ──────────────────────────────

  function handleJobCommand(
    parts: string[],
    ctx: { cwd: string; ui: { notify: (msg: string, type?: "error" | "info" | "warning") => void } },
    shell: ResolvedShell,
  ): void {
    const sub = parts[0] ?? "list";

    switch (sub) {
      case "start": {
        const cmd = parts.slice(1).join(" ");
        if (!cmd) {
          ctx.ui.notify('Usage: /pi-ps job start "<command>"', "error");
          return;
        }
        const info = startJob(shell, cmd, ctx.cwd);
        ctx.ui.notify(
          `[pi-ps] Started job ${info.id} (PID ${info.pid})\n` +
          `  Command: ${cmd}\n` +
          `  Log:  /pi-ps job log ${info.id}\n` +
          `  Stop: /pi-ps job kill ${info.id}`,
          "info",
        );
        break;
      }

      case "list": {
        const jobs = listJobs();
        if (jobs.length === 0) {
          ctx.ui.notify("[pi-ps] No background jobs.", "info");
          return;
        }
        const lines = jobs.map((j) => {
          const status = j.status === "running" ? "●" : j.status === "killed" ? "✗" : "✓";
          return `  ${status} ${j.id}  PID:${j.pid}  ${j.command.slice(0, 60)}`;
        });
        ctx.ui.notify(`[pi-ps] Jobs:\n${lines.join("\n")}`, "info");
        break;
      }

      case "log": {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /pi-ps job log <id>", "error");
          return;
        }
        const log = getJobLog(id);
        if (log === null) {
          ctx.ui.notify(`[pi-ps] Job ${id} not found or no log available.`, "warning");
          return;
        }
        ctx.ui.notify(`[pi-ps] Log for ${id}:\n${log || "(empty)"}`, "info");
        break;
      }

      case "kill": {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /pi-ps job kill <id>", "error");
          return;
        }
        const ok = killJob(id);
        ctx.ui.notify(
          ok ? `[pi-ps] Job ${id} killed.` : `[pi-ps] Failed to kill ${id} (not running or not found).`,
          ok ? "info" : "error",
        );
        break;
      }

      case "cleanup": {
        const removed = cleanupJobs();
        ctx.ui.notify(`[pi-ps] Cleaned up ${removed} stale job file(s).`, "info");
        break;
      }

      default:
        ctx.ui.notify(
          `[pi-ps] Unknown job subcommand: ${sub}\nAvailable: start, list, log, kill, cleanup`,
          "warning",
        );
    }
  }
}
