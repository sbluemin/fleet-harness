# Desktop code signing & release

Fleet Console Desktop is published by the **Stable Release** workflow
(`.github/workflows/stable-release.yml`), which — after publishing `fleet-console`
and `fleet-cli` to npm and creating the draft GitHub Release — calls the reusable
**Desktop Release** workflow (`.github/workflows/desktop-release.yml`).

Build targets: **macOS arm64**, **Windows x64**. Windows arm64 is intentionally not
built (electron-builder's arm64 NSIS produces a malformed installer); Windows-on-ARM
users run the x64 build under emulation.

## Shell-only release model

GitHub Releases publish only native shell installers: macOS `.dmg`/`.zip` and Windows
`.exe`. The workflow always builds with `--publish never` and uses `gh release upload`
after package verification. It does not create or upload `latest*.yml` or `.blockmap`
files: Fleet Console Desktop has no `electron-updater` automatic-update channel.

The signed shell is a one-time download. It procures and updates Fleet Console at runtime
from the npm registry; the Console package's registry `shasum` integrity metadata, rather
than the shell installer signature, is the trust basis for downloaded Console code.

Signing is **conditional**: the workflow ships working (unsigned) shell installers today
and automatically starts signing once the secrets/variables below are configured.

## Current status (no certificates)

| Platform | Signed? | Note |
|---|---|---|
| Windows x64 | ❌ (until SignPath configured) | SmartScreen warning on first install |
| macOS arm64 | ❌ (until Apple cert configured) | dmg/zip download works; unsigned apps need right-click → Open on first launch |

## Windows — SignPath (free for open-source)

[SignPath Foundation](https://signpath.org) signs OSS projects for free. When configured,
the Windows job builds and verifies the shell installer, signs it via SignPath, then uploads
the signed `.exe` to the draft release. No updater manifest is rewritten or published.

**One-time setup (only a maintainer can do this):**

1. Apply to the SignPath Foundation OSS program and create an **Organization**.
2. Connect this GitHub repository as a **Trusted Build System** (GitHub Actions connector).
3. Create a **Project**, a **Signing Policy** (e.g. `release`), and an
   **Artifact Configuration** for a single `.exe`.
4. Create a **CI user + API token**.

**Then add these to the GitHub repo** (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organization ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | project slug (**presence of this turns signing on**) |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | signing policy slug |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | artifact configuration slug |
| Secret | `SIGNPATH_API_TOKEN` | SignPath REST API token |

Notes:
- The **free tier requires manual approval per signing request**. The workflow waits up
  to 30 minutes (`wait-for-completion-timeout-in-seconds: 1800`) — approve the request in
  the SignPath dashboard while the release job runs.
- v1 signs the **installer** (clears the download SmartScreen prompt). Deep-signing the
  inner binaries (installed `Fleet Console.exe` + native `.node`/`.dll`) — which SignPath
  can't reach inside NSIS — is a follow-up if you want the *installed* app fully signed;
  see the approach used by `stablyai/orca` (build `--dir` → batch-sign inner PEs → repackage).

## macOS — deferred (paid Apple Developer)

An Apple Developer account ($99/yr) is required for a Developer ID signature and
notarization. When you obtain it, add these secrets and the mac job signs + notarizes
automatically (no workflow change):

| Kind | Name |
|---|---|
| Secret | `MAC_CSC_LINK` (base64 of the Developer ID `.p12`) |
| Secret | `MAC_CSC_KEY_PASSWORD` |
| Secret | `APPLE_ID` |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` |
| Secret | `APPLE_TEAM_ID` |

## Cross-building Windows x64 on an arm64 host

Windows ships x64 only, but a dev machine may be Windows-on-ARM (e.g. Apple Silicon +
Parallels). Packaging is fixed to **win32-x64** on Windows regardless of host arch, so
`pnpm desktop:package:dir` / `:unsigned` produce an x64 build there too (it runs under
emulation for local testing). This requires the `@esbuild/win32-x64` package, which the
root `package.json` `pnpm.supportedArchitectures` config installs on any host.

## Validation

Each CI job runs `verify:package` after packaging. The gate requires a shell-only ASAR,
secure Electron fuses, no embedded runtime payload or sidecar directory, no updater
metadata, and an Electron binary whose architecture matches the artifact directory.

Windows/macOS release runners and signing credentials are unavailable locally, so the
first real release run remains **[Unverified]**: confirm that only the expected installers
are attached to the draft release and that the conditional signing paths complete.
