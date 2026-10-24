# Mobile shell reproduction

Reproduce a Fleet Mobile (`runtime/fleet-mobile`) behavior, such as a cold start with an access link, on your own emulator or simulator against your own isolated Console. The Console half reuses [Isolated Console setup](setup.md) and [Remote access testing](remote-access-testing.md); this page covers only what mobile changes. Native Android and iOS behavior is not covered by the browser lanes, and a claim stays unverified until it runs on a real emulator or simulator.

## Briefing a reproduction

When a counter or state (an attempt count, a retry flag) looks like the cause, list **every caller that changes it** — init, resume, retry, and any other — before naming one as the cause, and have the reproduction exercise each of them. Naming one caller from the first reading is how a fix lands on the wrong path.

## 0. Pick names and run the preflight

Choose one unique `RUN` id and keep its values for the whole run: Console data root `$E2E_DIR`, your AVD name, your emulator port (an even number 5554–5680 that no listed emulator uses), and so on. Everything below is addressed by these values, never by "the running emulator".

**Shell variables do not survive between tool calls.** Put them in one env file and `source` it at the start of every step:

```bash
ENVF=<abs scratch dir>/fleet-mobile-<id>.env     # replace every <…> with a literal value
cat > "$ENVF" <<'EOF'
export E2E_DIR=<abs dir> AVD=fleet-repro-<id> PORT=<even port> SERIAL=emulator-<port>
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"   # must be set; ANDROID_HOME, if set, must match
export JAVA_HOME="<jdk path from the preflight>"      # avdmanager/sdkmanager need it; the build scripts do not
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
EOF
source "$ENVF"
node <worktree>/runtime/fleet-mobile/scripts/mobile-preflight.mjs [--platform android|ios] [--json]
```

Record the preflight's `adb server` state (running or not running) in the report; cleanup depends on it. The preflight is read-only and starts nothing. Exit `0` means every required check passed; `20` means a `FAIL` line names what is missing and prints its fix. Its verdicts come from the build scripts' own functions (`scripts/lib/android-tools.mjs`, `ios-tools.mjs`), so a pass means `android:build:debug` will accept the toolchain. JDK: the build scripts use Android Studio's bundled JDK on macOS and ignore `JAVA_HOME` outside CI (override with `FLEET_ANDROID_JAVA_HOME`); `avdmanager` and `sdkmanager` do the opposite and need `JAVA_HOME`, which the `jdk-cmdline-tools` note spells out. The `NOTE … in-use` lines list adb devices, running emulators, and booted simulators: they belong to someone else. Do not use, restart, or kill them.

If `ios/xcode-license` or `ios/xcode-first-launch` is `FAIL`, stop before starting work and send a decision request to the commander or person for host setup. Agents do not accept the Xcode license or run `sudo` to install first-launch components; an unaccepted license can also block `xcodebuild`, `simctl`, and `/usr/bin/git` with exit `69`.

## 1. Start your own Consoles

Per Console, follow [Isolated Console setup](setup.md#isolate-the-console) with its own `E2E_DIR` (all four of `FLEET_DATA_DIR`, `FLEET_CONSOLE_DATA_DIR`, `FLEET_DESKTOP_DATA_DIR`, `CLAUDE_CONFIG_DIR` under it), started as a background process whose PID you record: `CONSOLE_PID=$!`, appended to the env file with `EMU_PID` and `UDID`. A Console handed on to later missions must be detached (`nohup … & disown`); a tool-managed background job is stopped at its time limit. For two Consoles, use two `E2E_DIR`s; nothing is shared. Read each port with the [fixed lock read](setup.md#read-the-lock-without-the-token) of that Console's `$E2E_DIR/console/console.lock` and check it answers `200`; `issue-access-link.mjs` reads the token itself. Do not touch `127.0.0.1:50000` or any Console whose lock is not under your `E2E_DIR`.

## 2. Issue an access link

Use the listener and `/api/v1/access-links` procedure in [Remote access testing](remote-access-testing.md#turn-the-listener-on). What mobile changes:

- **Address.** The remote listener must bind this machine's LAN address, taken from the default-route interface: `export BIND=$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2}')")`. Stop if it is empty (`en0` is not always the default interface). The emulator reaches that address directly, so use the link exactly as issued. `10.0.2.2` is the emulator's alias for host *loopback* and cannot reach this listener. A simulator shares the host network and uses the same link.
- **Format.** `fleet://join?code=<base64url envelope>`; nothing else in the query (see `protocol/remote/index.ts`).
- **Secrecy.** The link carries a one-time credential. [`scripts/issue-access-link.mjs`](../scripts/issue-access-link.mjs) enables the listener, checks `listener.listening` (response shape in [Remote access testing](remote-access-testing.md#turn-the-listener-on)), and writes the link to an owner-only `$E2E_DIR/link.txt` without printing it or the lock token. Pass it to the device by command substitution; do not echo, log, or report it.

```bash
BIND="$BIND" node <worktree>/.claude/skills/console-e2e/scripts/issue-access-link.mjs "$E2E_DIR" [full|monitoring]
```

A link is single-use. Run it again for every launch attempt. Each run overwrites `link.txt`, so when two devices share one `E2E_DIR`, use the link right after issuing it. A Console serves one paired device at a time; after a Console restart the first device to reconnect takes the session, so stop the other device's app before reconnecting the one under test.


## Phone conversation fixture

The access link only pairs the phone. What stands on the screen is Console state. Both of the following are absent until a throwaway Theater is registered ([Isolate the Console](setup.md#isolate-the-console)).

- No Theater: the phone home is the empty first-run, not a conversation (`MobileEmptyHome` in `runtime/fleet-console/core/client/src/chrome/mobile/mobile-shell.tsx`). The Commodore screen stays an empty pane until it resolves that Theater's commodore UUID (`commodore-mobile.tsx`). Its no-cost host uses [No-cost fake Commodore](setup.md#no-cost-fake-commodore): keep the SDK path and select the fake executable through `CLAUDE_BIN`; do not launch the real CLI or a provider turn.
- The group composer (`.group-composer` / `.fc-composer-capsule`) is not the 1:1 composer (`.agent-chat-composer`). `showsMobileGroupConversation` in `runtime/fleet-console/features/execution/client/agent/chat/group-timeline-store.ts` requires all of: the phone objective surface, fold-turns on, a live chat (`chatMode` and `chatActive`), and a group root. The fold-turns switch defaults off. In a browser it is the page's `localStorage` key `fleet-console.groupConversation.foldTurns` (`on`). The phone WebView keeps no such file in the app container, so writing that key on the host does not turn the switch on in the app. On the phone, turn it on from the conversation info screen ([Fold turns on the phone](#fold-turns-on-the-phone)). A fresh simulator is off, so a commander still shows the 1:1 composer. A restored chat commander qualifies without resume because its chat adapter stays live; the [child-session fixture](setup.md#objective-member-child-session-fixture) must use `chatMode: true`. A restored terminal fixture is still dormant and does not qualify. The root is an objective commander (`isGroupConversationRoot`) or a chat that already has nested members.

In the browser lane the group composer is up when the page shows `.group-composer` inside the objective. The first-run home and `.agent-chat-composer` are not that screen. The phone WebView does not expose those classes; judge it by the labels in [Fold turns on the phone](#fold-turns-on-the-phone).

`POST /api/v1/agent/sessions` with `parentObjectiveId` does not create that nested member. `childSessionId` is accepted only when the caller is a plugin (`features/execution/host/agent/routes.ts`), so the same POST from the page creates a second top-level objective. Use the stopped-state edit in the [child-session fixture](setup.md#objective-member-child-session-fixture), on a chat that fake Claude already started:

1. Boot with [No-cost fake Claude](setup.md#no-cost-fake-claude). Register a throwaway Theater with `POST /api/v1/theaters/folder-grants` then `POST /api/v1/theaters`, and do not send `claudeTrustConsent`.
2. `POST /api/v1/agent/sessions` with `{ "commodoreId", "cliId": "claude", "theaterId", "viewMode": "chat" }` (the `commodoreId` from `commodore/resolve`; a session without it is refused as `commodore_required`) and the page `Origin`. Record `sessionId`. `chatActive` becomes true.
3. Stop that Console. Follow the linked child-session fixture to add one `sessions` entry in the generated `commodore/<uuid>/objectives/<id>/objective.json`, using that objective's root `cwd`. Keep its id and other metadata unchanged; do not put it in `state.json`.
4. Start again with the same wrapper flags. The restored chat has `status: "registered"`, `chatActive: true`, and `sessions` still present, with no SDK child until a message or explicit preparation. Do not call resume: it is terminal-only. Merely viewing the conversation may replay its journal but does not open an SDK child.
5. Phone layout is a viewport at `max-width: 767px` (`view-mode-store.ts`), which sets `documentElement.dataset.viewMode` to `mobile`. After the origin has loaded, set `localStorage["fleet-console.groupConversation.foldTurns"]` to `on` and reload. Setting it before any page has loaded does not stick.

Checked in a browser at 390×844, not on a phone: `viewMode` was `mobile`, `.group-composer` was present, `.agent-chat-composer` was absent, and the fold key was `on`.


## 3. Android

**Your AVD** (never reuse one from the preflight's `avd` note that you did not create). Use the package id the preflight's `system-image` line prints (`arm64-v8a` on Apple silicon, `x86_64` elsewhere):

```bash
echo no | avdmanager create avd -n "$AVD" -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7; echo "avdmanager exit $?"
emulator -avd "$AVD" -port "$PORT" -no-window -no-audio -no-snapshot-save -no-boot-anim > "$E2E_DIR/emulator.log" 2>&1 &
EMU_PID=$!; echo "export EMU_PID=$EMU_PID" >> "$ENVF"
for i in $(seq 1 120); do
  kill -0 $EMU_PID 2>/dev/null || { echo "emulator died"; tail "$E2E_DIR/emulator.log"; break; }
  [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && { echo booted; break; }
  sleep 2
done
```

The `echo no` answers the custom-hardware-profile prompt; read the exit code without a trailing pipe. Do not use `adb wait-for-device`: it waits forever when the emulator exits at once (for example an unknown AVD). Stop unless the loop printed `booted`. Use `-no-window` unless the claim needs pixels; a visible emulator window can take the user's focus. Every adb call carries `-s "$SERIAL"`; a bare `adb` command is refused here because other sessions' devices are attached.

**Build and install the debug APK.** The existing script prebuilds, runs Gradle, and verifies the manifest; it takes minutes and replaces the checkout's `runtime/fleet-mobile/android/`.

```bash
pnpm --dir <worktree>/runtime/fleet-mobile android:build:debug     # → dist/fleet-mobile-debug.apk
adb -s "$SERIAL" install -r <worktree>/runtime/fleet-mobile/dist/fleet-mobile-debug.apk
```

**Cold-start with the link.** Package `com.dotobokuri.fleet.mobile`; the `fleet://join` VIEW intent filter belongs to the exported `FleetLinkActivity`, which consumes the URI and forwards to `MainActivity` (the app never lets JS read the URI). Quote the link inside the device shell:

```bash
adb -s "$SERIAL" shell am force-stop com.dotobokuri.fleet.mobile
adb -s "$SERIAL" shell "am start -W -a android.intent.action.VIEW -d '$(cat "$E2E_DIR/link.txt")' com.dotobokuri.fleet.mobile"
```

`am start -W` must print `Status: ok`. A link already consumed or an unreachable address shows up in the app, not here, so confirm the result below. For a warm-start comparison, run the second command without the `force-stop`.

**Observe.** Screenshot to an absolute path outside the worktree: `adb -s "$SERIAL" exec-out screencap -p > <evidence>/shot.png`. App-side logs: `adb -s "$SERIAL" logcat -d | grep -i -e ReactNativeJS -e AndroidRuntime`. The shell logs nothing when it refuses a navigation; judge from the screenshot and `adb -s "$SERIAL" shell dumpsys activity activities | grep topResumedActivity` (an OS browser takes over there, a refusal leaves `MainActivity`). Console-side proof that the device paired: the owner's Settings → Remote access table, or the device count in `$E2E_DIR/console/remote/paired-devices.json` (count only; the file holds device names).

**Desktop-only surfaces.** The mobile layout opens no companion panel such as the Session Browser. To reach one, tap the view-mode toggle in the Objectives header until it shows desktop (auto → mobile → desktop). At a phone's physical density the desktop view clips the bottom row of a companion panel; on your own emulator, `adb -s "$SERIAL" shell wm density 200` in landscape widens the viewport enough (undo with `wm density reset`). A density change recreates the activity and reloads the page.

## 4. iOS simulator

Same Console and link as above; the simulator needs no address change. There is no promoted debug-build script for iOS (`ios:build:release` needs signing material), so build an unsigned simulator app using the path in `.github/workflows/mobile-ios-verify.yml`, then install it separately. Use `-configuration Release` so the JS bundle is embedded; a Debug build without a running Metro shows the React Native red error screen. Generate `ios/` in your worktree. Export `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` once for the `pod install` and `xcodebuild` subshell below; a prefix on the `pod` line alone leaves `xcodebuild` on the host locale. The simulator's language is a separate setting ([Simulator language](#simulator-language)). Do not use `expo run:ios`: its host GUI side effects can open Simulator.app; the build/install path below starts neither Metro nor Simulator.app:

```bash
xcrun simctl list runtimes available; xcrun simctl list devicetypes iPhone   # pick an installed iOS runtime id and iPhone device type id
xcrun simctl create "$SIM_NAME" "<device type id>" "<runtime id>"   # prints your UDID
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID"   # wait until this boot finishes; usage from simctl help bootstatus
# Shell LANG does not change the simulator. Set its language, then boot again, before any UI. This UDID only.
xcrun simctl spawn "$UDID" defaults write "Apple Global Domain" AppleLanguages -array en
xcrun simctl spawn "$UDID" defaults write "Apple Global Domain" AppleLocale -string en_US
xcrun simctl shutdown "$UDID"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID"
xcrun simctl spawn "$UDID" defaults read "Apple Global Domain" AppleLocale   # expect en_US
pnpm --dir <worktree>/runtime/fleet-mobile exec expo prebuild --platform ios --clean --no-install --non-interactive
(
  set -e
  cd <worktree>/runtime/fleet-mobile/ios
  export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
  pod install
  workspace=$(ls -d *.xcworkspace | head -n 1)
  [ -n "$workspace" ] || { echo 'Expo prebuild produced no .xcworkspace' >&2; exit 1; }
  scheme="${workspace%.xcworkspace}"
  # Reusing this derived data keeps the previous main.jsbundle or a stale Pods input. See Incremental xcodebuild.
  rm -rf "$E2E_DIR/ios-build"
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$E2E_DIR/ios-build" CODE_SIGNING_ALLOWED=NO build
  app=$(ls -d "$E2E_DIR"/ios-build/Build/Products/Release-iphonesimulator/*.app 2>/dev/null | head -n 1)
  [ -n "$app" ] && [ -f "$app/main.jsbundle" ] || { echo 'Simulator app or embedded main.jsbundle missing' >&2; exit 1; }
  xcrun simctl install "$UDID" "$app"   # installs com.dotobokuri.fleet.mobile only
)
xcrun simctl terminate "$UDID" com.dotobokuri.fleet.mobile || true   # exit 3, "found nothing to terminate", when the app has never launched
xcrun simctl openurl "$UDID" "$(cat "$E2E_DIR/link.txt")"
node <worktree>/.claude/skills/console-e2e/scripts/accept-ios-open.mjs "$UDID" <absolute scratch dir>
```

`simctl terminate` exits 3 with `found nothing to terminate` when the app is not running. That is the state right after install. It is not a failed install. Continue to `openurl`. `|| true` hides only that exit code. The stderr line still prints, and that line is the same harmless case.

`openurl` raises the system alert and does not tap it. [`accept-ios-open.mjs`](../scripts/accept-ios-open.mjs) writes a host app and a UI test under the scratch directory, outside the repository, and runs `xcodebuild test -destination id=$UDID`. The test taps the SpringBoard button named `Open`. It does not boot, install, or delete a simulator, and it does not open Simulator.app. Exit 0 is `** TEST SUCCEEDED **`. The link was consumed when `GET /api/v1/access-links` on the owner reports `devices` length 1 and that device has a `sessionHandle`. Count only. This path was run on a simulator this session created (iOS 26.5): install exit 0, terminate exit 3, openurl exit 0, the test exit 0, and `devices` length 1.


### Fold turns on the phone

After the app is paired, the conversation list is not the group composer. Fold turns is off, and the 1:1 field's label is `Message`. The phone turns it on through the info screen, not through a host-side `localStorage` file.

[`fold-ios-turns.mjs`](../scripts/fold-ios-turns.mjs) writes its own scratch project (`<scratch>/ios-fold-turns`). It does not change [`accept-ios-open.mjs`](../scripts/accept-ios-open.mjs). Pass the conversation title, the same string the info button uses (`{title} info`, `mobile.conv.infoAria`):

```bash
node <worktree>/.claude/skills/console-e2e/scripts/fold-ios-turns.mjs "$UDID" <absolute scratch dir> "<objective title>"
```

`XCUIApplication(bundleIdentifier:).activate()` does not relaunch the app. A screen an earlier test left open stays open, so a test that only looks for `Fold turns` can pass because the info screen was already showing. From the conversation list the order is the conversation row (its label contains the title), then the button `<title> info`, then `Fold turns`, then `Back`. The script takes that order, and skips ahead when `Fold turns` or `<title> info` is already on screen.

Exit 0 is `** TEST SUCCEEDED **`. The group composer is up when the accessibility tree has a text view labeled `Group conversation message`, placeholder `Message the commander · @ to pick a member`, and switches `Plan` and `Commence`. A notice `Can't read <member> — there is no saved record, or the session runs in a terminal.` is expected: the fixture member has no saved transcript. It is not a failed composer.

This script was not run again for this write. The labels and the `activate()` continuation are the measurement that tapped `Fold turns` then `Back` on a paired app and recorded those labels.


### Simulator language

On a Mac whose language is not English, a simulator from `simctl create` boots in the Mac's language. SpringBoard and the "Open in Fleet?" alert are then not the English strings this page names, and the app's own shell strings follow the device locale (`shellStrings` in `runtime/fleet-mobile/shell/strings.ts`). A driver looking for the English label finds nothing or taps the wrong control. The shell `LANG` exported for CocoaPods does not write the simulator's preferences. The `defaults write` commands above set `AppleLanguages` and `AppleLocale`, and the second `simctl boot` is the one that picks them up. Stop when `defaults read` prints `en_US`. On a simulator created for this check, that read printed `en_US` after the second boot. Do not spawn on a UDID this run did not create.

### Incremental xcodebuild

A later `xcodebuild build` into the same `$E2E_DIR/ios-build` can exit 0 while the installed app still runs the previous `main.jsbundle`. The existence check above still passes, because the old bundle is present. After `expo prebuild --clean`, that leftover directory can instead fail on a stale Pods or module input. Xcode's incremental build treats the bundle phase as already done. Delete `$E2E_DIR/ios-build` before the build that must include new JS or a new prebuild, as the script does. A fast `BUILD SUCCEEDED` against a leftover derived-data directory is not evidence the bundle changed. This stale-bundle failure was not reproduced when this section was written.

### UTF-8 for pod and xcodebuild

CocoaPods stops when the process locale is not UTF-8. The `export` in the subshell covers both `pod install` and `xcodebuild`. Do not put `LANG` only on the `pod` line.

The Xcode workspace and build scheme come from `ios/*.xcworkspace`, as in CI and `scripts/lib/ios-promote.mjs`; the URL scheme is `fleet`, registered by `plugins/withFleetIos.ts`. On a cold start the link reaches the app through `willFinishLaunching` (`FleetLinkAppDelegateSubscriber`). Once `AppleLocale` is `en_US`, the system shows an "Open in Fleet?" confirmation on every `openurl`, and it must be accepted. `simctl` has no tap or input command: drive the app headlessly with a scratch UI-test bundle that launches the installed app by bundle id (`XCUIApplication(bundleIdentifier:)`) and runs through `xcodebuild test -destination "id=$UDID"`; the Console WebView exposes its controls by their accessible labels. Keep that project outside the repository, and do not take over the user's foreground with desktop clicks or keystrokes. Screenshots: `xcrun simctl io "$UDID" screenshot <evidence>/shot.png`. CI exercises the Release simulator build and embedded-bundle check; only the local `simctl install` step remains unverified in this repository's docs. Record the actual install command used and its result.

## 5. Stay apart from other sessions

- Only your `AVD` name, `PORT`, `SERIAL`, `UDID`, `E2E_DIR`, and `CONSOLE_PID` are yours. Never run `pkill`, `killall`, `adb emu kill` without `-s`, `simctl shutdown all`, `simctl erase all`, or `xcrun simctl delete unavailable`, or `adb kill-server` outside the rule in step 6.
- Do not reuse a data root, an emulator, or a Console that was running before you started. Recheck the preflight's `in-use` line before booting and before cleanup.
- Check the shared adb server's state only with `lsof -nP -iTCP:5037 -sTCP:LISTEN`. Do not call bare adb commands such as `adb devices` just to check state: they start a stopped server. The preflight likewise checks the listener before querying attached devices; query your own serial with `adb -s "$SERIAL"` only while a server already listens, unless this run is intentionally starting it.
- Do not print process command lines or tokens; identify processes by the PIDs and ports you recorded, within the [process-listing scope](setup.md#keep-the-real-home-out).

## 6. Clean up (success or failure)

```bash
kill "$CONSOLE_PID"                               # each Console you started
adb -s "$SERIAL" emu kill                          # only your serial
avdmanager delete avd -n "$AVD"                    # only an AVD you created for this run
xcrun simctl shutdown "$UDID"; xcrun simctl delete "$UDID"   # only your simulator
rm -rf "$E2E_DIR"                                  # only after the Consoles stopped; this removes link.txt too
```

The adb server that your first `adb -s` call started may outlive the run. Run `adb kill-server` only if the step-0 preflight said `adb server not running`, `lsof -nP -iTCP:5037 -sTCP:LISTEN` still shows a listener, **and** a fresh Android preflight's `in-use` line says `adb devices: none` (it queries devices only after detecting a listener). Otherwise leave it, since someone else's device may depend on it. If there is no listener, do not run any adb command for cleanup or confirmation; if listener state or device ownership is unknown, leave the server alone.

Confirm: `lsof -nP -iTCP:<console port> -sTCP:LISTEN` is empty for every Console you started; check port `5037` with the same listener-only command, and only if it listens use `adb -s "$SERIAL" get-state` to confirm your serial is no longer connected. `emulator -list-avds` and `xcrun simctl list devices` no longer list yours, and the preflight's `in-use` line shows only what was there before. Keep the AVD and `E2E_DIR` only when the run is being handed on, and say so in the report. Leave `runtime/fleet-mobile/android/`, `runtime/fleet-mobile/ios/` (created by `expo prebuild`, gitignored), and `dist/` in the worktree unless the user asked for the checkout to be clean.
