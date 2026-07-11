import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const productName = "Fleet Console";
const bundleIdentifier = "com.dotobokuri.fleet-console";
const wrapperSourceKey = "FleetConsoleDevElectronApp";

export async function createMacDevWrapper(input) {
  const electronAppPath = path.resolve(input.electronBinary, "..", "..", "..");
  const wrapperPath = path.join(input.stageDirectory, `${productName}.app`);
  const contentsDirectory = path.join(wrapperPath, "Contents");
  const executablePath = path.join(contentsDirectory, "MacOS", "Electron");
  const wrapperIconPath = path.join(contentsDirectory, "Resources", "icon.icns");
  if (await isReusableWrapper(wrapperPath, electronAppPath)) {
    await copyFile(input.iconPath, wrapperIconPath);
    return { appPath: wrapperPath, executablePath };
  }

  await rm(wrapperPath, { force: true, recursive: true });
  await mkdir(input.stageDirectory, { recursive: true });
  await (input.cloneApp ?? cloneMacApp)(electronAppPath, wrapperPath);
  const sourceInfoPath = path.join(electronAppPath, "Contents", "Info.plist");
  const wrapperInfoPath = path.join(contentsDirectory, "Info.plist");
  const sourceInfo = await readFile(sourceInfoPath, "utf8");
  await writeFile(wrapperInfoPath, createInfoPlist(sourceInfo, electronAppPath));
  await copyFile(input.iconPath, wrapperIconPath);
  return { appPath: wrapperPath, executablePath };
}

export function createInfoPlist(sourceInfo, electronAppPath) {
  return appendPlistString(
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
  );
}

export function createMacDevLaunchArguments(wrapperPath, appPath) {
  return ["-W", "-n", wrapperPath, "--args", appPath];
}

async function main() {
  const electronBinary = require("electron");
  if (process.platform !== "darwin") return run(electronBinary, [desktopDirectory]);
  const wrapper = await createMacDevWrapper({
    electronBinary,
    iconPath: path.join(desktopDirectory, "build", "icon.icns"),
    stageDirectory: path.join(desktopDirectory, ".stage", "dev-app"),
  });
  return run("/usr/bin/open", createMacDevLaunchArguments(wrapper.appPath, desktopDirectory));
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
    return executable.isFile() && info.includes(plistString(wrapperSourceKey, electronAppPath));
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
