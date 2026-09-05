# Desktop E2E platform automation

Use this reference when the automation client or Desktop claim depends on OS, CPU architecture, native UI, packaging, signing, keyboard input, or CDP availability.

## Separate client and target architecture

Record these as independent facts:

- host OS and architecture;
- agent-browser binary OS and architecture;
- Electron executable and packaged artifact architecture;
- Console sidecar, Node.js, and native-module architecture when relevant;
- lane tested: Shell/CDP, Native, Runtime, or Package.

The agent-browser binary is only the CDP client. Its architecture never proves the architecture of Electron, the Console sidecar, a packaged artifact, or a native dependency.

### Windows ARM64 fallback

Replace `<session-scratchpad>` below with the absolute scratchpad path supplied by this session before executing PowerShell. It is a placeholder, not a Windows directory name.

If the installed agent-browser wrapper reports `No binary found for win32-arm64`, use the matching official `win32-x64` release binary through Windows ARM64 x64 emulation:

```powershell
# Preserve this expected failure as environment evidence and populate the npx cache.
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
& $ab skills get electron
& $ab skills get dogfood
```

Use `& $ab ...` for all CDP commands. If Windows cannot execute the official x64 asset, mark the Shell/CDP lane blocked. Do not use an unofficial ARM64 build or a different browser tool while reporting that `desktop-e2e` ran.

## Lane-specific evidence

An emulated x64 CDP client can validly connect to an ARM64 or x64 Electron instance because CDP is a protocol boundary. It can verify renderer URL, sandbox globals, Console handoff, DOM state, browser errors, and screenshots.

It cannot by itself verify:

- native menus, tray, dialogs, single-instance focus, or physical keyboard accelerators;
- Electron, ASAR, installer, or native-module architecture;
- Authenticode, signing, or release trust;
- physical IME and scan-code behavior.

Use Playwright Electron, platform-native inspection, package verification, or a manual headed check for those claims. A CDP `press` is not native accelerator evidence. Record artifact architecture from the package output or executable metadata, not from agent-browser.

Report the fallback explicitly. Example:

> Windows ARM64 host; official win32-x64 agent-browser ran under Windows emulation for the Shell/CDP lane. Electron and package architecture were verified separately. Native menu and physical-keyboard behavior remain unverified.

Never call this a native ARM64 agent-browser run. Close the owned session and Electron process first, then remove only the verified temporary tool directory when it is no longer needed.
