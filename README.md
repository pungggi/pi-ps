# pi-ps

Robust PowerShell extension for [pi](https://pi.dev) on Windows — token-based bash↔PS translation, background jobs, diagnostics, and local telemetry.

## Why pi-ps?

The original pi-powershell extension used a fragile regex-based bash→PS translator that broke on quoted args, spaces in paths, and nested pipes. pi-ps fixes all of that:

- **Token-based parser** — handles quoted args, multi-pipe chains, redirections, subshells
- **3 translation modes** — `off` (verbatim), `hint` (tips only), `auto` (rewrite)
- **Proper kill-tree** — `taskkill /T /F` on abort, not just leader PID
- **Background job runner** — replaces the whitespace-splitting `run-bg.ps1`
- **Open a new PowerShell tab** — `/pi-ps new` and `/pi-ps clone` spawn a
  separate PowerShell session beside pi (real Windows Terminal tab when
  available, otherwise a new window)
- **Diagnostics** — `pi-ps doctor` for troubleshooting
- **Local telemetry** — opt-in, privacy-first, never leaves your machine
- **115+ tests** — translator rules, shell resolution, diagnostics, open-tab

## Install

```bash
pi install ./pi-ps
```

Or local development:

```bash
pi -e ./src/extension.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/pi-ps` | Show current status |
| `/pi-ps doctor` | Full diagnostics (version, path, policy, UTF-8, peer deps) |
| `/pi-ps translate "<cmd>"` | Dry-run translation (shows what would happen) |
| `/pi-ps exec "<cmd>"` | Execute command explicitly through PS |
| `/pi-ps new` | Open a new PowerShell tab at the standard location |
| `/pi-ps clone` | Open a new PowerShell tab at pi's current path |
| `/pi-ps job list` | List background jobs |
| `/pi-ps job log <id>` | Show job output |
| `/pi-ps job kill <id>` | Kill a background job |
| `/pi-ps job cleanup` | Remove stale job files |

## Opening a New PowerShell Tab

Pi occupies your terminal while it runs. `/pi-ps new` and `/pi-ps clone`
spawn a **separate** PowerShell session beside it so you can run a manual
command without interrupting pi:

| Command | Opens at |
|---------|----------|
| `/pi-ps new` | The standard location (your Windows Terminal default profile's starting dir) |
| `/pi-ps clone` | Pi's current working directory (same path) |

Host detection is automatic:

- **Inside Windows Terminal** (`WT_SESSION` is set) → `wt.exe new-tab`, a real
  new tab in the current window.
- **Otherwise** (plain console / conhost) → `Start-Process pwsh`, a new window
  (there is no tab concept outside Windows Terminal). `new` opens at your home
  directory; `clone` opens at pi's cwd.

The tab/window always launches the same PowerShell pi is using (pwsh 7 if
available, otherwise Windows PowerShell 5.1).

## Translation Modes

Set via `PI_PS_TRANSLATE` env var or `pi.ps.translate` in package.json:

| Mode | Behavior |
|------|----------|
| `off` | Pass command verbatim to PowerShell |
| `hint` *(default)* | Detect bash idioms, run as-is, append PS tip to stderr |
| `auto` | Rewrite bash to PS, run the PS version |

## Translation Support

### Basic Commands

| Bash | PowerShell |
|------|------------|
| `ls`, `ll`, `la` | `Get-ChildItem` |
| `pwd` | `Get-Location` |
| `cd dir` | `Set-Location` |
| `cat file` | `Get-Content` |
| `echo text` | `Write-Output` |
| `mkdir dir` | `New-Item -ItemType Directory` |
| `touch file` | `New-Item -ItemType File` |
| `rm -rf dir` | `Remove-Item -Recurse -Force` |
| `cp src dst` | `Copy-Item` |
| `mv src dst` | `Move-Item` |
| `grep pattern file` | `Select-String` |
| `find . -name "*.ts"` | `Get-ChildItem -Recurse \| Where-Object` |
| `which cmd` | `Get-Command \| Select-Object -ExpandProperty Source` |
| `ps` | `Get-Process` |
| `env` | `Get-ChildItem Env:` |
| `export VAR=val` | `$env:VAR = val` |
| `date` | `Get-Date` |
| `whoami` | `[WindowsIdentity]::GetCurrent().Name` |
| `sleep 5` | `Start-Sleep -Seconds 5` |
| `clear` | `Clear-Host` |
| `basename`/`dirname` | `Split-Path -Leaf`/`-Parent` |
| `test -f file` | `Test-Path -PathType Leaf` |
| `seq 1 10` | `1..10` |

### Pipe Chains

| Bash | PowerShell |
|------|------------|
| `ls \| grep foo` | `Get-ChildItem \| Where-Object { $_ -match 'foo' }` |
| `ls \| head -5` | `Get-ChildItem \| Select-Object -First 5` |
| `ls \| tail -3` | `Get-ChildItem \| Select-Object -Last 3` |
| `cat file \| sort` | `Get-Content file \| Sort-Object` |
| `cat file \| uniq` | `Get-Content file \| Select-Object -Unique` |
| `ls \| wc -l` | `Get-ChildItem \| Measure-Object -Line` |

### Native Passthrough

PowerShell cmdlets pass through unchanged:
- `Get-*`, `Set-*`, `New-*`, `Remove-*` etc. (Verb-Noun pattern)
- `$variable` expressions
- `&` call operator, `.` dot-source

## Settings

In `package.json` under `pi.ps`:

```json
{
  "pi": {
    "ps": {
      "executable": "auto",
      "translate": "hint",
      "strict": false,
      "utf8": true,
      "killTreeOnAbort": true,
      "aliasFile": "~/.pi-ps/aliases.json"
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_PS_EXEC` | auto | Override PowerShell executable path |
| `PI_PS_TRANSLATE` | hint | Translation mode: off, hint, auto |
| `PI_PS_STRICT` | 0 | Set `$ErrorActionPreference = 'Stop'` |
| `PI_PS_UTF8` | 1 | Enable UTF-8 encoding prefix |
| `PI_PS_KILL_TREE` | 1 | Kill process tree on abort |
| `PI_PS_LOAD_PROFILE` | 0 | Load user PS profile (default: -NoProfile) |
| `PI_PS_ALIAS_FILE` | ~/.pi-ps/aliases.json | Custom alias file |
| `PI_PS_TELEMETRY` | 0 | Enable local metrics recording |

## Shell Resolution

Probe order:
1. `$env:PI_PS_EXEC` override
2. `pwsh.exe` in PATH
3. `C:\Program Files\PowerShell\7\pwsh.exe`
4. Windows PowerShell 5.1

If none found: extension disables with a structured warning (never silently routes to bash).

## Diagnostics

```
/pi-ps doctor
```

Outputs: shell version, resolved path, profile path, execution policy, UTF-8 status, peer dep version, last 10 translations, warnings.

## Telemetry (Opt-in)

Set `PI_PS_TELEMETRY=1` to record to `~/.pi-ps/metrics.jsonl`:
- Command hash (SHA-256 truncated, never plaintext)
- Translation applied y/n
- Exit code
- Duration ms

**Never sent over the network.** Used purely for finding broken translations.

## Testing

```bash
npm test          # vitest run
npm run test:watch # vitest watch
npm run typecheck  # tsc --noEmit
```

117 tests covering:
- Tokenizer (quoted args, pipes, redirections, `&&`/`||`, semicolons)
- Every translation rule (+/- cases)
- Idempotency (no double-rewrite)
- Shell resolution
- Diagnostics
- Open-tab (Windows Terminal `new`/`clone`, fallback window, error path,
  path escaping)

## Requirements

- Windows (PowerShell 7+ recommended, or Windows PowerShell 5.1)
- Node.js 18+
- pi ≥ 0.74.0

## License

MIT
