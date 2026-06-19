# pi-ps

Robust PowerShell extension for [pi](https://pi.dev) on Windows — token-based
bash↔PS translation, background jobs, live background windows, diagnostics,
and local telemetry.

Published on npm as **`pi-powershell`** — this is the v2 rewrite of the
package (1.x used a fragile regex translator). The command is `/ps` and
the config dir is `~/.pi-ps/`.

## Why?

The earlier 1.x release used a fragile regex-based bash→PS translator that
broke on quoted args, spaces in paths, and nested pipes. This rewrite fixes
all of that:

- **Token-based parser** — handles quoted args, multi-pipe chains, redirections, subshells
- **3 translation modes** — `off` (verbatim), `hint` (tips only), `auto` (rewrite)
- **Proper kill-tree** — `taskkill /T /F` on abort, not just leader PID
- **Tracked background jobs** — `/ps job start` runs commands hidden with PID tracking and log files; inspect with `job log`, stop with `job kill`
- **Live background windows** — `/ps run` opens a visible PowerShell window (the direct successor to `run-bg.ps1`) for commands you want to watch
- **Open a new PowerShell tab** — `/ps new` and `/ps clone` spawn a
  separate PowerShell session beside pi (real Windows Terminal tab when
  available, otherwise a new window)
- **Diagnostics** — `pi-ps doctor` for troubleshooting
- **Local telemetry** — opt-in, privacy-first, never leaves your machine
- **120+ tests** — translator rules, shell resolution, diagnostics, open-tab, visible window

## Install

```bash
pi install npm:pi-powershell
```

Or local development:

```bash
pi -e ./src/extension.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/ps` | Show current status |
| `/ps doctor` | Full diagnostics (version, path, policy, UTF-8, peer deps) |
| `/ps translate "<cmd>"` | Dry-run translation (shows what would happen) |
| `/ps exec "<cmd>"` | Execute command explicitly through PS |
| `/ps new` | Open a new PowerShell tab at the standard location |
| `/ps clone` | Open a new PowerShell tab at pi's current path |
| `/ps run "<cmd>"` | Run a command in a new **live window** (replaces `run-bg.ps1`) |
| `/ps job start "<cmd>"` | Start a command as a tracked background job (hidden, logged) |
| `/ps job list` | List background jobs |
| `/ps job log <id>` | Show job output |
| `/ps job kill <id>` | Kill a background job |
| `/ps job cleanup` | Remove stale job files |

## Opening a New PowerShell Tab

Pi occupies your terminal while it runs. `/ps new` and `/ps clone`
spawn a **separate** PowerShell session beside it so you can run a manual
command without interrupting pi:

| Command | Opens at |
|---------|----------|
| `/ps new` | The standard location (your Windows Terminal default profile's starting dir) |
| `/ps clone` | Pi's current working directory (same path) |

Host detection is automatic:

- **Inside Windows Terminal** (`WT_SESSION` is set) → `wt.exe -w 0 new-tab`,
  a real new tab in the current window. The `-w 0` (a.k.a. `--window last`)
  option explicitly targets the most-recently-used WT window; without it,
  launching `wt.exe` as a detached child opens a brand-new window instead of
  reusing the current one (see [microsoft/terminal#5447](https://github.com/microsoft/terminal/issues/5447)).
  > **Note:** `-w 0` targets the *most-recently-used* window, not the window
  > identified by `WT_SESSION` (the `wt.exe` CLI cannot target windows by
  > session id). If you have several WT windows open and the MRU one isn't
  > the one running pi, the new tab will land in the MRU window. Click into
  > the pi window first to make it MRU.
- **Otherwise** (plain console / conhost) → `Start-Process pwsh`, a new window
  (there is no tab concept outside Windows Terminal). `new` opens at your home
  directory; `clone` opens at pi's cwd.

The tab/window always launches the same PowerShell pi is using (pwsh 7 if
available, otherwise Windows PowerShell 5.1).

## Running a Command in a New Window

`/ps run "<cmd>"` runs a command in a **separate, visible PowerShell
window** — the direct successor to the old `run-bg.ps1`. Use it for
long-running things you want to watch live (dev servers, file watchers,
tail logs) without them competing with pi for the current terminal:

```
/ps run "npm run dev"
/ps run "node server.js --port 3000"
```

The window stays open for as long as the command runs. The launcher is
hidden and fire-and-forget, so closing pi does not depend on it.

Prefer **`/ps job start "<cmd>"`** when you want a *hidden*, tracked
job with its output captured to a log file you can inspect later with
`/ps job log <id>` and stop with `/ps job kill <id>`.

## Background Jobs

`/ps job start "<cmd>"` runs a command as a **hidden, tracked** background
process — output is captured to a log file and the process is tracked by a
stable job id, so you can inspect or stop it later without keeping a window
open:

```
/ps job start "npm run build"
# → Started job job-1718793600001 (PID 12345)
```

| Command | Action |
|---------|--------|
| `/ps job start "<cmd>"` | Start a new background job |
| `/ps job list` | List tracked jobs (status, PID, command) |
| `/ps job log <id>` | Show captured output for a job |
| `/ps job kill <id>` | Kill a running job and its child processes |
| `/ps job cleanup` | Remove stale job files older than 24h |

Job metadata and logs live under `~/.pi-ps/jobs/` (`<id>.json` and `<id>.log`).
`job kill` uses `taskkill /T /F` so child processes are cleaned up rather
than orphaned.

**`run` vs `job start` — when to use which?**

- `/ps run` → you want to **see** it live (dev server, file watcher). Opens a visible window.
- `/ps job start` → you want it **out of the way** (build, export, long script). Hidden + logged.

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
/ps doctor
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

121 tests covering:
- Tokenizer (quoted args, pipes, redirections, `&&`/`||`, semicolons)
- Every translation rule (+/- cases)
- Idempotency (no double-rewrite)
- Shell resolution
- Diagnostics
- Open-tab (Windows Terminal `new`/`clone`, fallback window, error path,
  path escaping)
- Visible-window `run` (Start-Process launch, command embedding, quoting,
  error path)

## Requirements

- Windows (PowerShell 7+ recommended, or Windows PowerShell 5.1)
- Node.js 18+
- pi ≥ 0.74.0

## License

MIT
