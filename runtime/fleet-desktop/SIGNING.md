# Desktop code signing & release

Fleet Console Desktop is published by the **Stable Release** workflow
(`.github/workflows/stable-release.yml`), which — after publishing `fleet-console`
and `fleet-cli` to npm and creating the draft GitHub Release — calls the reusable
**Desktop Release** workflow (`.github/workflows/desktop-release.yml`).

Build targets: **macOS arm64**, **Windows x64**. Windows arm64 is intentionally not
built (electron-builder's arm64 NSIS produces a malformed installer); Windows-on-ARM
users run the x64 build under emulation.

## Shell-only release model

GitHub Releases publish native shell installers — macOS `.dmg`/`.zip` and Windows `.exe` —
together with the updater metadata that lets an installed shell replace itself:
`latest-mac.yml`, `latest.yml`, and the `.blockmap` files beside them. The workflow always
builds with `--publish never` and uses `gh release upload` after package verification, so
uploading stays an explicit workflow step rather than a build side effect.

Artifact names must not contain spaces. GitHub rewrites spaces in an uploaded asset name to
periods while `electron-updater` rewrites them to hyphens, so a single space desynchronizes
the two and every update download 404s.

The shell installer is downloaded once by hand; after that the shell updates itself from the
same releases. It still procures and updates Fleet Console separately at runtime from the npm
registry — the Console package's registry `shasum` integrity metadata, rather than the shell
installer signature, is the trust basis for downloaded Console code, and the two versions stay
independent.

Windows installers are **unsigned by design**, which is also why no step may rewrite or replace
the installer after packaging: the hash recorded in `latest.yml` belongs to the file produced by
that build, and a substituted file fails the updater's integrity check. macOS release packaging
is fail-closed — missing credentials fail the mac job; it does not publish an unsigned installer.
Squirrel.Mac requires the signed, notarized `.zip`, so macOS self-update depends on that job.

## Current status

| Platform | Signed? | Note |
|---|---|---|
| Windows x64 | ❌ by design | SmartScreen warning on first manual install |
| macOS arm64 | Required (Developer ID Application + notarization) | Repository Actions secrets; job fails if any of the five is missing |

## Windows — unsigned by design

The Windows job builds, verifies and uploads the installer as produced. Nothing signs or
rewrites it afterwards, so the hash in `latest.yml` always matches the uploaded `.exe` and
self-update passes its integrity check.

A first manual install therefore shows a SmartScreen publisher warning. Updates applied by
the installed shell run an installer the app downloaded itself, so they do not go through
the browser download path that attaches the mark of the web. [Unverified] — confirm on a real
Windows host before claiming the update path is warning-free.

## macOS — Developer ID (fail-closed)

An Apple Developer account ($99/yr) is required. The mac job uses repository Actions
secrets for **Developer ID Application** signing plus notarization. All five secrets are
required; missing credentials fail the job. There is no unsigned public-release fallback.

Add these under Settings → Secrets and variables → Actions → Repository secrets:

| Kind | Name |
|---|---|
| Secret | `MAC_CSC_LINK` (base64 of the Developer ID Application `.p12`) |
| Secret | `MAC_CSC_KEY_PASSWORD` |
| Secret | `APPLE_ID` |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` |
| Secret | `APPLE_TEAM_ID` |

The signed release path was verified by the v1.65.0 macOS job and its published DMG
(Developer ID authority, notarization ticket, and Gatekeeper acceptance).

## Cross-building Windows x64 on an arm64 host

Windows ships x64 only, but a dev machine may be Windows-on-ARM (e.g. Apple Silicon +
Parallels). Packaging is fixed to **win32-x64** on Windows regardless of host arch, so
`pnpm desktop:package:dir` / `:unsigned` produce an x64 build there too (it runs under
emulation for local testing). This requires the `@esbuild/win32-x64` package, which the
root `package.json` `pnpm.supportedArchitectures` config installs on any host.

## Validation

Each CI job runs `verify:package` after packaging. The gate requires a shell-only ASAR,
secure Electron fuses, no embedded runtime payload or sidecar directory, and an Electron
binary whose architecture matches the artifact directory. Release artifact verification
additionally requires updater metadata that names the packaged version.
The mac job additionally runs `verify:package --release` (Developer ID Application
authority, stapler validate, and `spctl` assess).
