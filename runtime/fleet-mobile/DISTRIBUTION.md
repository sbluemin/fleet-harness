# Fleet Mobile tester distribution

Two platforms, two channels: **Android** ships a release-signed APK to **Firebase App Distribution**
(below); **iOS** ships a release-signed IPA to **TestFlight** (see [iOS / TestFlight](#ios--testflight)).
Both build and sign in CI on a push to `main`, only when `runtime/fleet-mobile` changed, and only
when the platform's distribution flag is enabled.

The promoted debug APK is for the machine that built it. Handing the app to other people uses a
release-signed APK and Firebase App Distribution. Nobody on the receiving end needs USB debugging or
developer options — that is only how `adb install` works.

Release signing is opt-in. Without the four keystore variables below, `pnpm android:build:release`
stops before Gradle starts, and Gradle stops again on its own guard if it is invoked directly. A
release is never signed with the debug key, which every Android SDK install shares.

## One-time setup

### 1. Create the release keystore

Keep it outside the repository, and outside `~/.fleet` — that directory is Fleet's runtime data and
gets wiped or isolated by tooling. Losing the keystore is unrecoverable: a different key forces every
tester to uninstall before the next build will apply.

```sh
keytool -genkeypair -v \
  -keystore ~/.keystores/fleet-mobile-release.jks \
  -alias fleet-mobile -keyalg RSA -keysize 2048 -validity 10000
```

macOS has no system `keytool`; use the one inside Android Studio's bundled JDK at
`/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool`.

### 2. Firebase console (manual)

1. Create a project at <https://console.firebase.google.com>.
2. Add an **Android** app with package name `com.dotobokuri.fleet.mobile`. `google-services.json` is
   not needed — the shell embeds no Firebase SDK, and App Distribution uploads identify the app by id.
3. Open **Release & Monitor → App Distribution** and start it.
4. Create a tester group and add the tester email addresses. Each tester needs a Google account.
   `FIREBASE_TESTER_GROUPS` takes the group **alias** shown next to the group name, not the display
   name.
5. Copy the app id from **Project settings → Your apps** (`1:<number>:android:<hash>`).

### 3. Local CLI

```sh
npm install -g firebase-tools
firebase login
```

### 4. Environment

```sh
export FLEET_ANDROID_KEYSTORE="$HOME/.keystores/fleet-mobile-release.jks"
export FLEET_ANDROID_KEYSTORE_PASSWORD=...
export FLEET_ANDROID_KEY_ALIAS=fleet-mobile
export FLEET_ANDROID_KEY_PASSWORD=...
export FIREBASE_APP_ID=1:000000000000:android:0000000000000000
export FIREBASE_TESTER_GROUPS=friends       # or FIREBASE_TESTERS=a@example.com,b@example.com
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
```

Passwords belong in the shell environment or a secret manager, never in the repository. `*.keystore`
and `*.jks` are git-ignored so a stray copy cannot be committed, but the keystore should not live
here in the first place.

## Automatic distribution from `main`

`stable-release.yml` distributes a build on a push to `main`, on the same terms every other runtime
gets: **only when `runtime/fleet-mobile` actually changed.** The mobile shell is independently
versioned, like the desktop shell:

- The change baseline is the last `mobile-v*` marker tag, which is written only after a successful
  distribution. Once a marker exists, a release that did not touch `runtime/fleet-mobile`
  distributes nothing.
- **Until the first marker exists — initial enablement, or a first distribution that failed — every
  release distributes and bumps, changed or not.** That is what guarantees the retry: a failed run
  leaves no marker, and measuring from the previous release tag instead would hide the very changes
  that still need to ship.
- A `feat:` commit under `runtime/fleet-mobile` bumps the minor, anything else bumps the patch.
  `versionCode` increments by one on every bump, and both land in the release commit.
- `runtime/fleet-mobile/package.json` is swept into the workspace-wide version sync and does not
  reach the APK. `app.json` is the version the app carries.

The job is gated on the repository variable `FLEET_MOBILE_DISTRIBUTION` being `true`; without it the
mobile path is inert. It also needs these repository secrets:

| Secret | Value |
|---|---|
| `FLEET_ANDROID_KEYSTORE_BASE64` | `base64 -i ~/.keystores/fleet-mobile-release.jks` |
| `FLEET_ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `FLEET_ANDROID_KEY_ALIAS` | `fleet-mobile` |
| `FLEET_ANDROID_KEY_PASSWORD` | key password |
| `FIREBASE_APP_ID` | `1:<number>:android:<hash>` |
| `FIREBASE_TESTER_GROUPS` | group alias, e.g. `fleet-users` |
| `FIREBASE_SERVICE_ACCOUNT` | service account JSON (whole file contents) |

CI cannot run `firebase login`, so it authenticates with a service account: in the Google Cloud
console create one under the Firebase project, grant it **Firebase App Distribution Admin**, and
download a JSON key.

## Each round (manual)

The steps below are for distributing by hand. On `main` the workflow above does all of it.

1. Raise `expo.android.versionCode` in `app.json` — or run
   `node scripts/set-app-version.mjs --bump patch`, the same script CI uses. App Distribution keys a
   release by applicationId + versionCode + versionName, so reusing a triple **replaces** the
   previous release instead of notifying testers of a new one.
2. Build and verify:
   ```sh
   pnpm --dir runtime/fleet-mobile android:build:release
   ```
   This runs `expo prebuild`, assembles the release variant, promotes it to
   `dist/fleet-mobile-release.apk`, and verifies the result: fixed package, SDK levels, permission
   set, exported components, cleartext refusal, embedded JS bundle, `versionCode`/`versionName`
   agreement with `app.json`, and exactly one non-debug signer. A debuggable release fails the gate.
3. Distribute:
   ```sh
   pnpm --dir runtime/fleet-mobile android:distribute -- --notes "what changed"
   ```
   The distribute step re-verifies the promoted APK before uploading. `--notes` is optional; the
   default note carries the version and the artifact digest.

`pnpm android:verify:release` re-runs the verification alone against the already promoted artifact.

## What testers do

They get an invitation email, accept it with a Google account, and install from the link. Android
asks once to allow installing apps from that source — that prompt is the "unknown apps" permission,
not developer options. Firebase's optional **App Tester** app adds update notifications.

The app still needs a console to talk to: after install each tester pairs by pasting an access link
or scanning the console's QR code.

## Switching keys

The debug-signed builds installed by `adb` cannot be upgraded in place by a release-signed APK, and
neither can a release signed by a different keystore. Both cases require uninstalling first.

`dist/fleet-mobile-release.manifest.json` records the signing certificate digest as `signerSha256`,
and verification fails if the APK no longer matches it. Comparing that field between two promoted
manifests is how a rotated or wrong keystore is caught before testers are asked to uninstall.

## iOS / TestFlight

iOS testers install through **TestFlight**, not a sideloaded file: no Mac and no device registration
on the receiving end — testers accept a TestFlight invitation with an Apple ID and install from the
TestFlight app. Uploads are keyed by `CFBundleVersion` (`expo.ios.buildNumber`), so that integer moves
on every distributed build in lockstep with the Android `versionCode` (both bumped by
`scripts/set-app-version.mjs`).

Release signing is opt-in and fails closed: without the Apple certificate variables,
`pnpm ios:build:release` stops before `xcodebuild`, and the promoted IPA is rejected unless it is
signed with an **Apple Distribution** identity (never a development identity) and carries no
`get-task-allow` (debuggable) entitlement.

### One-time Apple setup (the repo owner does this; CI cannot)

1. **App ID** — in the Apple Developer portal, register bundle id `com.dotobokuri.fleet.mobile` (no
   extra capabilities; the app uses no special entitlements).
2. **Distribution certificate** — create an Apple Distribution certificate, export it as a `.p12`
   with a password. Keep it outside the repository and outside `~/.fleet`.
3. **Provisioning profile** — create an **App Store** distribution profile for that App ID and
   certificate; download the `.mobileprovision`.
4. **App Store Connect** — create the app record (name Fleet, the bundle id) and a TestFlight internal
   tester group (internal testers need no beta review and install immediately).
5. **ASC API key** — App Store Connect → Integrations → App Store Connect API → generate a key with
   the App Manager role; download `AuthKey_<KEY_ID>.p8` (it cannot be re-downloaded — store it safely).
6. **GitHub secrets** (the CI reads these names verbatim):
   - `FLEET_IOS_CERTIFICATE_BASE64` = `base64 -i dist.p12`, and `FLEET_IOS_CERTIFICATE_PASSWORD`
   - `FLEET_IOS_PROFILE_BASE64` = `base64 -i profile.mobileprovision`
   - `FLEET_ASC_KEY_ID`, `FLEET_ASC_ISSUER_ID`, `FLEET_ASC_KEY_BASE64` = `base64 -i AuthKey_*.p8`
7. **Repository variable** — set `FLEET_MOBILE_IOS_DISTRIBUTION` to `true` to arm the lane. Until it
   is set, the iOS distribution job is skipped, so the branch is never blocked on the Apple setup.

Gitignore already excludes `*.p12`, `*.mobileprovision`, and `AuthKey_*.p8`; never commit them.

### Running it

The iOS distribution job lives in `.github/workflows/mobile-release.yml` (`distribute-ios`). It runs
on `macos-15`, selects an Expo-compatible Xcode (26.x / Swift 6.2, which the
`patches/expo-modules-jsi@57.0.4.patch` makes buildable), materializes the certificate into a
throwaway keychain and the profile into place, runs `ios:build:release` then `ios:distribute`, and
wipes the signing material on exit. Trigger it manually via **workflow_dispatch** for the first
TestFlight upload, or let Stable Release call it on a mobile-changed release once the variable is set.

### Manual version bump

Run `node scripts/set-app-version.mjs --bump patch` (or `minor`). It moves `expo.version`,
`expo.android.versionCode`, and `expo.ios.buildNumber` together and prints `version=`, `versionCode=`,
and `buildNumber=`. Reusing a build number makes App Store Connect reject the upload.

### Switching Apple identities

A build signed by a different Apple team or distribution certificate cannot upgrade an install in
place; testers uninstall first. `dist/fleet-mobile-release.manifest.json` records the codesign
authority as `signerAuthority`, and verification fails if the IPA no longer matches the fixed iOS
contract — the same guard the APK manifest provides on Android.
