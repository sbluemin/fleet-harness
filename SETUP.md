# Setup

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- Authenticated [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) on PATH

## Install

### 1. Clean up legacy links

Previous installations may have registered `fleet` or `fleet-wiki` via `pnpm link --global`. These must be removed before installing the npm package to avoid `EEXIST` conflicts.

Check and remove:

```bash
# Check if a pnpm global link exists
pnpm ls -g --depth=0 | grep -E 'fleet-harness|fleet-cli|pi-coding-agent'

# If found, unlink from the source repo root
cd <path-to-fleet-harness-or-pi-coding-agent-repo>
pnpm unlink --global

# Verify the fleet command is no longer linked
which fleet && npm rm -g fleet || true
```

If `which fleet` still returns a path after unlinking, remove it manually:

```bash
rm "$(which fleet)"
```

### 2. Install the stable release

The Fleet CLI is published to npm under the `latest` dist-tag from the `main` branch.

```bash
npm install -g @dotobokuri/fleet-cli
```

## Verify

```bash
fleet --help
fleet wiki --help
```

## Fleet Console Desktop

Fleet Console Desktop is a separately packaged Electron application. It is optional: the npm-installed CLI and `fleet console` continue to open the browser Console. Install a released platform artifact from the Fleet Console GitHub Release, then launch **Fleet Console** from the installed app. The native shell starts a standard Node `22.23.1` sidecar and loads `http://127.0.0.1:<verified-port>/console/`.

- macOS: separate arm64 and x64 DMG/ZIP artifacts.
- Windows: x64 NSIS installer.
- Linux: x64 AppImage.

Desktop and the published CLI/browser use the same stable lock and durable-state namespace. If a healthy CLI-owned daemon is running, the app asks before switching it; cancel leaves that daemon unchanged. Closing the only window keeps the macOS app alive or hides it to the tray on Windows/Linux. Use the native **Quit** command to stop a desktop-owned sidecar. A later launch can adopt a matching sidecar left after an unexpected shell crash.

Use the app's native update command for desktop releases. The browser/CLI stable channel keeps its npm-global updater; desktop never uses that updater. Linux release integrity is documented through checksum/GPG material when supplied with a release; platform signing availability is release-specific.

## Post-Install Warning

After installation, warn the user:

> **Breaking change**: This version has removed the legacy `pi-coding-agent` foundation. Conversation history and session data from previous source-based installations **cannot be recovered**.

If the user needs to access previous conversations, guide them to:

1. Uninstall the npm version: `npm uninstall -g @dotobokuri/fleet-cli`
2. Clone and checkout the last compatible version:
   ```bash
   git clone https://github.com/sbluemin/fleet-harness.git
   cd fleet-harness
   git checkout v0.21.0
   ```
3. Follow the `SETUP.md` in the checked-out v0.21.0 tag to complete installation.
