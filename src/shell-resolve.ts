/**
 * pi-ps — Shell resolution module
 *
 * Probe order:
 *   1. $env:PI_PS_EXEC override
 *   2. pwsh.exe in PATH
 *   3. C:\Program Files\PowerShell\7\pwsh.exe
 *   4. Windows PowerShell 5.1 (powershell.exe)
 *
 * Cached per process. Logs version at startup.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface ResolvedShell {
  exe: string;
  version: string;
  isPwsh7: boolean;
}

let _cached: ResolvedShell | null = null;

/**
 * Resolve the PowerShell executable. Returns null if nothing found.
 * Result is cached per process.
 */
export function resolveShell(): ResolvedShell | null {
  if (_cached) return _cached;

  const candidates = buildCandidateList();

  for (const exe of candidates) {
    try {
      if (!existsSync(exe)) continue;
      const version = probeVersion(exe);
      if (!version) continue;
      _cached = { exe, version, isPwsh7: exe.toLowerCase().includes("pwsh") };
      return _cached;
    } catch {
      // try next candidate
    }
  }

  return null;
}

/** Return cached resolution (null if not yet resolved or resolution failed). */
export function getCached(): ResolvedShell | null {
  return _cached;
}

/** Invalidate cache (for testing). */
export function invalidateCache(): void {
  _cached = null;
}

// ── Internal ──────────────────────────────────────────────

function buildCandidateList(): string[] {
  const seen = new Set<string>();
  const list: string[] = [];

  function add(p: string) {
    const normalized = path.resolve(p).toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      list.push(p);
    }
  }

  // 1. Env override
  const envOverride = process.env.PI_PS_EXEC;
  if (envOverride) add(path.resolve(envOverride));

  // 2. PATH lookup via where.exe
  const pathResult = whereLookup("pwsh.exe");
  if (pathResult) add(pathResult);

  // 3. Known install location
  add("C:\\Program Files\\PowerShell\\7\\pwsh.exe");

  // 4. Windows PowerShell 5.1
  add("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

  return list;
}

function whereLookup(exe: string): string | null {
  try {
    const out = execFileSync("where.exe", [exe], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    const first = out.trim().split(/\r?\n/)[0];
    return first && first.length > 0 ? first.trim() : null;
  } catch {
    return null;
  }
}

function probeVersion(exe: string): string | null {
  try {
    const out = execFileSync(
      exe,
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}
