/**
 * Compact plain-text git status for LLM context.
 */

import { execFile } from "node:child_process";

export interface GitStatus {
  branch: string;
  upstream: string | null;
  aheadBy: number;
  behindBy: number;
  upstreamGone: boolean;
  indexAdded: number;
  indexModified: number;
  indexDeleted: number;
  indexUnmerged: number;
  workingAdded: number;
  workingModified: number;
  workingDeleted: number;
  workingUnmerged: number;
  stashCount: number;
}

type RunGit = (cwd: string, args: string[]) => Promise<string | null>;

const defaultRunGit: RunGit = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout);
      },
    );
  });

/** Parse `git status --porcelain=2 --branch` output into structured status. */
export function parsePorcelainV2(statusResult: string): Omit<GitStatus, "stashCount" | "upstreamGone"> {
  const lines = statusResult.split("\n");

  let branch = "";
  let upstream: string | null = null;
  let aheadBy = 0;
  let behindBy = 0;
  let indexAdded = 0;
  let indexModified = 0;
  let indexDeleted = 0;
  let indexUnmerged = 0;
  let workingAdded = 0;
  let workingModified = 0;
  let workingDeleted = 0;
  let workingUnmerged = 0;

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const parts = line.slice("# branch.ab ".length).split(" ");
      aheadBy = parseInt(parts[0] ?? "0", 10) || 0;
      behindBy = Math.abs(parseInt(parts[1] ?? "0", 10) || 0);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const x = line.charAt(2);
      const y = line.charAt(3);
      countIndex(x);
      countWorking(y);
    } else if (line.startsWith("? ")) {
      workingAdded++;
    } else if (line.startsWith("u ")) {
      const x = line.charAt(2);
      const y = line.charAt(3);
      countIndex(x);
      countWorking(y);
    }
  }

  function countIndex(x: string): void {
    if (x === "A") indexAdded++;
    else if (x === "M" || x === "R" || x === "C") indexModified++;
    else if (x === "D") indexDeleted++;
    else if (x === "U") indexUnmerged++;
  }

  function countWorking(y: string): void {
    if (y === "A" || y === "?") workingAdded++;
    else if (y === "M") workingModified++;
    else if (y === "D") workingDeleted++;
    else if (y === "U") workingUnmerged++;
  }

  return {
    branch,
    upstream,
    aheadBy,
    behindBy,
    indexAdded,
    indexModified,
    indexDeleted,
    indexUnmerged,
    workingAdded,
    workingModified,
    workingDeleted,
    workingUnmerged,
  };
}

export async function getGitStatus(
  cwd: string,
  runGit: RunGit = defaultRunGit,
): Promise<GitStatus | null> {
  const statusResult = await runGit(cwd, [
    "status",
    "--porcelain=2",
    "--branch",
    "--no-renames",
    "-unormal",
  ]);
  if (!statusResult) return null;

  const parsed = parsePorcelainV2(statusResult);
  let branch = parsed.branch;
  if (branch === "(detached)") {
    const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
    branch = sha ? `(${sha.trim()})` : "(detached)";
  }

  let upstreamGone = false;
  if (parsed.upstream) {
    const rev = await runGit(cwd, ["rev-parse", "--verify", parsed.upstream]);
    if (!rev) upstreamGone = true;
  }

  let stashCount = 0;
  const stashResult = await runGit(cwd, ["stash", "list"]);
  if (stashResult?.trim()) {
    stashCount = stashResult.trim().split("\n").length;
  }

  return { ...parsed, branch, upstreamGone, stashCount };
}

/** Single-line colorless summary suitable for LLM context. */
export function formatGitLine(status: GitStatus): string {
  const hasIndex =
    status.indexAdded > 0 ||
    status.indexModified > 0 ||
    status.indexDeleted > 0 ||
    status.indexUnmerged > 0;
  const hasWorking =
    status.workingAdded > 0 ||
    status.workingModified > 0 ||
    status.workingDeleted > 0 ||
    status.workingUnmerged > 0;

  const parts: string[] = ["git:", status.branch || "?"];

  if (status.upstream && status.upstreamGone) {
    parts.push("×");
  } else if (status.upstream && status.behindBy === 0 && status.aheadBy === 0) {
    parts.push("≡");
  } else if (status.upstream) {
    if (status.behindBy > 0) parts.push(`↓${status.behindBy}`);
    if (status.aheadBy > 0) parts.push(`↑${status.aheadBy}`);
  }

  if (hasIndex) {
    let index = `+${status.indexAdded} ~${status.indexModified} -${status.indexDeleted}`;
    if (status.indexUnmerged > 0) index += ` !${status.indexUnmerged}`;
    parts.push(index);
  }

  if (hasIndex && hasWorking) parts.push("|");

  if (hasWorking) {
    let working = `+${status.workingAdded} ~${status.workingModified} -${status.workingDeleted}`;
    if (status.workingUnmerged > 0) working += ` !${status.workingUnmerged}`;
    parts.push(working);
    parts.push("!");
  } else if (hasIndex) {
    parts.push("~");
  } else {
    parts.push("clean");
  }

  if (status.stashCount > 0) {
    parts.push(`stash:${status.stashCount}`);
  }

  return parts.join(" ");
}
