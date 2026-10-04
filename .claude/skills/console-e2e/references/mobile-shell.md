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

**Desktop-only surfaces.** The mobile layout opens no companion panels (Analyst, Operation Browser). To reach one, tap the view-mode toggle in the Operations header until it shows desktop (auto → mobile → desktop). At a phone's physical density the desktop view clips the bottom row of a companion panel; on your own emulator, `adb -s "$SERIAL" shell wm density 200` in landscape widens the viewport enough (undo with `wm density reset`). A density change recreates the activity and reloads the page.

## 4. iOS simulator

Same Console and link as above; the simulator needs no address change. There is no promoted debug-build script for iOS (`ios:build:release` needs signing material), so install a simulator build. Use `--configuration Release` so the JS bundle is embedded; a Debug build without a running Metro shows the React Native red error screen. `pod install` inside `expo run:ios` fails unless `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` are set:

```bash
xcrun simctl list runtimes available; xcrun simctl list devicetypes iPhone   # pick an installed iOS runtime id and iPhone device type id
xcrun simctl create "$SIM_NAME" "<device type id>" "<runtime id>"   # prints your UDID
xcrun simctl boot "$UDID"
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pnpm --dir <worktree>/runtime/fleet-mobile exec expo run:ios --configuration Release --device "$UDID"   # builds and installs com.dotobokuri.fleet.mobile
xcrun simctl terminate "$UDID" com.dotobokuri.fleet.mobile
xcrun simctl openurl "$UDID" "$(cat "$E2E_DIR/link.txt")"
```

The scheme is `fleet`, registered by `plugins/withFleetIos.ts`. On a cold start the link reaches the app through `willFinishLaunching` (`FleetLinkAppDelegateSubscriber`). The system shows an "Open in Fleet?" confirmation on every `openurl`, and it must be accepted. `simctl` has no tap or input command: drive the app headlessly with a scratch UI-test bundle that launches the installed app by bundle id (`XCUIApplication(bundleIdentifier:)`) and runs through `xcodebuild test -destination "id=$UDID"`; the Console WebView exposes its controls by their accessible labels. Keep that project outside the repository, and do not take over the user's foreground with desktop clicks or keystrokes. Screenshots: `xcrun simctl io "$UDID" screenshot <evidence>/shot.png`. The `expo run:ios` install route is unverified in this repository's docs; record the actual command used.

## 5. Stay apart from other sessions

- Only your `AVD` name, `PORT`, `SERIAL`, `UDID`, `E2E_DIR`, and `CONSOLE_PID` are yours. Never run `pkill`, `killall`, `adb emu kill` without `-s`, `simctl shutdown all`, `simctl erase all`, or `xcrun simctl delete unavailable`, or `adb kill-server` outside the rule in step 6.
- Do not reuse a data root, an emulator, or a Console that was running before you started. Recheck the preflight's `in-use` line before booting and before cleanup.
- Do not print process command lines or tokens; identify processes by the PIDs and ports you recorded, within the [process-listing scope](setup.md#keep-the-real-home-out).

## 6. Clean up (success or failure)

```bash
kill "$CONSOLE_PID"                               # each Console you started
adb -s "$SERIAL" emu kill                          # only your serial
avdmanager delete avd -n "$AVD"                    # only an AVD you created for this run
xcrun simctl shutdown "$UDID"; xcrun simctl delete "$UDID"   # only your simulator
rm -rf "$E2E_DIR"                                  # only after the Consoles stopped; this removes link.txt too
```

The adb server that your first `adb -s` call started may outlive the run. Run `adb kill-server` only if the step-0 preflight said `adb server not running` **and** `adb devices` is now empty; otherwise leave it, since someone else's device depends on it.

Confirm: `lsof -nP -iTCP:<console port> -sTCP:LISTEN` is empty for every Console you started, `adb devices` no longer lists your serial, `emulator -list-avds` and `xcrun simctl list devices` no longer list yours, and the preflight's `in-use` line shows only what was there before. Keep the AVD and `E2E_DIR` only when the run is being handed on, and say so in the report. Leave `runtime/fleet-mobile/android/` and `dist/` (build output) in the worktree unless the user asked for the checkout to be clean.
