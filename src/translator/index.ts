/**
 * pi-ps — Token-based bash-to-PowerShell translator
 *
 * Replaces the fragile regex approach with a proper tokenizer that
 * handles quoted args, pipes, redirections, and subshells.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type TranslateMode = "off" | "hint" | "auto";

export interface TranslationResult {
  /** The command to actually run */
  command: string;
  /** Non-blocking tip to show in stderr (hint mode) */
  hint?: string;
  /** Warning message (e.g. untranslated construct) */
  warning?: string;
  /** Whether any translation was applied */
  translated: boolean;
}

// ── Token types (L-6: removed dead "eol" and "subshell" types) ──

interface Token {
  type: "word" | "pipe" | "redirect" | "semicolon" | "and" | "or" | "bg";
  value: string;
}

// ── Public API ─────────────────────────────────────────────

export function translate(input: string, mode: TranslateMode): TranslationResult {
  const noChange: TranslationResult = { command: input, translated: false };

  if (mode === "off") return noChange;

  // Skip if already PS-native
  if (isPwshNative(input)) return noChange;

  const tokens = tokenize(input);
  const rewritten = rewriteTokens(tokens);

  if (!rewritten.translated) return noChange;

  if (mode === "hint") {
    return {
      command: input, // run original
      hint: `tip: ${rewritten.command}`,
      translated: false,
    };
  }

  // mode === "auto"
  return {
    command: rewritten.command,
    hint: `translated: ${input} → ${rewritten.command}`,
    translated: true,
  };
}

// ── Pwsh-native detection ──────────────────────────────────

function isPwshNative(cmd: string): boolean {
  const trimmed = cmd.trimStart();
  // Verb-Noun pattern (e.g. Get-ChildItem)
  if (/^[A-Z][a-z]+-[A-Z]/.test(trimmed)) return true;
  // $-prefixed expression
  if (/^\$[a-zA-Z_]/.test(trimmed)) return true;
  // Call operator or dot-source
  if (/^[&.]\s/.test(trimmed)) return true;
  // PS built-in aliases that are NOT bash commands — only PS-specific short forms
  // NOTE: ls, cat, echo, cls are also bash commands — do NOT match them here
  if (/^(gci|gc|sc|ni|ri|copy|move|write)\b/i.test(trimmed)) return true;
  // Full cmdlet in first word
  const firstWord = trimmed.split(/\s/)[0] ?? "";
  if (/^[A-Z][a-z]+-[A-Z]/.test(firstWord)) return true;
  return false;
}

// ── Tokenizer ──────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const peek = () => input[pos] ?? null;
  const advance = () => input[pos++];

  function readQuoted(quote: string): string {
    let buf = quote;
    advance(); // skip opening quote
    while (pos < input.length) {
      const ch = advance()!;
      buf += ch;
      if (ch === "\\" && peek() === quote) {
        buf += advance()!;
        continue;
      }
      if (ch === quote) break;
    }
    return buf;
  }

  function readWord(): string {
    let buf = "";
    while (pos < input.length) {
      const ch = peek()!;
      if (ch === " " || ch === "\t") break;
      if (ch === "'" || ch === '"') {
        buf += readQuoted(ch);
        continue;
      }
      if (ch === "|" || ch === ";" || ch === "&" || ch === ">" || ch === "<") break;
      if (ch === "(" && buf.length > 0 && buf.endsWith("$")) {
        // subshell $(...)
        buf += readSubshell();
        continue;
      }
      buf += advance()!;
    }
    return buf;
  }

  function readSubshell(): string {
    let buf = "";
    advance(); // skip (
    let depth = 1;
    while (pos < input.length && depth > 0) {
      const ch = advance()!;
      buf += ch;
      if (ch === "(") depth++;
      if (ch === ")") depth--;
    }
    return buf;
  }

  function skipWhitespace(): void {
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }
  }

  while (pos < input.length) {
    skipWhitespace();
    if (pos >= input.length) break;

    const ch = peek()!;

    if (ch === ";") {
      advance();
      tokens.push({ type: "semicolon", value: ";" });
      continue;
    }

    if (ch === "&") {
      advance();
      if (peek() === "&") {
        advance();
        tokens.push({ type: "and", value: "&&" });
        continue;
      }
      tokens.push({ type: "bg", value: "&" });
      continue;
    }

    if (ch === "|") {
      advance();
      if (peek() === "|") {
        advance();
        tokens.push({ type: "or", value: "||" });
        continue;
      }
      tokens.push({ type: "pipe", value: "|" });
      continue;
    }

    // Handle 2>&1, 2>, 2>> before word token reads '2' as part of a word
    if (ch === "2" && pos + 1 < input.length && input[pos + 1] === ">") {
      advance(); advance();
      let redir = "2>";
      if (peek() === ">") {
        advance();
        redir = "2>>";
      } else if (peek() === "&") {
        advance();
        redir = "2>&1";
      }
      tokens.push({ type: "redirect", value: redir });
      continue;
    }

    if (ch === ">") {
      advance();
      let redir = ">";
      if (peek() === ">") {
        advance();
        redir = ">>";
      } else if (peek() === "&") {
        advance();
        redir = ">&";
      }
      tokens.push({ type: "redirect", value: redir });
      continue;
    }

    // Default: read a word token
    const word = readWord();
    if (word.length > 0) {
      tokens.push({ type: "word", value: word });
    }
  }

  return tokens;
}

// ── Rewriter ───────────────────────────────────────────────

interface RewriteResult {
  command: string;
  translated: boolean;
  warnings: string[];
}

function rewriteTokens(tokens: Token[]): RewriteResult {
  let anyTranslated = false;
  const warnings: string[] = [];
  const segments: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok?.type === "word") {
      // Collect the command segment (words until non-word)
      const cmdTokens: Token[] = [];
      while (i < tokens.length && tokens[i]?.type === "word") {
        cmdTokens.push(tokens[i]!);
        i++;
      }

      // Check if followed by a pipe
      if (tokens[i]?.type === "pipe") {
        const chain: Token[][] = [cmdTokens];
        while (tokens[i]?.type === "pipe") {
          i++; // skip pipe
          const right: Token[] = [];
          while (i < tokens.length && tokens[i]?.type === "word") {
            right.push(tokens[i]!);
            i++;
          }
          if (right.length > 0) chain.push(right);
        }
        const rewritten = rewritePipeChain(chain);
        if (rewritten.translated) anyTranslated = true;
        warnings.push(...rewritten.warnings);
        segments.push(rewritten.command);
      } else {
        const rewritten = rewriteSingleCommand(cmdTokens);
        if (rewritten.translated) anyTranslated = true;
        warnings.push(...rewritten.warnings);
        segments.push(rewritten.command);
      }
      continue;
    }

    if (tok?.type === "semicolon") { segments.push(";"); i++; continue; }
    if (tok?.type === "and") { segments.push("&&"); i++; continue; }
    if (tok?.type === "or") { segments.push("||"); i++; continue; }
    if (tok?.type === "bg") { segments.push("&"); i++; continue; }
    if (tok?.type === "redirect") {
      i++;
      if (tokens[i]?.type === "word") {
        segments.push(mapRedirect(tok.value) + " " + tokens[i]!.value);
        i++;
      }
      continue;
    }

    i++;
  }

  return { command: segments.join(" "), translated: anyTranslated, warnings };
}

// ── Single command rewrite ─────────────────────────────────

function rewriteSingleCommand(tokens: Token[]): RewriteResult {
  if (tokens.length === 0) return { command: "", translated: false, warnings: [] };

  const cmd = tokens[0]!.value;
  const args = tokens.slice(1).map((t) => t.value);
  const rest = args.join(" ");

  const r = applyBuiltinRules(cmd, args, rest);
  if (r) return { command: r.result, translated: true, warnings: r.warnings };

  return { command: tokens.map((t) => t.value).join(" "), translated: false, warnings: [] };
}

// ── Pipe chain rewrite ─────────────────────────────────────

function rewritePipeChain(chain: Token[][]): RewriteResult {
  let anyTranslated = false;
  const allWarnings: string[] = [];
  const parts: string[] = [];

  for (let idx = 0; idx < chain.length; idx++) {
    const segment = chain[idx]!;
    const cmd = segment[0]?.value ?? "";
    const args = segment.slice(1).map((t) => t.value);
    const rest = args.join(" ");

    const pipeRewrite = applyPipeRules(cmd, args, rest, idx === 0);
    if (pipeRewrite) {
      parts.push(pipeRewrite.result);
      anyTranslated = true;
      allWarnings.push(...pipeRewrite.warnings);
    } else {
      const r = applyBuiltinRules(cmd, args, rest);
      if (r) {
        parts.push(r.result);
        anyTranslated = true;
        allWarnings.push(...r.warnings);
      } else {
        parts.push(segment.map((t) => t.value).join(" "));
      }
    }
  }

  return { command: parts.join(" | "), translated: anyTranslated, warnings: allWarnings };
}

// ── Rule result type ───────────────────────────────────────

interface RuleResult {
  result: string;
  warnings: string[];
}

function ok(result: string): RuleResult {
  return { result, warnings: [] };
}

function warn(result: string, ...msgs: string[]): RuleResult {
  return { result, warnings: msgs };
}

// ── Built-in command rules ─────────────────────────────────

function applyBuiltinRules(cmd: string, args: string[], rest: string): RuleResult | null {
  const first = args[0] ?? "";

  switch (cmd) {
    // ── ls ────────────────────────────────────────────────
    case "ls": {
      if (args.length === 0) return ok("Get-ChildItem");
      // M-3: extract individual flags from compound flags like -la, -lha
      const allFlags = extractFlags(args);
      const paths = args.filter((a) => !a.startsWith("-"));
      let psCmd = "Get-ChildItem";
      if (allFlags.has("l") || allFlags.has("a")) psCmd += " -Force";
      if (allFlags.has("h")) psCmd += " | Format-Table -AutoSize"; // human-readable sizes
      if (allFlags.has("r")) psCmd += " -Recurse";
      if (allFlags.has("t")) psCmd += " | Sort-Object LastWriteTime";
      if (paths.length > 0) psCmd += " " + paths.map(slashToBackslash).join(", ");
      return ok(psCmd);
    }
    case "ll": {
      const paths = args.filter((a) => !a.startsWith("-"));
      let psCmd = "Get-ChildItem -Force";
      if (paths.length > 0) psCmd += " " + paths.map(slashToBackslash).join(", ");
      return ok(psCmd);
    }
    case "la":
      return ok("Get-ChildItem -Force -Hidden");

    // ── pwd ───────────────────────────────────────────────
    case "pwd":
      return ok("Get-Location");

    // ── cd ────────────────────────────────────────────────
    case "cd": {
      if (args.length === 0 || first === "~") return ok("Set-Location $env:USERPROFILE");
      return ok(`Set-Location '${escapePsString(slashToBackslash(first))}'`);
    }

    // ── cat (H-7: use single Get-Content with multiple paths) ─
    case "cat": {
      if (args.length === 0) return null;
      const paths = args.map((f) => `'${escapePsString(slashToBackslash(f))}'`).join(", ");
      return ok(`Get-Content ${paths}`);
    }

    // ── echo ──────────────────────────────────────────────
    case "echo": {
      if (rest.startsWith("$")) {
        return ok(`Write-Output ${convertEnvVars(rest)}`);
      }
      return ok(`Write-Output ${rest}`);
    }

    // ── mkdir ─────────────────────────────────────────────
    case "mkdir": {
      const mp = args.find((a) => !a.startsWith("-"));
      if (!mp) return null;
      return ok(`New-Item -ItemType Directory -Path '${escapePsString(slashToBackslash(mp))}' -Force`);
    }

    // ── rm (M-2: exact flag matching) ─────────────────────
    case "rm": {
      const flags = args.filter((a) => a.startsWith("-"));
      const paths = args.filter((a) => !a.startsWith("-"));
      if (paths.length === 0) return null;
      const recursive = flags.some((f) => f === "-r" || f === "-R" || f === "-rf" || f === "-fr" || f === "-Rf" || f === "-rR");
      const force = flags.some((f) => f === "-f" || f === "-F" || f === "-rf" || f === "-fr" || f === "-Rf");
      let psCmd = "Remove-Item";
      if (recursive) psCmd += " -Recurse";
      if (force) psCmd += " -Force";
      psCmd += " " + paths.map((p) => `'${escapePsString(slashToBackslash(p))}'`).join(", ");
      return ok(psCmd);
    }

    // ── cp ────────────────────────────────────────────────
    case "cp": {
      const cpArgs = args.filter((a) => !a.startsWith("-"));
      const flags = args.filter((a) => a.startsWith("-"));
      if (cpArgs.length < 2) return null;
      const src = cpArgs[0]!;
      const dst = cpArgs.slice(1).join(" ");
      let psCmd = "Copy-Item";
      if (flags.includes("-r") || flags.includes("-R") || flags.includes("-a")) psCmd += " -Recurse";
      psCmd += ` '${escapePsString(slashToBackslash(src))}' '${escapePsString(slashToBackslash(dst))}'`;
      return ok(psCmd);
    }

    // ── mv ────────────────────────────────────────────────
    case "mv": {
      const mvArgs = args.filter((a) => !a.startsWith("-"));
      if (mvArgs.length < 2) return null;
      const src = mvArgs[0]!;
      const dst = mvArgs.slice(1).join(" ");
      return ok(`Move-Item '${escapePsString(slashToBackslash(src))}' '${escapePsString(slashToBackslash(dst))}'`);
    }

    // ── touch ─────────────────────────────────────────────
    case "touch": {
      if (args.length === 0) return null;
      return ok(args.map((f) => `New-Item -ItemType File -Path '${escapePsString(slashToBackslash(f))}' -Force`).join("; "));
    }

    // ── grep ──────────────────────────────────────────────
    case "grep":
      return rewriteGrep(args);

    // ── find ──────────────────────────────────────────────
    case "find":
      return rewriteFind(args);

    // ── ps ────────────────────────────────────────────────
    case "ps":
      return ok("Get-Process");

    // ── which / command ───────────────────────────────────
    case "which":
    case "command":
    case "command -v":
      if (!first) return null;
      return ok(`Get-Command ${first} | Select-Object -ExpandProperty Source`);

    // ── env ───────────────────────────────────────────────
    case "env":
      return ok("Get-ChildItem Env:");

    // ── export ────────────────────────────────────────────
    case "export": {
      const m = rest.match(/^(\w+)=(.*)/s);
      if (!m) return null;
      return ok(`$env:${m[1]} = ${convertEnvVars(m[2]!)}`);
    }

    // ── head ──────────────────────────────────────────────
    case "head": {
      const n = extractNumberFlag(args, "n") ?? 10;
      const files = args.filter((a) => !a.startsWith("-") && !/^-?\d+$/.test(a));
      if (files.length > 0) {
        return ok(`Get-Content '${escapePsString(slashToBackslash(files[0]!))}' | Select-Object -First ${n}`);
      }
      return null; // pipe context
    }

    // ── tail ──────────────────────────────────────────────
    case "tail": {
      const n = extractNumberFlag(args, "n") ?? 10;
      const files = args.filter((a) => !a.startsWith("-") && !/^-?\d+$/.test(a));
      if (files.length > 0) {
        return ok(`Get-Content '${escapePsString(slashToBackslash(files[0]!))}' -Tail ${n}`);
      }
      return null;
    }

    // ── sort ──────────────────────────────────────────────
    case "sort":
      return ok("Sort-Object");

    // ── uniq ──────────────────────────────────────────────
    case "uniq":
      return ok("Select-Object -Unique");

    // ── wc ────────────────────────────────────────────────
    case "wc": {
      if (args.includes("-l")) return ok("Measure-Object -Line | Select-Object -ExpandProperty Lines");
      return ok("Measure-Object");
    }

    // ── clear ─────────────────────────────────────────────
    case "clear":
      return ok("Clear-Host");

    // ── source / dot ──────────────────────────────────────
    case "source":
      if (!first) return null;
      return ok(`. '${escapePsString(slashToBackslash(first))}'`);

    // ── exit ──────────────────────────────────────────────
    case "exit": {
      const code = first || "0";
      return ok(`exit ${code}`);
    }

    // ── chmod, chown ──────────────────────────────────────
    case "chmod":
      return warn("chmod", "[pi-ps][warn] chmod has no direct PowerShell equivalent — icacls or Set-Acl required");
    case "chown":
      return warn("chown", "[pi-ps][warn] chown has no direct PowerShell equivalent — icacls or Set-Acl required");

    // ── xargs ─────────────────────────────────────────────
    case "xargs": {
      if (args.length === 0) return null;
      return ok(`ForEach-Object { ${rest} \$_ }`);
    }

    // ── sed (H-1: removed dead `global` variable) ─────────
    case "sed": {
      const sedMatch = rest.match(/^s\/(.+?)\/(.*?)\/([gi]*)/);
      if (sedMatch) {
        const [, pattern, replacement, flags] = sedMatch;
        const caseInsensitive = flags?.includes("i") ? " -CaseSensitive:$false" : "";
        // PS -replace is always global — no flag needed
        return ok(`ForEach-Object { $_ -replace '${pattern}', '${replacement}'${caseInsensitive} }`);
      }
      return null;
    }

    // ── tr ────────────────────────────────────────────────
    case "tr": {
      if (args.length >= 2) {
        return ok(`ForEach-Object { $_ -replace '${args[0]}', '${args[1]}' }`);
      }
      return null;
    }

    // ── awk ───────────────────────────────────────────────
    case "awk": {
      const awkMatch = rest.match(/\{print\s+\$(\d+)\}/);
      if (awkMatch) {
        const n = parseInt(awkMatch[1]!, 10);
        if (n === 0) return ok(`ForEach-Object { $_ }`);
        // M-8: use $(n-1) index correctly for all fields
        return ok(`ForEach-Object { ($_ -split '\\s+')[${n - 1}] }`);
      }
      // Also handle awk '{print $0}' (whole line)
      if (rest.includes("{print}")) {
        return ok(`ForEach-Object { $_ }`);
      }
      return null;
    }

    // ── cut ───────────────────────────────────────────────
    case "cut": {
      // Handle both -d DELIM and -dDELIM forms
      let delim = ",";
      let fieldStr = "1";
      for (let ci = 0; ci < args.length; ci++) {
        const a = args[ci]!;
        if (a === "-d") {
          delim = args[++ci] ?? ",";
        } else if (a.startsWith("-d")) {
          delim = a.slice(2) || ",";
        } else if (a === "-f") {
          fieldStr = args[++ci] ?? "1";
        } else if (a.startsWith("-f")) {
          fieldStr = a.slice(2) || "1";
        }
      }
      const fields = fieldStr.split(",").map((f) => parseInt(f, 10) - 1);
      return ok(`ForEach-Object { ($_ -split '${delim}')[${fields.join(",")}] -join '${delim}' }`);
    }

    // ── tee ───────────────────────────────────────────────
    case "tee":
      if (!first) return null;
      return ok(`Tee-Object -FilePath '${escapePsString(slashToBackslash(first))}'`);

    // ── date ──────────────────────────────────────────────
    case "date":
      return ok("Get-Date");

    // ── whoami ────────────────────────────────────────────
    case "whoami":
      return ok("[System.Security.Principal.WindowsIdentity]::GetCurrent().Name");

    // ── uname ─────────────────────────────────────────────
    case "uname":
      return ok("'Windows'");

    // ── df ────────────────────────────────────────────────
    case "df":
      return ok("Get-PSDrive -PSProvider FileSystem");

    // ── du ────────────────────────────────────────────────
    case "du": {
      const target = first && !first.startsWith("-") ? slashToBackslash(first) : ".";
      return ok(`(Get-ChildItem -Recurse '${escapePsString(target)}' | Measure-Object -Property Length -Sum).Sum / 1MB`);
    }

    // ── basename / dirname ────────────────────────────────
    case "basename":
      return first ? ok(`Split-Path '${escapePsString(first)}' -Leaf`) : null;
    case "dirname":
      return first ? ok(`Split-Path '${escapePsString(first)}' -Parent`) : null;

    // ── realpath / readlink ───────────────────────────────
    case "realpath":
      return first ? ok(`(Resolve-Path '${escapePsString(first)}').Path`) : null;
    case "readlink":
      return first ? ok(`(Get-Item '${escapePsString(first)}').Target`) : null;

    // ── test ──────────────────────────────────────────────
    case "test":
    case "[":
      return rewriteTest(args);

    // ── seq ───────────────────────────────────────────────
    case "seq": {
      if (args.length === 1) return ok(`1..${first}`);
      if (args.length === 2) return ok(`${args[0]}..${args[1]}`);
      return null;
    }

    // ── sleep ─────────────────────────────────────────────
    case "sleep":
      return first ? ok(`Start-Sleep -Seconds ${first}`) : null;

    // ── man ───────────────────────────────────────────────
    case "man":
      return first ? ok(`Get-Help ${first}`) : null;

    default:
      return null;
  }
}

// ── Pipe-aware rules ───────────────────────────────────────

function applyPipeRules(cmd: string, args: string[], rest: string, isFirst: boolean): RuleResult | null {
  switch (cmd) {
    case "grep": {
      const pattern = extractGrepPattern(args);
      const ci = args.includes("-i") ? " -CaseSensitive:$false" : "";
      if (isFirst) {
        const files = args.filter((a) => !a.startsWith("-") && a !== pattern);
        if (files.length > 0) {
          return ok(`Select-String -Pattern '${pattern}' -Path '${escapePsString(slashToBackslash(files[0]!))}'${ci}`);
        }
      }
      return ok(`Where-Object { $_ -match '${pattern}'${ci} }`);
    }

    case "head": {
      const n = extractNumberFlag(args, "n") ?? 10;
      return ok(`Select-Object -First ${n}`);
    }

    case "tail": {
      const n = extractNumberFlag(args, "n") ?? 10;
      return ok(`Select-Object -Last ${n}`);
    }

    case "sort": {
      const r = args.includes("-r") ? " -Descending" : "";
      const n = args.includes("-n") ? " -Property { [double]$_ }" : "";
      return ok(`Sort-Object${n}${r}`);
    }

    case "uniq":
      return ok("Select-Object -Unique");

    case "wc": {
      if (args.includes("-l")) return ok("Measure-Object -Line | Select-Object -ExpandProperty Lines");
      return ok("Measure-Object");
    }

    case "xargs": {
      if (args.length === 0) return null;
      return ok(`ForEach-Object { ${rest} \$_ }`);
    }

    case "sed": {
      const sedMatch = rest.match(/^s\/(.+?)\/(.*?)\/([gi]*)/);
      if (sedMatch) {
        const [, pattern, replacement] = sedMatch;
        return ok(`ForEach-Object { $_ -replace '${pattern}', '${replacement}' }`);
      }
      return null;
    }

    case "tr": {
      if (args.length >= 2) {
        return ok(`ForEach-Object { $_ -replace '${args[0]}', '${args[1]}' }`);
      }
      return null;
    }

    case "awk": {
      const awkMatch = rest.match(/\{print\s+\$(\d+)\}/);
      if (awkMatch) {
        const n = parseInt(awkMatch[1]!, 10);
        if (n === 0) return ok(`ForEach-Object { $_ }`);
        return ok(`ForEach-Object { ($_ -split '\\s+')[${n - 1}] }`);
      }
      if (rest.includes("{print}")) return ok(`ForEach-Object { $_ }`);
      return null;
    }

    case "cut": {
      let delim = ",";
      let fieldStr = "1";
      for (let ci = 0; ci < args.length; ci++) {
        const a = args[ci]!;
        if (a === "-d") {
          delim = args[++ci] ?? ",";
        } else if (a.startsWith("-d")) {
          delim = a.slice(2) || ",";
        } else if (a === "-f") {
          fieldStr = args[++ci] ?? "1";
        } else if (a.startsWith("-f")) {
          fieldStr = a.slice(2) || "1";
        }
      }
      const fields = fieldStr.split(",").map((f) => parseInt(f, 10) - 1);
      return ok(`ForEach-Object { ($_ -split '${delim}')[${fields.join(",")}] -join '${delim}' }`);
    }

    case "tee":
      if (args.length === 0) return null;
      return ok(`Tee-Object -FilePath '${escapePsString(slashToBackslash(args[0]!))}'`);

    case "find":
      return rewriteFind(args);

    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────

/** H-2: escape single quotes for PS single-quoted strings */
function escapePsString(s: string): string {
  return s.replace(/'/g, "''");
}

function slashToBackslash(p: string): string {
  return p.replace(/\//g, "\\");
}

/** M-3: extract individual flags from compound flags like -la, -lha */
function extractFlags(args: string[]): Set<string> {
  const flags = new Set<string>();
  for (const a of args) {
    if (!a.startsWith("-") || a.length < 2) continue;
    // Handle -la, -al, -lha, -ltr, etc.
    const stripped = a.slice(1); // remove leading -
    for (const ch of stripped) {
      flags.add(ch);
    }
  }
  return flags;
}

function convertEnvVars(s: string): string {
  const known = [
    "HOME", "USER", "PATH", "PWD", "SHELL", "TERM",
    "USERNAME", "COMPUTERNAME", "USERPROFILE", "TEMP", "TMP",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "SYSTEMROOT",
    "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  ];
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName: string) => {
    if (known.includes(varName)) return `$env:${varName}`;
    return match;
  });
}

function extractNumberFlag(args: string[], flag: string): number | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `-${flag}`) {
      const next = args[i + 1];
      if (next) return parseInt(next, 10);
    }
    if (a.startsWith(`-${flag}`)) {
      const val = a.slice(flag.length + 1);
      if (val) return parseInt(val, 10);
    }
    // Bare -N shorthand: -5 means -n 5 for head/tail
    if (/^-\d+$/.test(a) && flag === "n") {
      return parseInt(a.slice(1), 10);
    }
  }
  return null;
}

function extractGrepPattern(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (a === "-e" && args[i + 1]) return args[i + 1]!;
      continue;
    }
    return a;
  }
  return "";
}

function rewriteGrep(args: string[]): RuleResult | null {
  if (args.length === 0) return null;

  const flags: string[] = [];
  let pattern = "";
  let file = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-i") { flags.push("-i"); continue; }
    if (a === "-r" || a === "-R" || a === "-l" || a === "-v" || a === "-n") { flags.push(a); continue; }
    if (a === "-e") { i++; if (args[i]) pattern = args[i]!; continue; }
    if (!pattern) { pattern = a; continue; }
    if (!file) { file = a; }
  }

  if (!pattern) return null;

  const ci = flags.includes("-i") ? " -CaseSensitive:$false" : "";
  const recursive = flags.includes("-r") || flags.includes("-R");

  if (file) {
    return ok(`Select-String -Pattern '${pattern}' -Path '${escapePsString(slashToBackslash(file))}'${ci}`);
  }
  if (recursive) {
    return ok(`Get-ChildItem -Recurse | Select-String -Pattern '${pattern}'${ci}`);
  }
  return ok(`Select-String -Pattern '${pattern}'${ci}`);
}

function rewriteFind(args: string[]): RuleResult | null {
  if (args.length === 0) return null;

  let dir = ".";
  let namePattern = "";
  let typeFilter = "";
  const warnings: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-name" && args[i + 1]) { namePattern = args[++i]!; continue; }
    if (a === "-type" && args[i + 1]) {
      const t = args[++i]!;
      if (t === "f") typeFilter = " -File";
      else if (t === "d") typeFilter = " -Directory";
      continue;
    }
    // M-4: warn about unsupported find flags
    if (a === "-maxdepth" || a === "-mindepth") {
      i++; // skip value
      warnings.push(`[pi-ps][warn] find ${a} is not supported in PowerShell translation`);
      continue;
    }
    if (a === "-exec" || a === "-execdir") {
      // Skip until we find ;
      while (i < args.length && args[i] !== ";") i++;
      warnings.push("[pi-ps][warn] find -exec is not supported — use Get-ChildItem | ForEach-Object");
      continue;
    }
    if (a === "-delete") {
      warnings.push("[pi-ps][warn] find -delete is not supported — use Remove-Item");
      continue;
    }
    if (!a.startsWith("-")) dir = a;
  }

  let cmd = `Get-ChildItem -Path '${escapePsString(slashToBackslash(dir))}' -Recurse`;
  if (typeFilter) cmd += typeFilter;
  if (namePattern) {
    const psPattern = namePattern.replace(/\*/g, "*").replace(/\?/g, "?");
    cmd += ` | Where-Object { $_.Name -like '${psPattern}' }`;
  }

  return warnings.length > 0 ? warn(cmd, ...warnings) : ok(cmd);
}

function rewriteTest(args: string[]): RuleResult | null {
  if (args.length < 2) return null;

  const flag = args[0]!;
  const val = args[1] ?? "";

  switch (flag) {
    case "-f":
      return ok(`Test-Path '${escapePsString(val)}' -PathType Leaf`);
    case "-d":
      return ok(`Test-Path '${escapePsString(val)}' -PathType Container`);
    case "-e":
      return ok(`Test-Path '${escapePsString(val)}'`);
    case "-z":
      return ok(`[string]::IsNullOrEmpty(${val})`);
    case "-n":
      return ok(`-not [string]::IsNullOrEmpty(${val})`);
    default:
      return null;
  }
}

/** L-2: simplified — only non-identity case is >& → >&1 */
function mapRedirect(r: string): string {
  if (r === ">&") return ">&1";
  return r;
}

// ── L-4: aliases loading ───────────────────────────────────

interface AliasMap {
  [bashCmd: string]: string;
}

let _loadedAliases: AliasMap | null = null;

function loadAliases(): AliasMap {
  if (_loadedAliases) return _loadedAliases;

  const aliasFile = process.env.PI_PS_ALIAS_FILE
    ?? path.join(os.homedir(), ".pi-ps", "aliases.json");

  const empty: AliasMap = {};
  try {
    if (!existsSync(aliasFile)) { _loadedAliases = empty; return empty; }
    const raw = JSON.parse(readFileSync(aliasFile, "utf-8"));
    const loaded: AliasMap = raw?.aliases ?? empty;
    _loadedAliases = loaded;
    return loaded;
  } catch {
    _loadedAliases = empty;
    return empty;
  }
}

// ── Re-export for testing ──────────────────────────────────
export { tokenize, isPwshNative };
