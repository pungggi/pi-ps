/**
 * pi-ps — Diagnostics (pi-ps doctor)
 *
 * Prints pwsh version, resolved path, profile path, execution policy,
 * UTF-8 status, peer dep version, last 10 translations.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { ResolvedShell } from "./shell-resolve.js";

export interface DoctorResult {
  shell: ResolvedShell | null;
  profilePath: string;
  executionPolicy: string;
  utf8Configured: boolean;
  peerDepVersion: string;
  translateMode: string;
  strict: boolean;
  loadProfile: boolean;
  jobsDir: string;
  aliasFile: string;
  lastTranslations: string[];
  warnings: string[];
}

// ── Cached doctor results (L-5) ────────────────────────────

let cachedProfile: string | undefined;
let cachedPolicy: string | undefined;

/**
 * Run diagnostics and return structured result.
 */
export function runDoctor(shell: ResolvedShell | null): DoctorResult {
  const warnings: string[] = [];

  // ── Shell info ──────────────────────────────────────────
  if (!shell) {
    warnings.push("No PowerShell found! Extension is disabled.");
  }

  // ── Profile path (cached) ───────────────────────────────
  if (cachedProfile === undefined) {
    cachedProfile = "";
    if (shell) {
      try {
        cachedProfile = execSync(
          `"${shell.exe}" -NoProfile -NonInteractive -Command "echo $PROFILE"`,
          { encoding: "utf-8", timeout: 5000, windowsHide: true },
        ).trim();
      } catch {
        cachedProfile = "(unable to detect)";
      }
    }
  }
  const profilePath = cachedProfile;

  // ── Execution policy (cached) ───────────────────────────
  if (cachedPolicy === undefined) {
    cachedPolicy = "(unknown)";
    if (shell) {
      try {
        cachedPolicy = execSync(
          `"${shell.exe}" -NoProfile -NonInteractive -Command "Get-ExecutionPolicy"`,
          { encoding: "utf-8", timeout: 5000, windowsHide: true },
        ).trim();
      } catch {
        cachedPolicy = "(unable to detect)";
      }
    }
  }
  const executionPolicy = cachedPolicy;

  // Warn about restrictive policies
  if (executionPolicy === "Restricted" || executionPolicy === "AllSigned") {
    warnings.push(
      `Execution policy is '${executionPolicy}'. Scripts may not run. ` +
      `Consider: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`,
    );
  }

  // ── Peer dep version (M-6: traverse upward) ─────────────
  let peerDepVersion = "(not found)";
  try {
    // Walk up from this file's location to find the package
    const resolved = resolvePeerDepPackage();
    if (resolved) {
      const pkg = JSON.parse(readFileSync(resolved, "utf-8"));
      peerDepVersion = pkg.version ?? "(unknown)";
    }
  } catch { /* ignore */ }

  // ── Last translations ───────────────────────────────────
  const lastTranslations = loadLastTranslations();

  // ── Paths ───────────────────────────────────────────────
  const jobsDir = path.join(os.homedir(), ".pi-ps", "jobs");
  const aliasFile = process.env.PI_PS_ALIAS_FILE ?? path.join(os.homedir(), ".pi-ps", "aliases.json");

  // ── UTF-8 check ─────────────────────────────────────────
  const utf8Configured = process.env.PI_PS_UTF8 !== "0";

  return {
    shell,
    profilePath,
    executionPolicy,
    utf8Configured,
    peerDepVersion,
    translateMode: process.env.PI_PS_TRANSLATE ?? "hint",
    strict: process.env.PI_PS_STRICT === "1",
    loadProfile: process.env.PI_PS_LOAD_PROFILE === "1",
    jobsDir,
    aliasFile,
    lastTranslations,
    warnings,
  };
}

/**
 * Resolve peer dep package.json by walking upward from this file.
 */
function resolvePeerDepPackage(): string | null {
  // Try import.meta.url-based resolution first (works in ESM)
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Format DoctorResult as a readable string.
 */
export function formatDoctor(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push("╔═══════════════════════════════════════════════════════════╗");
  lines.push("║                    pi-ps doctor                          ║");
  lines.push("╚═══════════════════════════════════════════════════════════╝");
  lines.push("");

  if (result.shell) {
    lines.push(`  Shell:        ${result.shell.isPwsh7 ? "pwsh" : "Windows PowerShell"} ${result.shell.version}`);
    lines.push(`  Path:         ${result.shell.exe}`);
  } else {
    lines.push("  Shell:        NOT FOUND ⚠");
  }

  lines.push(`  Profile:      ${result.profilePath}`);
  lines.push(`  Exec Policy:  ${result.executionPolicy}`);
  lines.push(`  UTF-8:        ${result.utf8Configured ? "✓ enabled" : "✗ disabled"}`);
  lines.push(`  Translate:    ${result.translateMode}`);
  lines.push(`  Strict:       ${result.strict ? "on" : "off"}`);
  lines.push(`  Load Profile: ${result.loadProfile ? "on" : "off"}`);
  lines.push(`  Peer Dep:     @earendil-works/pi-coding-agent ${result.peerDepVersion}`);
  lines.push(`  Jobs Dir:     ${result.jobsDir}`);
  lines.push(`  Alias File:   ${result.aliasFile}`);

  if (result.lastTranslations.length > 0) {
    lines.push("");
    lines.push("  Last translations:");
    for (const t of result.lastTranslations) {
      lines.push(`    ${t}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("  ⚠ Warnings:");
    for (const w of result.warnings) {
      lines.push(`    • ${w}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── Translation history ────────────────────────────────────

const PI_PS_DIR = path.join(os.homedir(), ".pi-ps");
const HISTORY_FILE = path.join(PI_PS_DIR, "translation-history.json");
const MAX_HISTORY = 10;

function loadLastTranslations(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const data = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    return (Array.isArray(data) ? data : []).slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

/**
 * Append a translation to the history file.
 */
export function recordTranslation(original: string, translated: string, applied: boolean): void {
  try {
    let history: string[] = [];
    if (existsSync(HISTORY_FILE)) {
      history = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      if (!Array.isArray(history)) history = [];
    }
    history.unshift(`[${applied ? "applied" : "hint"}] ${original} → ${translated}`);
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);

    if (!existsSync(PI_PS_DIR)) {
      mkdirSync(PI_PS_DIR, { recursive: true });
    }
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch { /* best effort */ }
}

// ── Metrics rotation (M-5) ────────────────────────────────

const METRICS_FILE = path.join(PI_PS_DIR, "metrics.jsonl");
const MAX_METRICS_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Rotate metrics file if it exceeds the size limit.
 */
export function rotateMetrics(): void {
  try {
    if (!existsSync(METRICS_FILE)) return;
    const size = statSync(METRICS_FILE).size;
    if (size > MAX_METRICS_BYTES) {
      // Keep last half by reading, truncating, rewriting
      const lines = readFileSync(METRICS_FILE, "utf-8")
        .split("\n")
        .filter(Boolean);
      const keep = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(METRICS_FILE, keep.join("\n") + "\n");
    }
  } catch { /* best effort */ }
}
