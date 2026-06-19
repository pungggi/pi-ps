/**
 * pi-ps — Local telemetry (opt-in via PI_PS_TELEMETRY=1)
 *
 * Writes to ~/.pi-ps/metrics.jsonl — never network sent.
 * Records: command hash, translation applied y/n, exit code, duration ms.
 * Auto-rotates when file exceeds 5 MB.
 */

import { existsSync, mkdirSync, appendFileSync, statSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const PI_PS_DIR = path.join(os.homedir(), ".pi-ps");
const METRICS_FILE = path.join(PI_PS_DIR, "metrics.jsonl");
const MAX_METRICS_BYTES = 5 * 1024 * 1024; // 5 MB

function isEnabled(): boolean {
  return process.env.PI_PS_TELEMETRY === "1";
}

/**
 * Record a command execution metric.
 * Command text is hashed — never stored in cleartext.
 */
export function recordMetric(params: {
  command: string;
  translated: boolean;
  exitCode: number | null;
  durationMs: number;
}): void {
  if (!isEnabled()) return;

  try {
    if (!existsSync(PI_PS_DIR)) {
      mkdirSync(PI_PS_DIR, { recursive: true });
    }

    // M-5: Rotate if file exceeds limit
    rotateIfNeeded();

    const record = {
      ts: new Date().toISOString(),
      hash: hashCommand(params.command),
      translated: params.translated,
      exitCode: params.exitCode,
      durationMs: params.durationMs,
    };

    appendFileSync(METRICS_FILE, JSON.stringify(record) + "\n", "utf-8");
  } catch { /* best effort — telemetry must never break execution */ }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(METRICS_FILE)) return;
    const size = statSync(METRICS_FILE).size;
    if (size > MAX_METRICS_BYTES) {
      // Keep the most recent half of lines
      const lines = readFileSync(METRICS_FILE, "utf-8")
        .split("\n")
        .filter(Boolean);
      const keep = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(METRICS_FILE, keep.join("\n") + "\n");
    }
  } catch { /* ignore */ }
}

function hashCommand(cmd: string): string {
  return crypto.createHash("sha256").update(cmd).digest("hex").slice(0, 16);
}
