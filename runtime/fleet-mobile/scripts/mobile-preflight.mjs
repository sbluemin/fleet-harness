#!/usr/bin/env node
/**
 * Read-only toolchain check to run before reproducing or building the mobile shell. It writes no
 * files, sends no signals, starts no emulator, simulator or adb server, and binds no port.
 *
 *   node runtime/fleet-mobile/scripts/mobile-preflight.mjs [--platform android|ios|all] [--json]
 *
 * Android verdicts come from the same functions the build scripts call (scripts/lib/android-tools.mjs
 * and ios-tools.mjs), so this check and a real build cannot disagree. Only the extra reproduction
 * needs (adb, emulator, AVDs, devices in use) are judged here.
 *
 * Exit codes: 0 = every required check of the selected platform(s) passed, 20 = at least one failed
 * or the arguments were invalid. Notices (`note`) never change the exit code.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPILE_SDK,
  requireAndroidPlatform,
  requireAndroidSdk,
  requireBuildTools,
  requireJavaMajor,
  resolveJavaHome,
} from "./lib/android-tools.mjs";
import { requireXcode } from "./lib/ios-tools.mjs";

function probe(command, args, timeout = 15_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function parseArgs(argv) {
  const opts = { platform: "all", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--platform") opts.platform = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!["android", "ios", "all"].includes(opts.platform)) throw new Error("--platform expects android, ios or all");
  return opts;
}

const results = [];
/** fn returns a detail string (pass) or {status, detail}; a throw is a failure with the error message. */
function check(platform, id, fn, fix) {
  try {
    const value = fn();
    const entry = typeof value === "string" ? { status: "pass", detail: value } : value;
    results.push({ platform, id, ...entry, ...(entry.status === "fail" && fix ? { fix } : {}) });
  } catch (error) {
    results.push({ platform, id, status: "fail", detail: error.message, ...(fix ? { fix } : {}) });
  }
}

function androidChecks() {
  const home = os.homedir();
  const defaultSdk = process.platform === "darwin" ? path.join(home, "Library/Android/sdk") : path.join(home, "Android/Sdk");
  const sdkFix = `export ANDROID_SDK_ROOT=${existsSync(defaultSdk) ? defaultSdk : "<absolute SDK dir>"}; unset ANDROID_HOME or point it at the same directory`;
  let sdk;
  check("android", "sdk", () => (sdk = requireAndroidSdk()), sdkFix);

  let javaHome;
  check("android", "jdk-home", () => (javaHome = resolveJavaHome()),
    "Install Android Studio (its bundled JDK is used on macOS) or set FLEET_ANDROID_JAVA_HOME to an absolute JDK directory. JAVA_HOME alone is ignored outside CI");
  if (javaHome) {
    check("android", "jdk-version", () => `${javaHome} -> Java ${requireJavaMajor(javaHome)}`);
    // avdmanager and sdkmanager read JAVA_HOME and ignore FLEET_ANDROID_JAVA_HOME; the build scripts do the opposite.
    const ambient = process.env.JAVA_HOME;
    if (!ambient || path.resolve(ambient) !== path.resolve(javaHome)) {
      results.push({
        platform: "android", id: "jdk-cmdline-tools", status: "note",
        detail: `${ambient ? `JAVA_HOME=${ambient} differs from` : "JAVA_HOME is unset, but"} the JDK builds use; avdmanager/sdkmanager fail with "Unable to locate a Java Runtime" without it. Before calling them: export JAVA_HOME="${javaHome}"`,
      });
    }
  }

  if (!sdk) return;
  check("android", "platform", () => requireAndroidPlatform(sdk) && `android-${COMPILE_SDK}`,
    `sdkmanager "platforms;android-${COMPILE_SDK}"`);
  check("android", "build-tools", () => `${path.dirname(requireBuildTools(sdk).aapt)}`,
    `sdkmanager "build-tools;${COMPILE_SDK}.0.0"`);
  const adb = path.join(sdk, "platform-tools", "adb");
  check("android", "adb", () => {
    if (!existsSync(adb)) throw new Error(`${adb} is missing`);
    return adb;
  }, 'sdkmanager "platform-tools"; call adb by this absolute path (it is usually not on PATH)');
  const emulator = path.join(sdk, "emulator", "emulator");
  check("android", "emulator", () => {
    if (!existsSync(emulator)) throw new Error(`${emulator} is missing`);
    return emulator;
  }, 'sdkmanager "emulator"');

  if (existsSync(emulator)) {
    check("android", "avd", () => {
      const { status, out } = probe(emulator, ["-list-avds"]);
      const avds = out.split("\n").map((line) => line.trim()).filter((line) => /^[\w.-]+$/.test(line));
      if (status !== 0 || avds.length === 0) throw new Error("no AVD is available");
      return `${avds.length} available: ${avds.join(", ")}`;
    }, `Create your own AVD with avdmanager (system image under ${path.join(sdk, "system-images")}); never reuse another session's AVD`);
  }

  // Devices another session may be using. adb is asked only when its server already listens on 5037,
  // because `adb devices` would otherwise start a server; the process table names the running AVDs
  // and ports without printing any command line.
  check("android", "in-use", () => {
    const parts = [];
    const listening = probe("/usr/sbin/lsof", ["-nP", "-iTCP:5037", "-sTCP:LISTEN", "-t"]).out.trim() !== "";
    if (listening && existsSync(adb)) {
      const devices = probe(adb, ["devices", "-l"]).out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
      parts.push(devices.length ? `adb devices: ${devices.map((d) => d.split(/\s+/).slice(0, 2).join(" ")).join("; ")}` : "adb devices: none");
    } else {
      parts.push("adb server not running (not started by this check)");
    }
    const ps = probe("/bin/ps", ["-eo", "pid=,command="]).out.split("\n");
    const running = ps.flatMap((line) => {
      if (!/\/(emulator|qemu-system[\w-]*)\s/.test(line)) return [];
      const avd = /-avd\s+([\w.-]+)/.exec(line)?.[1];
      const port = /-port\s+(\d+)/.exec(line)?.[1];
      return avd ? [`${avd}${port ? ` (port ${port})` : ""}`] : [];
    });
    parts.push(running.length ? `running emulators: ${[...new Set(running)].join(", ")}` : "running emulators: none");
    return { status: "note", detail: `${parts.join(" | ")} — belongs to someone else unless you started it; never reuse or kill it` };
  });
}

function iosChecks() {
  if (process.platform !== "darwin") {
    results.push({ platform: "ios", id: "host", status: "fail", detail: "iOS needs macOS with Xcode", fix: "Use Android on this host" });
    return;
  }
  check("ios", "xcode", () => {
    requireXcode();
    const developerDir = probe("xcode-select", ["-p"]);
    const version = probe("xcodebuild", ["-version"]);
    if (developerDir.status !== 0 || version.status !== 0) throw new Error(version.out.trim().split("\n")[0] || "Xcode is not selected");
    return `${developerDir.out.trim()} -> ${version.out.trim().split("\n").join(", ")}`;
  }, "Install Xcode, then sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");

  const json = (args) => JSON.parse(probe("xcrun", ["simctl", "list", ...args, "--json"], 30_000).out);
  check("ios", "simctl-runtimes", () => {
    const runtimes = json(["runtimes", "available"]).runtimes.filter((r) => r.isAvailable && /iOS/.test(r.name));
    if (!runtimes.length) throw new Error("no available iOS simulator runtime");
    return runtimes.map((r) => r.name).join(", ");
  }, "Xcode > Settings > Components: install an iOS simulator runtime");
  check("ios", "simctl-devices", () => {
    const devices = Object.entries(json(["devices", "available"]).devices)
      .filter(([runtime]) => /iOS/.test(runtime))
      .flatMap(([, list]) => list)
      .filter((d) => d.isAvailable !== false && /iPhone/.test(d.name));
    if (!devices.length) throw new Error("no available iPhone simulator device");
    return `${devices.length} iPhone devices, e.g. ${devices.slice(0, 3).map((d) => `${d.name} ${d.udid} [${d.state}]`).join("; ")}`;
  }, "xcrun simctl create <name> <device type> <runtime> for your own device");
  check("ios", "in-use", () => {
    const booted = Object.values(json(["devices"]).devices).flat().filter((d) => d.state === "Booted");
    return {
      status: "note",
      detail: `${booted.length ? `booted: ${booted.map((d) => `${d.name} ${d.udid}`).join("; ")}` : "booted: none"} — belongs to someone else unless you booted it; create and boot your own device`,
    };
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.platform !== "ios") androidChecks();
  if (opts.platform !== "android") iosChecks();
  const failed = results.filter((r) => r.status === "fail");
  const exitCode = failed.length ? 20 : 0;
  if (opts.json) {
    console.log(JSON.stringify({ platform: opts.platform, observedAt: new Date().toISOString(), exitCode, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`[${r.status.toUpperCase().padEnd(4)}] ${r.platform}/${r.id}: ${r.detail}`);
      if (r.fix) console.log(`       fix: ${r.fix}`);
    }
    console.log(`${failed.length ? `blocked: ${failed.map((r) => `${r.platform}/${r.id}`).join(", ")}` : "ready"} (exit ${exitCode})`);
  }
  return exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  if (process.argv.includes("--json")) console.log(JSON.stringify({ exitCode: 20, error: error.message }, null, 2));
  else console.error(`mobile preflight failed: ${error.message}\nexit code: 20`);
  process.exitCode = 20;
}
