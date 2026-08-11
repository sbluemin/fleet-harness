import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const APPLICATION_ID = "com.dotobokuri.fleet.mobile";
export const MIN_SDK = 24;
export const TARGET_SDK = 36;
export const COMPILE_SDK = 36;
export const REQUIRED_PERMISSION = "android.permission.INTERNET";
export const RECEIVER_PERMISSION = `${APPLICATION_ID}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;

export function fail(message) {
  throw new Error(message);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd()
      : "";
    fail(`${command} exited with status ${result.status}${details}`);
  }
  return result.stdout ?? "";
}

export function requireAndroidSdk(env = process.env) {
  const sdkRoot = env.ANDROID_SDK_ROOT;
  if (!sdkRoot || !path.isAbsolute(sdkRoot) || !existsSync(sdkRoot)) {
    fail("ANDROID_SDK_ROOT must name an existing absolute Android SDK directory");
  }
  if (env.ANDROID_HOME && path.resolve(env.ANDROID_HOME) !== path.resolve(sdkRoot)) {
    fail("ANDROID_HOME and ANDROID_SDK_ROOT must resolve to the same directory");
  }
  return sdkRoot;
}

export function resolveJavaHome(env = process.env, platform = process.platform) {
  const explicit = env.FLEET_ANDROID_JAVA_HOME;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(path.join(explicit, "bin", "java"))) {
      fail("FLEET_ANDROID_JAVA_HOME must name an existing absolute JDK directory");
    }
    return explicit;
  }

  if (platform === "darwin") {
    const androidStudioJdk = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
    if (existsSync(path.join(androidStudioJdk, "bin", "java"))) return androidStudioJdk;
  }

  if (env.CI === "true" && env.JAVA_HOME && existsSync(path.join(env.JAVA_HOME, "bin", "java"))) {
    return env.JAVA_HOME;
  }

  fail(
    "Android builds require Android Studio's bundled JDK. Install Android Studio or set FLEET_ANDROID_JAVA_HOME (CI may provide JAVA_HOME)",
  );
}

export function parseJavaMajor(output) {
  const major = Number(output.match(/version "(?:1\.)?(\d+)/)?.[1]);
  if (!Number.isInteger(major)) fail("Could not determine the Android build JDK version");
  return major;
}

export function requireJavaMajor(javaHome) {
  const java = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`Could not inspect Android build JDK at ${java}`);
  return parseJavaMajor(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

export function withJavaNativeAccess(javaMajor, current = "") {
  const option = "--enable-native-access=ALL-UNNAMED";
  const existing = current.trim();
  if (javaMajor < 24 || existing.split(/\s+/).includes(option)) return existing;
  return [existing, option].filter(Boolean).join(" ");
}

export function requireBuildTools(sdkRoot, platform = process.platform) {
  const directory = path.join(sdkRoot, "build-tools", `${COMPILE_SDK}.0.0`);
  const aapt = path.join(directory, platform === "win32" ? "aapt.exe" : "aapt");
  const apksigner = path.join(directory, platform === "win32" ? "apksigner.bat" : "apksigner");
  if (!existsSync(aapt) || !existsSync(apksigner)) {
    fail(`Android build-tools ${COMPILE_SDK}.0.0 with aapt and apksigner are required`);
  }
  return { aapt, apksigner };
}

export function requireAndroidPlatform(sdkRoot) {
  const androidJar = path.join(sdkRoot, "platforms", `android-${COMPILE_SDK}`, "android.jar");
  if (!existsSync(androidJar)) fail(`ANDROID_SDK_ROOT is missing platform android-${COMPILE_SDK}`);
  return androidJar;
}

export function inspectBadging(output) {
  return {
    packageName: output.match(/^package: name='([^']+)'/m)?.[1],
    minSdk: Number(output.match(/^sdkVersion:'(\d+)'/m)?.[1]),
    targetSdk: Number(output.match(/^targetSdkVersion:'(\d+)'/m)?.[1]),
  };
}

function parseAaptValue(value) {
  const raw = value.match(/="([^"]*)"/)?.[1];
  if (raw !== undefined) return raw;
  const typed = value.match(/\(type 0x(10|11|12)\)0x([0-9a-f]+)/i);
  if (typed?.[1] === "10" || typed?.[1] === "11") return String(Number.parseInt(typed[2], 16));
  if (typed?.[1] === "12") return typed[2] === "0" ? "false" : "true";
  const reference = value.match(/=@([^\s]+)/)?.[1];
  if (reference !== undefined) return `@${reference}`;
  return undefined;
}

export function inspectAaptManifestTree(output) {
  const root = { name: "root", attributes: {}, children: [], depth: -1 };
  const stack = [root];
  for (const originalLine of output.split(/\r?\n/)) {
    const content = originalLine.trimStart();
    const depth = originalLine.length - content.length;
    const element = content.match(/^E: ([^\s]+)/)?.[1];
    if (element) {
      while (stack.at(-1).depth >= depth) stack.pop();
      const node = { name: element, attributes: {}, children: [], depth };
      stack.at(-1).children.push(node);
      stack.push(node);
      continue;
    }
    const attribute = content.match(/^A: (?:android:)?([^=(\s]+)(?:\([^)]*\))?=(.*)$/);
    if (attribute && stack.length > 1) stack.at(-1).attributes[attribute[1]] = parseAaptValue(`=${attribute[2]}`);
  }

  const manifest = root.children.find((node) => node.name === "manifest");
  const application = manifest?.children.find((node) => node.name === "application");
  if (!manifest || !application) fail("APK manifest is incomplete");
  const permissions = manifest.children
    .filter((node) => node.name === "uses-permission")
    .map((node) => node.attributes.name)
    .filter(Boolean);
  const declaredPermissions = manifest.children
    .filter((node) => node.name === "permission")
    .map((node) => ({ name: node.attributes.name, protectionLevel: node.attributes.protectionLevel }))
    .filter(({ name }) => Boolean(name));
  const componentKinds = new Set(["activity", "activity-alias", "service", "receiver", "provider"]);
  const exported = application.children
    .filter((node) => componentKinds.has(node.name) && node.attributes.exported === "true")
    .map((node) => ({ kind: node.name, name: normalizeComponentName(node.attributes.name ?? "") }));
  return {
    packageName: manifest.attributes.package,
    permissions,
    declaredPermissions,
    exported,
    debuggable: application.attributes.debuggable,
    usesCleartextTraffic: application.attributes.usesCleartextTraffic,
    networkSecurityConfig: application.attributes.networkSecurityConfig,
  };
}

export function normalizeComponentName(name) {
  if (name.startsWith(".")) return `${APPLICATION_ID}${name}`;
  if (!name.includes(".")) return `${APPLICATION_ID}.${name}`;
  return name;
}

export function verifyManifestContract(manifest, badging) {
  if (manifest.packageName !== APPLICATION_ID || badging.packageName !== APPLICATION_ID) {
    fail(`Unexpected APK package: ${manifest.packageName ?? badging.packageName ?? "missing"}`);
  }
  if (badging.minSdk !== MIN_SDK) fail(`Unexpected minSdk: ${badging.minSdk}`);
  if (badging.targetSdk !== TARGET_SDK) fail(`Unexpected targetSdk: ${badging.targetSdk}`);
  if (manifest.debuggable !== "true") fail("Debug APK must be marked debuggable");
  if (manifest.usesCleartextTraffic !== "false") fail("Fleet Mobile must disable cleartext traffic");
  if (manifest.networkSecurityConfig !== undefined) fail("Fleet Mobile must not install an alternate network security trust policy");

  const permissions = [...new Set(manifest.permissions)].sort();
  const expectedPermissions = [RECEIVER_PERMISSION, REQUIRED_PERMISSION].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
    fail(`Unexpected APK permissions: ${permissions.join(", ") || "none"}`);
  }
  const receiverDeclaration = manifest.declaredPermissions.filter(({ name }) => name === RECEIVER_PERMISSION);
  if (receiverDeclaration.length !== 1 || receiverDeclaration[0].protectionLevel !== "2") {
    fail(`${RECEIVER_PERMISSION} must be declared exactly once with signature protection`);
  }
  const unexpectedDeclarations = manifest.declaredPermissions.filter(({ name }) => name !== RECEIVER_PERMISSION);
  if (unexpectedDeclarations.length > 0) {
    fail(`Unexpected declared permissions: ${unexpectedDeclarations.map(({ name }) => name).join(", ")}`);
  }

  const exported = manifest.exported.map(({ kind, name }) => `${kind}:${name}`).sort();
  const expected = [
    `activity:${APPLICATION_ID}.FleetLinkActivity`,
    `activity:${APPLICATION_ID}.MainActivity`,
  ].sort();
  if (JSON.stringify(exported) !== JSON.stringify(expected)) {
    fail(`Unexpected exported components: ${exported.join(", ") || "none"}`);
  }
}

export function verifyDebugSigner(output) {
  if (!/Verified using v\d scheme.*true/.test(output)) {
    fail("apksigner did not report a verified APK signature");
  }
  const signerDns = [...output.matchAll(/Signer #\d+ certificate DN: (.+)/g)].map((match) => match[1].trim());
  const commonNames = signerDns[0]?.split(/,\s*/).filter((part) => part.startsWith("CN="));
  if (signerDns.length !== 1 || commonNames?.length !== 1 || commonNames[0] !== "CN=Android Debug") {
    fail(`APK must have exactly one Android Debug signer; got ${signerDns.join(", ") || "none"}`);
  }
  if (!/Signer #1 certificate SHA-256 digest: [0-9a-f]{64}/i.test(output)) {
    fail("apksigner did not report the debug certificate SHA-256 digest");
  }
}
