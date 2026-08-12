# Fleet Mobile tester distribution

The promoted debug APK is for the machine that built it. Handing the app to other people uses a
release-signed APK and Firebase App Distribution. Nobody on the receiving end needs USB debugging or
developer options — that is only how `adb install` works.

Release signing is opt-in. Without the four keystore variables below, `pnpm android:build:release`
stops before Gradle starts, and Gradle stops again on its own guard if it is invoked directly. A
release is never signed with the debug key, which every Android SDK install shares.

## One-time setup

### 1. Create the release keystore

Keep it outside the repository. Losing it is unrecoverable: a different key forces every tester to
uninstall before the next build will apply.

```sh
keytool -genkeypair -v \
  -keystore ~/.fleet/fleet-mobile-release.jks \
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
5. Copy the app id from **Project settings → Your apps** (`1:<number>:android:<hash>`).

### 3. Local CLI

```sh
npm install -g firebase-tools
firebase login
```

### 4. Environment

```sh
export FLEET_ANDROID_KEYSTORE="$HOME/.fleet/fleet-mobile-release.jks"
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

## Each round

1. Raise `expo.android.versionCode` in `app.json`. App Distribution keys a release by
   applicationId + versionCode + versionName, so reusing a triple **replaces** the previous release
   instead of notifying testers of a new one. Raise `expo.version` too when the user-visible version
   changes.
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
neither can a release signed by a different keystore. Both cases require uninstalling first. The
verification output prints the signing certificate digest so a key change is visible before it ships.
