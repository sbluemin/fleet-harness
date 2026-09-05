# Console E2E platform automation

Use this reference when agent-browser availability or the behavior under test depends on the host OS, CPU architecture, keyboard path, PTY, or renderer.

## Select the automation binary

Record these separately before testing:

- test host OS and architecture;
- agent-browser binary OS and architecture;
- browser engine and headed/headless mode;
- product layers actually exercised, such as Console, xterm.js, node-pty, ConPTY, and the child CLI.

Prefer the official native agent-browser binary matching the host. If the package wrapper fails, preserve the error as environment evidence before applying a supported fallback.

### Windows ARM64 fallback

Replace `<session-scratchpad>` below with the absolute scratchpad path supplied by this session before executing PowerShell. It is a placeholder, not a Windows directory name.

agent-browser may publish `win32-x64` without `win32-arm64`. Windows ARM64 can run the official x64 binary through OS emulation. Use the exact version already placed in the npm npx cache and download only its matching official GitHub release asset.

```powershell
# This expected failure also populates the npx cache when the package is absent.
npx --yes agent-browser skills get core --full

$packages = Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Directory |
  ForEach-Object { Join-Path $_.FullName "node_modules\agent-browser" } |
  Where-Object { Test-Path (Join-Path $_ "package.json") }
$packageRoot = $packages |
  Sort-Object { (Get-Item (Join-Path $_ "package.json")).LastWriteTimeUtc } -Descending |
  Select-Object -First 1
if (-not $packageRoot) { throw "agent-browser package not found in the npx cache" }

$version = (Get-Content -Raw (Join-Path $packageRoot "package.json") | ConvertFrom-Json).version
$toolDir = Join-Path '<session-scratchpad>' "fleet-agent-browser-$version-$PID"
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
gh release download "v$version" -R vercel-labs/agent-browser `
  -p "agent-browser-win32-x64.exe" -D $toolDir

$env:AGENT_BROWSER_SKILLS_DIR = Join-Path $packageRoot "skill-data"
$ab = Join-Path $toolDir "agent-browser-win32-x64.exe"
& $ab skills get core --full
& $ab skills get dogfood
```

Use `& $ab ...` for every subsequent command. If Windows x64 emulation cannot execute the official binary, stop and report the environment block. Do not rename an x64 binary to appear ARM64, use a third-party build, or replace agent-browser while claiming the `console-e2e` workflow ran.

Keep the binary in an owned temporary directory. After closing the owned browser session, remove only that verified directory when evidence retention does not require it.

## Interpret the evidence correctly

An x64 agent-browser running under Windows ARM64 emulation is a valid CDP automation client. It can exercise a real Windows Console, browser DOM, xterm.js, node-pty, ConPTY, and child CLI path. Its architecture does not establish the architecture of Chrome, Node.js, node-pty, or the child process; record those separately when they matter.

`press` and `keyboard` commands create CDP keyboard events, not physical scan-code input. They are valid evidence for browser event handling and downstream PTY behavior once the application receives the event. They do not prove:

- physical keyboard layout or IME hardware behavior;
- native menu accelerators or OS-level hotkeys;
- architecture-specific browser or native-module behavior unless those processes were independently identified.

For a keyboard defect, report both the automated boundary and any remaining manual check. Example:

> Windows ARM64 host; official win32-x64 agent-browser ran under Windows emulation. Headed CDP input exercised Console → xterm.js → node-pty/ConPTY → child CLI. Physical-keyboard scan-code behavior remains unverified.

Never shorten this to “native Windows ARM64 agent-browser verification.”
