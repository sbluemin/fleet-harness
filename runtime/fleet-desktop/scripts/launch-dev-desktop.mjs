import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const productName = "Fleet Console Dev";
const bundleIdentifier = "com.dotobokuri.fleet-console.dev";
const wrapperSourceKey = "FleetConsoleDevElectronApp";

export async function createMacDevWrapper(input) {
  const electronAppPath = path.resolve(input.electronBinary, "..", "..", "..");
  const wrapperPath = path.join(input.stageDirectory, `${productName}.app`);
  const contentsDirectory = path.join(wrapperPath, "Contents");
  const executablePath = path.join(contentsDirectory, "MacOS", "Electron");
  const wrapperIconPath = path.join(contentsDirectory, "Resources", "icon.icns");
  // checkout 경로를 서명된 Info.plist에 넣으면 같은 Electron도 worktree마다 다른 앱이 된다.
  const sourceIdentity = createHash("sha256");
  for (const file of [path.join(electronAppPath, "Contents", "MacOS", "Electron"), path.join(electronAppPath, "Contents", "Info.plist"), input.iconPath,
    path.join(desktopDirectory, "build", "entitlements.mac.plist")]) sourceIdentity.update(await readFile(file));
  const identity = sourceIdentity.digest("hex");
  if (await isReusableWrapper(wrapperPath, identity)) {
    return { appPath: wrapperPath, executablePath };
  }

  await rm(wrapperPath, { force: true, recursive: true });
  await mkdir(input.stageDirectory, { recursive: true });
  await (input.cloneApp ?? cloneMacApp)(electronAppPath, wrapperPath);
  const sourceInfoPath = path.join(electronAppPath, "Contents", "Info.plist");
  const wrapperInfoPath = path.join(contentsDirectory, "Info.plist");
  const sourceInfo = await readFile(sourceInfoPath, "utf8");
  await writeFile(wrapperInfoPath, createInfoPlist(sourceInfo, identity));
  await copyFile(input.iconPath, wrapperIconPath);
  await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--identifier", bundleIdentifier,
    "--entitlements", path.join(desktopDirectory, "build", "entitlements.mac.plist"), wrapperPath]);
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", wrapperPath]);
  return { appPath: wrapperPath, executablePath };
}

export function createInfoPlist(sourceInfo, electronAppPath) {
  return appendPlistString(appendPlistString(
    replacePlistString(
      replacePlistString(
        replacePlistString(
          replacePlistString(sourceInfo, "CFBundleDisplayName", productName),
          "CFBundleIconFile",
          "icon.icns",
        ),
        "CFBundleIdentifier",
        bundleIdentifier,
      ),
      "CFBundleName",
      productName,
    ),
    wrapperSourceKey,
    electronAppPath,
  ), "NSAppleEventsUsageDescription", "Fleet Console Dev uses the Computer Use service to read and control apps when you allow an Operation.");
}

export function createMacDevLaunchArguments(wrapperPath, appPath, args = [], env = process.env) {
  const overrides = ["FLEET_CONSOLE_DATA_DIR", "FLEET_DESKTOP_DATA_DIR", "FLEET_DATA_DIR", "FLEET_CONSOLE_NODE_PATH", "FLEET_DESKTOP_DEV_UPDATE_FEED"]
    .flatMap((key) => env[key] ? ["--env", `${key}=${env[key]}`] : []);
  return ["-W", "-n", ...overrides, wrapperPath, "--args", appPath, ...args];
}

async function main() {
  const electronBinary = require("electron");
  if (process.platform !== "darwin") return process.argv.includes("--build-only") ? 0 : run(electronBinary, [desktopDirectory, ...process.argv.slice(2)]);
  const wrapper = await createMacDevWrapper({
    electronBinary,
    iconPath: path.join(desktopDirectory, "build", "icon.icns"),
    stageDirectory: path.join(desktopDirectory, ".stage", "dev-app"),
  });
  if (process.argv.includes("--build-only")) { process.stdout.write(`${wrapper.appPath}\n`); return 0; }
  return run("/usr/bin/open", createMacDevLaunchArguments(wrapper.appPath, desktopDirectory, process.argv.slice(2)));
}

async function cloneMacApp(sourcePath, destinationPath) {
  await execFileAsync("/bin/cp", ["-cR", sourcePath, destinationPath]);
}

async function isReusableWrapper(wrapperPath, electronAppPath) {
  try {
    const [info, executable] = await Promise.all([
      readFile(path.join(wrapperPath, "Contents", "Info.plist"), "utf8"),
      stat(path.join(wrapperPath, "Contents", "MacOS", "Electron")),
    ]);
    if (!executable.isFile() || !info.includes(plistString(wrapperSourceKey, electronAppPath))
      || !info.includes(`<string>${bundleIdentifier}</string>`) || !info.includes(`<string>${productName}</string>`)) return false;
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", wrapperPath]);
    return true;
  } catch {
    return false;
  }
}

function replacePlistString(plist, key, value) {
  const entry = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)([\\s\\S]*?)(</string>)`);
  if (!entry.test(plist)) throw new Error(`Electron Info.plist is missing ${key}`);
  return plist.replace(entry, `$1${escapeXml(value)}$3`);
}

function appendPlistString(plist, key, value) {
  const closingDict = plist.lastIndexOf("</dict>");
  if (closingDict === -1) throw new Error("Electron Info.plist is missing its root dictionary");
  return `${plist.slice(0, closingDict)}  <key>${key}</key><string>${escapeXml(value)}</string>\n${plist.slice(closingDict)}`;
}

function plistString(key, value) {
  return `<key>${key}</key><string>${escapeXml(value)}</string>`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}

function run(command, args) {
  const child = spawn(command, args, { cwd: desktopDirectory, env: process.env, stdio: "inherit", windowsHide: true });
  return new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(typeof code === "number" ? code : signal ? 1 : 0));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
