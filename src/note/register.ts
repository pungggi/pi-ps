/**
 * Register note feeding on a pi ExtensionAPI.
 *
 * Independent of PowerShell — works even when no shell is resolved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPayload, CUSTOM_TYPE, formatTimestamp, pruneNoteMessages, type BuiltPayload } from "./format.js";
import { formatGitLine, getGitStatus } from "./git.js";
import { clearNote, readNote, writeNote } from "./note-file.js";
import { openInEditor } from "./open-editor.js";
import {
  ensureParentDir,
  globalNotePath,
  projectNotePath,
  resolveNotePath,
  type NoteSource,
  type ResolvedNotePath,
} from "./paths.js";

interface NoteSettings {
  gitEnabled: boolean;
  /** Wake the agent when the note file changes. Default false (silent). */
  triggerTurnOnUpdate: boolean;
}

function loadNoteSettings(env: NodeJS.ProcessEnv = process.env): NoteSettings {
  return {
    gitEnabled: env.PI_PS_NOTE_GIT !== "0",
    triggerTurnOnUpdate: env.PI_PS_NOTE_TRIGGER_TURN === "1",
  };
}

interface RuntimeState {
  cwd: string;
  settings: NoteSettings;
  resolved: ResolvedNotePath;
  payload: BuiltPayload | null;
  gitLine: string | null;
  watcher: fs.FSWatcher | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  gitTimer: ReturnType<typeof setTimeout> | null;
  lastSentContent: string | null;
}

type NoteCtx = ExtensionContext & {
  ui: { notify: (msg: string, type?: "error" | "info" | "warning") => void };
  cwd: string;
};

/**
 * When writing and no override is set, prefer creating the project note
 * so notes stay repo-local.
 */
function preferWritePath(
  cwd: string,
  current: ResolvedNotePath,
): { path: string; source: NoteSource; exists: boolean } {
  if (current.source === "override") {
    return current;
  }
  const project = projectNotePath(cwd);
  return {
    path: project,
    source: "project",
    exists: fs.existsSync(project),
  };
}

export interface NoteApi {
  /** Handle `/note ...` or `/ps note ...` args (without the leading "note"). */
  handleCommand: (args: string, ctx: NoteCtx) => Promise<void>;
}

export function registerNote(pi: ExtensionAPI): NoteApi {
  const settings = loadNoteSettings();
  const state: RuntimeState = {
    cwd: process.cwd(),
    settings,
    resolved: resolveNotePath(process.cwd()),
    payload: null,
    gitLine: null,
    watcher: null,
    refreshTimer: null,
    gitTimer: null,
    lastSentContent: null,
  };

  async function refresh(opts: { reason: string; cwd?: string } = { reason: "manual" }): Promise<BuiltPayload> {
    if (opts.cwd) state.cwd = opts.cwd;
    state.resolved = resolveNotePath(state.cwd);

    const note = readNote(state.resolved.path);

    if (state.settings.gitEnabled) {
      try {
        const status = await getGitStatus(state.cwd);
        state.gitLine = status ? formatGitLine(status) : null;
      } catch {
        state.gitLine = null;
      }
    } else {
      state.gitLine = null;
    }

    const payload = buildPayload({
      body: note.body,
      source: state.resolved.source,
      path: state.resolved.path,
      updatedAt: formatTimestamp(),
      mtime: note.mtime,
      gitLine: state.gitLine,
    });
    state.payload = payload;
    return payload;
  }

  function injectViaSend(
    payload: BuiltPayload,
    opts: { triggerTurn?: boolean } = {},
  ): void {
    if (state.lastSentContent === payload.content && !opts.triggerTurn) {
      return;
    }
    state.lastSentContent = payload.content;

    if (opts.triggerTurn) {
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: payload.content,
          display: true,
          details: payload.details,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } else {
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: payload.content,
          display: true,
          details: payload.details,
        },
        { deliverAs: "nextTurn" },
      );
    }
  }

  function stopWatcher(): void {
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch {
        /* ignore */
      }
      state.watcher = null;
    }
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function startWatcher(ctx: ExtensionContext): void {
    stopWatcher();

    const filePath = state.resolved.path;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);

    try {
      ensureParentDir(filePath);
      state.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        const name = filename == null ? "" : String(filename);
        if (name && name !== base) return;

        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(async () => {
          state.refreshTimer = null;
          try {
            const prev = state.payload?.content;
            const payload = await refresh({ reason: "watch" });
            if (payload.content === prev) return;

            injectViaSend(payload, {
              triggerTurn: state.settings.triggerTurnOnUpdate,
            });
            if (ctx.hasUI) {
              ctx.ui.notify(
                `[pi-ps note] updated ${formatTimestamp()} (${state.resolved.source})`,
                "info",
              );
            }
          } catch {
            /* ignore watch errors */
          }
        }, 150);
      });
    } catch {
      if (ctx.hasUI) {
        ctx.ui.notify(`[pi-ps note] could not watch ${dir}`, "warning");
      }
    }
  }

  function scheduleGitRefresh(ctx: { cwd: string }): void {
    if (!state.settings.gitEnabled) return;
    if (state.gitTimer) clearTimeout(state.gitTimer);
    state.gitTimer = setTimeout(async () => {
      state.gitTimer = null;
      try {
        const prevGit = state.gitLine;
        const status = await getGitStatus(ctx.cwd);
        const nextGit = status ? formatGitLine(status) : null;
        if (nextGit === prevGit) return;
        state.gitLine = nextGit;
        const note = readNote(state.resolved.path);
        state.payload = buildPayload({
          body: note.body,
          source: state.resolved.source,
          path: state.resolved.path,
          updatedAt: formatTimestamp(),
          mtime: note.mtime,
          gitLine: state.gitLine,
        });
      } catch {
        /* ignore */
      }
    }, 200);
  }

  // ── Events ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state.cwd = ctx.cwd;
    const payload = await refresh({ reason: "session_start", cwd: ctx.cwd });
    injectViaSend(payload);
    startWatcher(ctx);

    if (ctx.hasUI) {
      const bits = [`[pi-ps note] ${state.resolved.source}`, state.resolved.path];
      if (payload.details.hasBody) bits.push("note");
      if (payload.details.hasGit) bits.push("git");
      ctx.ui.notify(bits.join(" · "), "info");
    }
  });

  pi.on("session_shutdown", async () => {
    stopWatcher();
    if (state.gitTimer) {
      clearTimeout(state.gitTimer);
      state.gitTimer = null;
    }
    state.payload = null;
    state.lastSentContent = null;
  });

  pi.on("before_agent_start", async () => {
    const note = readNote(state.resolved.path);
    const payload = buildPayload({
      body: note.body,
      source: state.resolved.source,
      path: state.resolved.path,
      updatedAt: formatTimestamp(),
      mtime: note.mtime,
      gitLine: state.gitLine,
    });
    state.payload = payload;

    return {
      message: {
        customType: CUSTOM_TYPE,
        content: payload.content,
        display: true,
        details: payload.details,
      },
    };
  });

  pi.on("context", async (event) => {
    const messages = pruneNoteMessages(
      event.messages as Array<{ role?: string; customType?: string }>,
    );
    return { messages: messages as typeof event.messages };
  });

  pi.on("tool_result", async (_event, ctx) => {
    scheduleGitRefresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    scheduleGitRefresh(ctx);
  });

  // ── Command handler ───────────────────────────────────────

  async function handleCommand(args: string, ctx: NoteCtx): Promise<void> {
    const trimmed = args.trim();
    const space = trimmed.indexOf(" ");
    const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : trimmed.slice(space + 1);

    switch (sub) {
      case "":
      case "show": {
        const payload = state.payload ?? (await refresh({ reason: "show", cwd: ctx.cwd }));
        ctx.ui.notify(payload.content, "info");
        break;
      }

      case "set": {
        if (!rest.trim()) {
          ctx.ui.notify("Usage: /note set <text>", "error");
          break;
        }
        const target = preferWritePath(ctx.cwd, state.resolved);
        const note = writeNote(target.path, rest);
        state.resolved = target;
        const payload = await refresh({ reason: "set", cwd: ctx.cwd });
        state.lastSentContent = null;
        injectViaSend(payload);
        startWatcher(ctx);
        ctx.ui.notify(
          `[pi-ps note] set (${target.source}) · ${note.mtime ?? formatTimestamp()}\n${payload.content}`,
          "info",
        );
        break;
      }

      case "append": {
        if (!rest.trim()) {
          ctx.ui.notify("Usage: /note append <text>", "error");
          break;
        }
        const target = preferWritePath(ctx.cwd, state.resolved);
        const existing = readNote(target.path).body;
        const merged = existing ? `${existing}\n${rest}` : rest;
        writeNote(target.path, merged);
        state.resolved = target;
        const payload = await refresh({ reason: "append", cwd: ctx.cwd });
        state.lastSentContent = null;
        injectViaSend(payload);
        startWatcher(ctx);
        ctx.ui.notify(`[pi-ps note] appended (${target.source})`, "info");
        break;
      }

      case "clear": {
        const target = preferWritePath(ctx.cwd, state.resolved);
        clearNote(target.path);
        state.resolved = target;
        const payload = await refresh({ reason: "clear", cwd: ctx.cwd });
        state.lastSentContent = null;
        injectViaSend(payload);
        ctx.ui.notify(`[pi-ps note] cleared (${target.source})`, "info");
        break;
      }

      case "edit": {
        const target = preferWritePath(ctx.cwd, state.resolved);
        state.resolved = target;
        const result = openInEditor(target.path);
        startWatcher(ctx);
        ctx.ui.notify(
          result.ok
            ? `[pi-ps note] ${result.message}\n  ${target.path}\n  Save the file — pi-ps will pick it up.`
            : `[pi-ps note] ${result.message}`,
          result.ok ? "info" : "error",
        );
        break;
      }

      case "path": {
        const r = resolveNotePath(ctx.cwd);
        const project = projectNotePath(ctx.cwd);
        const global = globalNotePath();
        ctx.ui.notify(
          [
            `[pi-ps note] active: ${r.source}`,
            `  ${r.path}${r.exists ? "" : "  (missing)"}`,
            `project: ${project}${fs.existsSync(project) ? "" : "  (missing)"}`,
            `global:  ${global}${fs.existsSync(global) ? "" : "  (missing)"}`,
            process.env.PI_PS_NOTE_PATH
              ? `override PI_PS_NOTE_PATH=${process.env.PI_PS_NOTE_PATH}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        break;
      }

      case "reload": {
        const payload = await refresh({ reason: "reload", cwd: ctx.cwd });
        state.lastSentContent = null;
        injectViaSend(payload);
        startWatcher(ctx);
        ctx.ui.notify(`[pi-ps note] reloaded · ${payload.details.updatedAt}`, "info");
        break;
      }

      case "git": {
        const mode = rest.trim().toLowerCase();
        if (mode === "on") {
          state.settings.gitEnabled = true;
          await refresh({ reason: "git-on", cwd: ctx.cwd });
          ctx.ui.notify("[pi-ps note] git block ON", "info");
        } else if (mode === "off") {
          state.settings.gitEnabled = false;
          await refresh({ reason: "git-off", cwd: ctx.cwd });
          ctx.ui.notify("[pi-ps note] git block OFF", "info");
        } else {
          ctx.ui.notify(
            `[pi-ps note] git: ${state.settings.gitEnabled ? "ON" : "OFF"} (use /note git on|off)`,
            "info",
          );
        }
        break;
      }

      default: {
        ctx.ui.notify(
          `[pi-ps note] Unknown subcommand: ${sub}\n` +
            "Available: show, set, append, clear, edit, path, reload, git",
          "warning",
        );
      }
    }
  }

  pi.registerCommand("note", {
    description: "note: show | set <text> | append <text> | clear | edit | path | reload | git on|off",
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  return { handleCommand };
}
