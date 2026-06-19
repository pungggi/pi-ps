/**
 * pi-ps — Background job runner
 *
 * Replaces run-bg.ps1. Manages background processes with proper
 * quoting, PID tracking, and log files.
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolvedShell } from "../shell-resolve.js";

// ── Types ──────────────────────────────────────────────────

export interface JobInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  logPath: string;
  status: "running" | "exited" | "killed";
  exitCode?: number;
}

// ── Config ─────────────────────────────────────────────────

const JOBS_DIR = path.join(os.homedir(), ".pi-ps", "jobs");

function ensureJobsDir(): string {
  if (!existsSync(JOBS_DIR)) {
    mkdirSync(JOBS_DIR, { recursive: true });
  }
  return JOBS_DIR;
}

// ── Public API ─────────────────────────────────────────────

let jobCounter = Date.now();

/**
 * Start a command in the background.
 * Returns the JobInfo for the started process.
 */
export function startJob(
  shell: ResolvedShell,
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): JobInfo {
  const jobsDir = ensureJobsDir();
  const id = `job-${++jobCounter}`;
  const logPath = path.join(jobsDir, `${id}.log`);

  const info: JobInfo = {
    id,
    pid: 0,
    command,
    cwd,
    startedAt: new Date().toISOString(),
    logPath,
    status: "running",
  };

  // Spawn a detached background process directly
  const bgChild = spawn(shell.exe, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], {
    cwd,
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    detached: true,
  });

  info.pid = bgChild.pid ?? 0;
  bgChild.unref();

  // Pipe output to log file
  try {
    const logStream = createWriteStream(logPath, { flags: "a" });
    bgChild.stdout?.pipe(logStream);
    bgChild.stderr?.pipe(logStream);
  } catch { /* best effort */ }

  bgChild.on("close", (code) => {
    info.status = "exited";
    info.exitCode = code ?? 0;
    saveJobInfo(info);
  });

  saveJobInfo(info);
  return info;
}

/**
 * List all tracked jobs.
 */
export function listJobs(): JobInfo[] {
  const jobsDir = ensureJobsDir();
  const jobs: JobInfo[] = [];

  try {
    const files = readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = readFileSync(path.join(jobsDir, f), "utf-8");
        const info = JSON.parse(raw) as JobInfo;
        jobs.push(info);
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir might not exist yet */ }

  return jobs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get log contents for a job.
 */
export function getJobLog(id: string): string | null {
  const info = findJob(id);
  if (!info) return null;
  try {
    return readFileSync(info.logPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Kill a job by ID.
 */
export function killJob(id: string): boolean {
  const info = findJob(id);
  if (!info || info.status !== "running" || !info.pid) return false;

  // CR-1: validate PID is a positive integer
  if (!Number.isInteger(info.pid) || info.pid <= 0) return false;

  try {
    execSync(`taskkill /T /F /PID ${info.pid}`, { windowsHide: true });
    info.status = "killed";
    saveJobInfo(info);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up stale job files.
 */
export function cleanupJobs(maxAge = 24 * 60 * 60 * 1000): number {
  const jobsDir = ensureJobsDir();
  let removed = 0;
  const now = Date.now();

  try {
    const files = readdirSync(jobsDir);
    for (const f of files) {
      const filePath = path.join(jobsDir, f);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (now - mtime > maxAge) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir might not exist */ }

  return removed;
}

// ── Internal ───────────────────────────────────────────────

function findJob(id: string): JobInfo | null {
  const jobsDir = ensureJobsDir();
  const filePath = path.join(jobsDir, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as JobInfo;
  } catch {
    return null;
  }
}

function saveJobInfo(info: JobInfo): void {
  const jobsDir = ensureJobsDir();
  const filePath = path.join(jobsDir, `${info.id}.json`);
  writeFileSync(filePath, JSON.stringify(info, null, 2), "utf-8");
}
