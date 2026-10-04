# Mobile shell reproduction

Reproduce a Fleet Mobile (`runtime/fleet-mobile`) behavior, such as a cold start with an access link, on your own emulator or simulator against your own isolated Console. The Console half reuses [Isolated Console setup](setup.md) and [Remote access testing](remote-access-testing.md); this page covers only what mobile changes. Native Android and iOS behavior is not covered by the browser lanes, and a claim stays unverified until it runs on a real emulator or simulator.

## Briefing a reproduction

When a counter or state (an attempt count, a retry flag) looks like the cause, list **every caller that changes it** — init, resume, retry, and any other — before naming one as the cause, and have the reproduction exercise each of them. Naming one caller from the first reading is how a fix lands on the wrong path.

## 0. Pick names and run the preflight

Choose one unique `RUN` id and keep its values for the whole run: Console data root `$RUN_DIR`, your AVD name, your emulator port (an even number 5554–5680 that no listed emulator uses), and so on. Everything below is addressed by these values, never by "the running emulator".

```bash
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"   # must be set; ANDROID_HOME, if set, must match
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
node <worktree>/runtime/fleet-mobile/scripts/mobile-preflight.mjs [--platform android|ios] [--json]
```

It is read-only and starts nothing. Exit `0` means every required check passed; `20` means a `FAIL` line names what is missing and prints its fix. Its verdicts come from the build scripts' own functions (`scripts/lib/android-tools.mjs`, `ios-tools.mjs`), so a pass means `android:build:debug` will accept the toolchain. JDK: Android Studio's bundled JDK is used on macOS; `JAVA_HOME` is ignored outside CI, so set `FLEET_ANDROID_JAVA_HOME` to override. The `NOTE … in-use` lines list adb devices, running emulators, and booted simulators: they belong to someone else. Do not use, restart, or kill them.

## 1. Start your own Consoles

Per Console, follow [Isolated Console setup](setup.md#isolate-the-console) with its own `E2E_DIR` (all four of `FLEET_DATA_DIR`, `FLEET_CONSOLE_DATA_DIR`, `FLEET_DESKTOP_DATA_DIR`, `CLAUDE_CONFIG_DIR` under it), started as a background process whose PID you record: `CONSOLE_PID=$!`. For two Consoles, use two `E2E_DIR`s; nothing is shared. Read each port and token from that Console's `$E2E_DIR/console/console.lock`, check it answers `200`, and never print the token. Do not touch `127.0.0.1:50000` or any Console whose lock is not under your `E2E_DIR`.

## 2. Issue an access link

Use the listener and `/api/v1/access-links` procedure in [Remote access testing](remote-access-testing.md#turn-the-listener-on). What mobile changes:

- **Address.** The remote listener must bind this machine's LAN address (`BIND=$(ipconfig getifaddr en0)`; loopback is rejected). The emulator reaches it by that same LAN address, so use the link exactly as issued. `10.0.2.2` is the emulator's alias for host *loopback* and cannot reach this listener. A simulator shares the host network and uses the same link.
- **Format.** `fleet://join?code=<base64url envelope>`; nothing else in the query (see `protocol/remote/index.ts`). Choose `?access=full` or `?access=monitoring` as the claim needs.
- **Secrecy.** The link carries a one-time credential. Write it to an owner-only file and pass it by command substitution; do not echo it, log it, or paste it into a report.

```js
// node, run once per Console; origin = http://127.0.0.1:<lock port>, token from the lock
const { remoteAccess: cur } = await (await fetch(`${origin}/api/v1/settings/global`)).json();
await fetch(`${origin}/api/v1/settings/global`, { method: "PUT",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ remoteAccess: { ...cur, enabled: true, publicEndpointEnabled: false, listenAddress: BIND, acknowledgment: null } }) });
if (!(await (await fetch(`${origin}/api/v1/access-links`)).json()).listening) throw new Error("listener is not up");
const { link } = await (await fetch(`${origin}/api/v1/access-links?access=full`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json();
fs.writeFileSync(`${E2E_DIR}/link.txt`, link, { mode: 0o600 });
```

A link is single-use. Issue a new one for every launch attempt.

## 3. Android

**Your AVD** (never reuse one from the preflight's list that you did not create):

```bash
avdmanager create avd -n "$AVD" -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
emulator -avd "$AVD" -port "$PORT" -no-window -no-audio -no-snapshot-save -no-boot-anim > "$E2E_DIR/emulator.log" 2>&1 &
SERIAL="emulator-$PORT"
adb -s "$SERIAL" wait-for-device
until [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
```

Use `-no-window` unless the claim needs pixels; a visible emulator window can take the user's focus. Every adb call carries `-s "$SERIAL"`; a bare `adb` command is refused here because other sessions' devices are attached.

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

**Observe.** Screenshot to an absolute path outside the worktree: `adb -s "$SERIAL" exec-out screencap -p > <evidence>/shot.png`. App-side logs: `adb -s "$SERIAL" logcat -d | grep -i -e ReactNativeJS -e AndroidRuntime`. Console-side proof that the device paired: the owner's Settings → Remote access table, or the device count in `$E2E_DIR/console/remote/paired-devices.json` (count only; the file holds device names).

## 4. iOS simulator

Same Console and link as above; the simulator needs no address change. There is no promoted debug-build script for iOS (`ios:build:release` needs signing material), so install a development build:

```bash
xcrun simctl create "$SIM_NAME" "iPhone 17 Pro" "com.apple.CoreSimulator.SimRuntime.iOS-26-5"   # prints your UDID
xcrun simctl boot "$UDID"
pnpm --dir <worktree>/runtime/fleet-mobile exec expo run:ios --device "$UDID"   # builds and installs com.dotobokuri.fleet.mobile
xcrun simctl terminate "$UDID" com.dotobokuri.fleet.mobile
xcrun simctl openurl "$UDID" "$(cat "$E2E_DIR/link.txt")"
```

The scheme is `fleet`, registered by `plugins/withFleetIos.ts`. On a cold start the link reaches the app through `willFinishLaunching` (`FleetLinkAppDelegateSubscriber`). The system may show an "Open in Fleet?" confirmation that a person or UI automation must accept; record whether it appeared. Screenshots: `xcrun simctl io "$UDID" screenshot <evidence>/shot.png`. The `expo run:ios` install route is unverified in this repository's docs; record the actual command used.

## 5. Stay apart from other sessions

- Only your `AVD` name, `PORT`, `SERIAL`, `UDID`, `E2E_DIR`, and `CONSOLE_PID` are yours. Never run `adb kill-server`, `pkill`, `killall`, `adb emu kill` without `-s`, `simctl shutdown all`, `simctl erase all`, or `xcrun simctl delete unavailable`.
- Do not reuse a data root, an emulator, or a Console that was running before you started. Recheck the preflight's `in-use` line before booting and before cleanup.
- Do not print process command lines or tokens; identify processes by the PIDs and ports you recorded.

## 6. Clean up (success or failure)

```bash
kill "$CONSOLE_PID"                               # each Console you started; then confirm its port no longer listens
adb -s "$SERIAL" emu kill                          # only your serial
avdmanager delete avd -n "$AVD"                    # only an AVD you created for this run
xcrun simctl shutdown "$UDID"; xcrun simctl delete "$UDID"   # only your simulator
rm -rf "$E2E_DIR"                                  # only after the Consoles stopped; this removes link.txt too
```

Confirm: `lsof -nP -iTCP:<console port> -sTCP:LISTEN` is empty for every Console you started, `adb devices` no longer lists your serial, `emulator -list-avds` and `xcrun simctl list devices` no longer list yours, and the preflight's `in-use` line shows only what was there before. Keep the AVD and `E2E_DIR` only when the run is being handed on, and say so in the report. Leave `runtime/fleet-mobile/android/` and `dist/` (build output) in the worktree unless the user asked for the checkout to be clean.
