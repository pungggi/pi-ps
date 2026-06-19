/**
 * pi-ps — Translator tests
 *
 * Tests every translation rule with positive and negative cases.
 * Verifies idempotency (no double-rewrite).
 */

import { describe, it, expect } from "vitest";
import { translate, tokenize, isPwshNative, type TranslateMode } from "../src/translator/index.js";

// ── Helpers ────────────────────────────────────────────────

function auto(cmd: string) {
  return translate(cmd, "auto");
}

function hint(cmd: string) {
  return translate(cmd, "hint");
}

function off(cmd: string) {
  return translate(cmd, "off");
}

// ── Tokenizer ──────────────────────────────────────────────

describe("tokenizer", () => {
  it("tokenizes simple commands", () => {
    const tokens = tokenize("ls -la /tmp");
    expect(tokens.map((t) => t.value)).toEqual(["ls", "-la", "/tmp"]);
  });

  it("handles quoted args", () => {
    const tokens = tokenize('echo "hello world"');
    expect(tokens.map((t) => t.value)).toEqual(["echo", '"hello world"']);
  });

  it("handles single-quoted args", () => {
    const tokens = tokenize("echo 'hello world'");
    expect(tokens.map((t) => t.value)).toEqual(["echo", "'hello world'"]);
  });

  it("handles pipes", () => {
    const tokens = tokenize("ls | grep foo");
    expect(tokens.filter((t) => t.type === "pipe").length).toBe(1);
  });

  it("handles multiple pipes", () => {
    const tokens = tokenize("cat file | grep pattern | sort | uniq");
    expect(tokens.filter((t) => t.type === "pipe").length).toBe(3);
  });

  it("handles semicolons", () => {
    const tokens = tokenize("cd /tmp; ls");
    expect(tokens.some((t) => t.type === "semicolon")).toBe(true);
  });

  it("handles && and ||", () => {
    const tokens = tokenize("mkdir dir && cd dir || echo fail");
    expect(tokens.some((t) => t.type === "and")).toBe(true);
    expect(tokens.some((t) => t.type === "or")).toBe(true);
  });

  it("handles redirections", () => {
    const tokens = tokenize("echo hello > out.txt");
    expect(tokens.some((t) => t.type === "redirect" && t.value === ">")).toBe(true);
  });

  it("handles >> redirection", () => {
    const tokens = tokenize("echo hello >> out.txt");
    expect(tokens.some((t) => t.type === "redirect" && t.value === ">>")).toBe(true);
  });

  it("handles 2>&1 redirection", () => {
    const tokens = tokenize("cmd 2>&1");
    expect(tokens.some((t) => t.type === "redirect" && t.value === "2>&1")).toBe(true);
  });

  it("handles args with spaces inside quotes", () => {
    const tokens = tokenize('cp "source file.txt" "dest file.txt"');
    expect(tokens.length).toBe(3);
    expect(tokens[1]!.value).toBe('"source file.txt"');
    expect(tokens[2]!.value).toBe('"dest file.txt"');
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles command with $() substitution", () => {
    const tokens = tokenize("echo $(basename foo.txt)");
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Pwsh-native detection ──────────────────────────────────

describe("isPwshNative", () => {
  it("detects Verb-Noun cmdlets", () => {
    expect(isPwshNative("Get-ChildItem")).toBe(true);
    expect(isPwshNative("Set-Location C:\\Users")).toBe(true);
  });

  it("detects $-prefixed expressions", () => {
    expect(isPwshNative("$env:PATH")).toBe(true);
    expect(isPwshNative("$PSVersionTable")).toBe(true);
  });

  it("detects & call operator", () => {
    expect(isPwshNative("& ./script.ps1")).toBe(true);
  });

  it("detects dot-source", () => {
    expect(isPwshNative(". ./profile.ps1")).toBe(true);
  });

  it("does not flag bash commands", () => {
    expect(isPwshNative("ls")).toBe(false);
    expect(isPwshNative("grep pattern file")).toBe(false);
    expect(isPwshNative("cat foo.txt")).toBe(false);
  });
});

// ── Mode: off ──────────────────────────────────────────────

describe("mode: off", () => {
  it("passes command verbatim", () => {
    const r = off("ls -la");
    expect(r.command).toBe("ls -la");
    expect(r.translated).toBe(false);
    expect(r.hint).toBeUndefined();
  });
});

// ── Mode: hint ─────────────────────────────────────────────

describe("mode: hint", () => {
  it("runs original but provides hint", () => {
    const r = hint("ls");
    expect(r.command).toBe("ls");
    expect(r.hint).toBeDefined();
    expect(r.hint!).toContain("Get-ChildItem");
    expect(r.translated).toBe(false);
  });

  it("provides no hint for PS-native commands", () => {
    const r = hint("Get-Process");
    expect(r.command).toBe("Get-Process");
    expect(r.hint).toBeUndefined();
  });
});

// ── Basic commands (auto mode) ─────────────────────────────

describe("basic commands", () => {
  it("ls → Get-ChildItem", () => {
    expect(auto("ls").command).toBe("Get-ChildItem");
  });

  it("ls -la → Get-ChildItem -Force", () => {
    expect(auto("ls -la").command).toBe("Get-ChildItem -Force");
  });

  it("ls /tmp → Get-ChildItem \\tmp", () => {
    expect(auto("ls /tmp").command).toBe("Get-ChildItem \\tmp");
  });

  it("ll → Get-ChildItem -Force", () => {
    expect(auto("ll").command).toBe("Get-ChildItem -Force");
  });

  it("la → Get-ChildItem -Force -Hidden", () => {
    expect(auto("la").command).toBe("Get-ChildItem -Force -Hidden");
  });

  it("pwd → Get-Location", () => {
    expect(auto("pwd").command).toBe("Get-Location");
  });

  it("cd /tmp → Set-Location", () => {
    expect(auto("cd /tmp").command).toBe("Set-Location '\\tmp'");
  });

  it("cd ~ → Set-Location $env:USERPROFILE", () => {
    expect(auto("cd ~").command).toBe("Set-Location $env:USERPROFILE");
  });

  it("cat file.txt → Get-Content", () => {
    expect(auto("cat file.txt").command).toBe("Get-Content 'file.txt'");
  });

  // H-7: cat multi-file uses single Get-Content
  it("cat a.txt b.txt → Get-Content with multiple paths", () => {
    const r = auto("cat a.txt b.txt");
    expect(r.command).toContain("Get-Content");
    expect(r.command).toContain("a.txt");
    expect(r.command).toContain("b.txt");
    expect(r.command).not.toContain(";"); // no semicolons
  });

  it("echo hello → Write-Output", () => {
    expect(auto("echo hello").command).toBe("Write-Output hello");
  });

  it("echo $HOME → Write-Output with env var", () => {
    const r = auto("echo $HOME");
    expect(r.command).toContain("$env:HOME");
  });

  it("mkdir mydir → New-Item -ItemType Directory", () => {
    const r = auto("mkdir mydir");
    expect(r.command).toContain("New-Item");
    expect(r.command).toContain("Directory");
  });

  it("rm -rf dir → Remove-Item -Recurse -Force", () => {
    const r = auto("rm -rf dir");
    expect(r.command).toContain("Remove-Item");
    expect(r.command).toContain("Recurse");
    expect(r.command).toContain("Force");
  });

  // M-2: exact flag matching for rm
  it("rm -r dir → Remove-Item -Recurse (no Force)", () => {
    const r = auto("rm -r dir");
    expect(r.command).toContain("Remove-Item");
    expect(r.command).toContain("-Recurse");
    expect(r.command).not.toContain("-Force");
  });

  it("touch file.txt → New-Item -ItemType File", () => {
    const r = auto("touch file.txt");
    expect(r.command).toContain("New-Item");
    expect(r.command).toContain("File");
  });

  it("env → Get-ChildItem Env:", () => {
    expect(auto("env").command).toBe("Get-ChildItem Env:");
  });

  it("export FOO=bar → $env:FOO = bar", () => {
    const r = auto("export FOO=bar");
    expect(r.command).toContain("$env:FOO");
    expect(r.command).toContain("bar");
  });

  it("which node → Get-Command", () => {
    expect(auto("which node").command).toContain("Get-Command");
  });

  it("ps → Get-Process", () => {
    expect(auto("ps").command).toBe("Get-Process");
  });

  it("clear → Clear-Host", () => {
    expect(auto("clear").command).toBe("Clear-Host");
  });

  it("date → Get-Date", () => {
    expect(auto("date").command).toBe("Get-Date");
  });

  it("whoami → WindowsIdentity", () => {
    expect(auto("whoami").command).toContain("WindowsIdentity");
  });

  it("sleep 5 → Start-Sleep", () => {
    expect(auto("sleep 5").command).toBe("Start-Sleep -Seconds 5");
  });

  it("exit 1 → exit 1", () => {
    expect(auto("exit 1").command).toBe("exit 1");
  });
});

// ── File operations ────────────────────────────────────────

describe("file operations", () => {
  it("cp src dst → Copy-Item", () => {
    const r = auto("cp a.txt b.txt");
    expect(r.command).toContain("Copy-Item");
  });

  it("cp -r src dst → Copy-Item -Recurse", () => {
    const r = auto("cp -r src dst");
    expect(r.command).toContain("-Recurse");
  });

  it("mv src dst → Move-Item", () => {
    const r = auto("mv a.txt b.txt");
    expect(r.command).toContain("Move-Item");
  });

  it("basename /foo/bar.txt → Split-Path -Leaf", () => {
    expect(auto("basename /foo/bar.txt").command).toContain("-Leaf");
  });

  it("dirname /foo/bar.txt → Split-Path -Parent", () => {
    expect(auto("dirname /foo/bar.txt").command).toContain("-Parent");
  });
});

// ── Grep ───────────────────────────────────────────────────

describe("grep", () => {
  it("grep pattern file → Select-String", () => {
    const r = auto("grep error log.txt");
    expect(r.command).toContain("Select-String");
    expect(r.command).toContain("error");
  });

  it("grep -i pattern file → case insensitive", () => {
    const r = auto("grep -i error log.txt");
    expect(r.command).toContain("CaseSensitive:$false");
  });
});

// ── Find ───────────────────────────────────────────────────

describe("find", () => {
  it("find . -name '*.ts' → Get-ChildItem with filter", () => {
    const r = auto("find . -name '*.ts'");
    expect(r.command).toContain("Get-ChildItem");
    expect(r.command).toContain("-like");
  });

  it("find . -type f → Get-ChildItem -File", () => {
    const r = auto("find . -type f");
    expect(r.command).toContain("-File");
  });

  it("find . -type d → Get-ChildItem -Directory", () => {
    const r = auto("find . -type d");
    expect(r.command).toContain("-Directory");
  });

  // M-4: -exec produces warning
  it("find . -name '*.log' -exec rm {} ; produces warning", () => {
    const r = auto("find . -name '*.log' -exec rm {} ;");
    expect(r.command).toContain("Get-ChildItem");
    // Should still translate the -name part
    expect(r.command).toContain("-like");
  });
});

// ── Pipe chains ────────────────────────────────────────────

describe("pipe chains", () => {
  it("ls | grep foo → pipeline", () => {
    const r = auto("ls | grep foo");
    expect(r.command).toContain("Get-ChildItem");
    expect(r.command).toContain("Where-Object");
    expect(r.command).toContain("foo");
  });

  it("cat file | grep pattern → Select-String", () => {
    const r = auto("cat file.txt | grep error");
    expect(r.translated).toBe(true);
  });

  it("ls | head -5 → Select-Object -First 5", () => {
    const r = auto("ls | head -5");
    expect(r.command).toContain("Select-Object -First 5");
  });

  it("ls | tail -3 → Select-Object -Last 3", () => {
    const r = auto("ls | tail -3");
    expect(r.command).toContain("Select-Object -Last 3");
  });

  it("cat file | sort → Sort-Object", () => {
    const r = auto("cat file.txt | sort");
    expect(r.command).toContain("Sort-Object");
  });

  it("cat file | sort -r → Sort-Object -Descending", () => {
    const r = auto("cat file.txt | sort -r");
    expect(r.command).toContain("-Descending");
  });

  it("cat file | uniq → Select-Object -Unique", () => {
    const r = auto("cat file.txt | uniq");
    expect(r.command).toContain("Select-Object -Unique");
  });

  it("ls | wc -l → Measure-Object -Line", () => {
    const r = auto("ls | wc -l");
    expect(r.command).toContain("Measure-Object");
    expect(r.command).toContain("Line");
  });

  it("multi-stage pipe: cat file | grep foo | sort | uniq", () => {
    const r = auto("cat file.txt | grep foo | sort | uniq");
    expect(r.translated).toBe(true);
    expect(r.command).toContain("Get-Content");
    expect(r.command).toContain("Where-Object");
    expect(r.command).toContain("Sort-Object");
    expect(r.command).toContain("Select-Object -Unique");
  });
});

// ── Idempotency ────────────────────────────────────────────

describe("idempotency", () => {
  it("translating a PS-native command is idempotent", () => {
    const cmd = "Get-ChildItem | Where-Object { $_.Name -like '*.ts' }";
    const r = auto(cmd);
    expect(r.command).toBe(cmd);
    expect(r.translated).toBe(false);
  });

  it("double-translation of translated output does not change further", () => {
    const original = "ls";
    const r1 = auto(original);
    const r2 = auto(r1.command);
    expect(r2.command).toBe(r1.command);
    expect(r2.translated).toBe(false);
  });

  it("PS-native commands pass through unchanged", () => {
    const commands = [
      "Get-Process",
      "$env:PATH",
      "& ./script.ps1",
      ". ./profile.ps1",
    ];
    for (const cmd of commands) {
      const r = auto(cmd);
      expect(r.command).toBe(cmd);
      expect(r.translated).toBe(false);
    }
  });
});

// ── Edge cases ─────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty command", () => {
    const r = auto("");
    expect(r.command).toBe("");
  });

  it("handles unknown commands (passthrough)", () => {
    const r = auto("my-custom-binary --flag value");
    expect(r.command).toBe("my-custom-binary --flag value");
    expect(r.translated).toBe(false);
  });

  it("handles commands with quoted paths", () => {
    const r = auto('cat "C:/Program Files/app/config.json"');
    expect(r.translated).toBe(true);
    expect(r.command).toContain("Get-Content");
  });

  it("handles paths with forward slashes", () => {
    const r = auto("ls /c/Users");
    expect(r.command).toContain("\\c\\Users");
  });

  // H-2: single-quote escaping
  it("escapes single quotes in paths", () => {
    const r = auto("cat O'Brien.txt");
    expect(r.command).toContain("O''Brien.txt");
    expect(r.command).not.toContain("O'Brien.txt"); // unescaped
  });

  // chmod now returns a warn result (translated=true) with a warning message
  it("does not translate chmod (returns warning)", () => {
    const r = auto("chmod +x script.sh");
    expect(r.translated).toBe(true); // it does produce a result with warning
    expect(r.command).toContain("chmod"); // passes through
  });

  it("test -f file → Test-Path", () => {
    const r = auto("test -f /tmp/exists.txt");
    expect(r.command).toContain("Test-Path");
  });

  it("seq 1 10 → range", () => {
    const r = auto("seq 1 10");
    expect(r.command).toBe("1..10");
  });

  it("du -sh dir → size calculation", () => {
    const r = auto("du dir");
    expect(r.command).toContain("Get-ChildItem -Recurse");
  });
});

// ── Test operator ──────────────────────────────────────────

describe("test operator", () => {
  it("test -f file → Test-Path -PathType Leaf", () => {
    const r = auto("test -f /tmp/foo");
    expect(r.command).toBe("Test-Path '/tmp/foo' -PathType Leaf");
  });

  it("test -d dir → Test-Path -PathType Container", () => {
    const r = auto("test -d /tmp");
    expect(r.command).toBe("Test-Path '/tmp' -PathType Container");
  });
});

// ── Environment variables ──────────────────────────────────

describe("environment variables", () => {
  it("converts known env vars in export", () => {
    const r = auto("export PATH=/usr/bin");
    expect(r.command).toContain("$env:PATH");
  });
});

// ── Semicolons and chaining ────────────────────────────────

describe("command chaining", () => {
  it("handles semicolons", () => {
    const r = auto("cd /tmp; ls");
    expect(r.command).toContain("Set-Location");
    expect(r.command).toContain("Get-ChildItem");
  });

  it("handles && chains", () => {
    const r = auto("mkdir dir && cd dir");
    expect(r.command).toContain("&&");
    expect(r.command).toContain("New-Item");
    expect(r.command).toContain("Set-Location");
  });
});

// ── L-3: Missing translator rule tests ─────────────────────

describe("sed", () => {
  it("sed s/foo/bar/ → ForEach-Object -replace", () => {
    const r = auto("echo hello | sed s/hello/world/");
    expect(r.command).toContain("-replace");
    expect(r.command).toContain("hello");
    expect(r.command).toContain("world");
  });

  it("sed s/foo/bar/g → always global (no extra flag)", () => {
    const r = auto("echo hello | sed s/hello/world/g");
    expect(r.command).toContain("-replace");
    expect(r.command).not.toContain("ReplaceAll");
  });

  it("sed s/foo/bar/i → case insensitive", () => {
    // standalone sed (not in pipe) uses applyBuiltinRules which includes CaseSensitive
    const r = auto("sed s/HELLO/world/i file.txt");
    expect(r.command).toContain("CaseSensitive:$false");
  });
});

describe("tr", () => {
  it("tr a b → ForEach-Object -replace", () => {
    const r = auto("echo hello | tr a b");
    expect(r.command).toContain("-replace");
    expect(r.command).toContain("'a'");
    expect(r.command).toContain("'b'");
  });

  it("tr with fewer than 2 args returns null", () => {
    const r = auto("echo hello | tr a");
    // tr in pipe context returns null → falls through to passthrough
    // so the echo still translates, tr stays as-is
    expect(r.translated).toBe(true);
  });
});

describe("awk", () => {
  it("awk '{print $2}' → ForEach-Object with index", () => {
    const r = auto("echo hello world | awk '{print $2}'");
    expect(r.command).toContain("ForEach-Object");
    expect(r.command).toContain("[1]"); // index 1 = field 2
  });

  it("awk '{print $1}' → index 0", () => {
    const r = auto("echo hello | awk '{print $1}'");
    expect(r.command).toContain("[0]");
  });

  it("awk '{print $0}' → whole line passthrough", () => {
    const r = auto("echo hello | awk '{print $0}'");
    expect(r.command).toContain("ForEach-Object { $_ }");
  });

  // awk '{print}' (bare print = whole line)
  it("awk '{print}' → whole line passthrough", () => {
    const r = auto("echo hello | awk '{print}'");
    expect(r.command).toContain("ForEach-Object { $_ }");
  });
});

describe("cut", () => {
  it("cut -d, -f1 → split and index", () => {
    // standalone cut (not in pipe context)
    const r = auto("cut -d, -f1 data.txt");
    expect(r.command).toContain("-split");
    expect(r.command).toContain("[0]");
  });

  it("cut -d: -f2 → split on colon, field 2", () => {
    const r = auto("cut -d: -f2 data.txt");
    expect(r.command).toContain("[1]");
  });
});

describe("tee", () => {
  it("tee out.txt → Tee-Object", () => {
    const r = auto("echo hello | tee out.txt");
    expect(r.command).toContain("Tee-Object");
    expect(r.command).toContain("out.txt");
  });
});

describe("xargs", () => {
  it("xargs rm → ForEach-Object", () => {
    const r = auto("ls | xargs rm");
    expect(r.command).toContain("ForEach-Object");
    expect(r.command).toContain("rm");
  });
});

describe("du", () => {
  it("du dir → size calculation", () => {
    const r = auto("du src");
    expect(r.command).toContain("Get-ChildItem -Recurse");
    expect(r.command).toContain("Measure-Object");
  });
});

describe("df", () => {
  it("df → Get-PSDrive", () => {
    expect(auto("df").command).toBe("Get-PSDrive -PSProvider FileSystem");
  });
});

describe("source", () => {
  it("source script.sh → dot-source", () => {
    const r = auto("source script.sh");
    expect(r.command).toBe(". 'script.sh'");
  });
});

describe("man", () => {
  it("man Get-ChildItem → Get-Help", () => {
    expect(auto("man Get-ChildItem").command).toBe("Get-Help Get-ChildItem");
  });
});

describe("realpath", () => {
  it("realpath file → Resolve-Path", () => {
    const r = auto("realpath ./foo.txt");
    expect(r.command).toContain("Resolve-Path");
  });
});

describe("readlink", () => {
  it("readlink file → Get-Item Target", () => {
    const r = auto("readlink ./link");
    expect(r.command).toContain("Get-Item");
    expect(r.command).toContain("Target");
  });
});

describe("uname", () => {
  it("uname → 'Windows'", () => {
    expect(auto("uname").command).toBe("'Windows'");
  });
});

// ── M-3: ls compound flags ─────────────────────────────────

describe("ls compound flags", () => {
  it("ls -lha → Get-ChildItem -Force + human-readable", () => {
    const r = auto("ls -lha");
    expect(r.command).toContain("Get-ChildItem -Force");
    expect(r.command).toContain("Format-Table");
  });

  it("ls -ltr → Get-ChildItem -Force sorted by time", () => {
    const r = auto("ls -ltr");
    expect(r.command).toContain("Get-ChildItem -Force");
    expect(r.command).toContain("Sort-Object LastWriteTime");
  });
});
