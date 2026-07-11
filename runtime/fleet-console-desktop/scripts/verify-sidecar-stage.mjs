import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageDirectory = join(desktopDirectory, ".stage", "sidecar");
const serviceDirectory = join(stageDirectory, "fleet-console");
const nativeTarget = `${process.platform}-${process.arch}`;
const argumentsByName = new Map(process.argv.slice(2).map((value, index, values) => [value, values[index + 1]]));
const expectedTarget = argumentsByName.get("--target") ?? process.env.FLEET_DESKTOP_TARGET ?? nativeTarget;
const [expectedPlatform, expectedArchitecture] = parseTarget(expectedTarget);
const nodeExecutable = expectedPlatform === "win32" ? join(stageDirectory, "node", "node.exe") : join(stageDirectory, "node", "bin", "node");
const runtimeManifest = JSON.parse(await readFile(join(desktopDirectory, "build", "node-runtime.json"), "utf8"));

if (expectedTarget !== nativeTarget) throw new Error(`Sidecar verification target ${expectedTarget} does not match native host ${nativeTarget}`);
await access(nodeExecutable);
await access(join(serviceDirectory, ".fleet-console-resource-root"));
await assertEqual((await readFile(join(serviceDirectory, ".fleet-console-resource-root"), "utf8")).trim(), "1", "resource marker");
await assertEqual((await readFile(join(stageDirectory, "node", ".runtime-target"), "utf8")).trim(), expectedTarget, "staged Node target");
await assertEqual(JSON.parse(await readFile(join(stageDirectory, "target.json"), "utf8")).target, expectedTarget, "sidecar target manifest");
await assertEqual((await runNode(["-p", "process.versions.node"])), runtimeManifest.version, "staged Node version");
await assertEqual((await runNode(["-p", "process.versions.modules"])), runtimeManifest.moduleAbi, "staged Node module ABI");
await assertEqual((await runNode(["-p", "`${process.platform}-${process.arch}`"])), expectedTarget, "staged Node runtime architecture");
await assertNativeTarget(nodeExecutable, expectedPlatform, expectedArchitecture, "sidecar Node");
await verifyRuntimeNativeHelpers(expectedPlatform, expectedArchitecture);
await runNode(["-e", "require('node-pty'); require('ws'); require('esbuild').transformSync('export const value = 1')"], serviceDirectory);
await verifyManifest();
await verifyReadOnlyResources();

console.log("sidecar staging verification passed");

async function runNode(argumentsList, cwd = undefined) {
  const { stdout } = await execFileAsync(nodeExecutable, argumentsList, { cwd });
  return stdout.trim();
}

async function verifyRuntimeNativeHelpers(platform, architecture) {
  // @esbuild의 Windows 패키지는 바이너리를 패키지 루트(esbuild.exe)에 두고, unix 패키지는 bin/esbuild에 둔다.
  const esbuildPackageDirectory = join(serviceDirectory, "node_modules", "@esbuild", `${platform}-${architecture}`);
  const esbuildBinary = platform === "win32"
    ? join(esbuildPackageDirectory, "esbuild.exe")
    : join(esbuildPackageDirectory, "bin", "esbuild");
  await access(esbuildBinary);
  await assertNativeTarget(esbuildBinary, platform, architecture, "esbuild binary");
  const nodePtyDirectory = join(serviceDirectory, "node_modules", "node-pty");
  const helpers = await collectNodePtyNativeHelpers(nodePtyDirectory);
  if (helpers.length === 0) throw new Error("node-pty native helper is missing");
  for (const helper of helpers) await assertNativeTarget(helper, platform, architecture, `node-pty helper ${relative(nodePtyDirectory, helper)}`);
}

async function verifyManifest() {
  const entries = JSON.parse(await readFile(join(stageDirectory, "manifest.json"), "utf8"));
  for (const entry of entries) {
    const filePath = join(stageDirectory, entry.path);
    const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
    await assertEqual(digest, entry.sha256, `digest for ${entry.path}`);
  }
  const packageManifest = await readFile(join(serviceDirectory, "package.json"), "utf8");
  if (packageManifest.includes("workspace:*")) throw new Error("Staged package contains workspace:* dependency");
}

async function verifyReadOnlyResources() {
  const forbidden = ["cache", "logs", "state.json"];
  for (const name of forbidden) {
    if (existsSync(join(serviceDirectory, name))) throw new Error(`Writable resource staged: ${name}`);
  }
  if (expectedPlatform !== "win32" && ((await stat(nodeExecutable)).mode & 0o111) === 0) throw new Error("Staged Node executable bit is missing");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

async function collectNodePtyNativeHelpers(directory) {
  const helpers = [];
  for (const filePath of await collectFiles(directory)) {
    if ([".node", ".dll", ".exe"].includes(extname(filePath).toLowerCase())) {
      helpers.push(filePath);
    } else if (basename(filePath) === "spawn-helper" && isNativeBinary(await readFile(filePath))) {
      helpers.push(filePath);
    }
  }
  return helpers;
}

async function assertNativeTarget(filePath, expectedPlatform, expectedArchitecture, label) {
  const detected = detectNativeTarget(await readFile(filePath));
  if (detected.platform !== expectedPlatform || detected.architecture !== expectedArchitecture) {
    throw new Error(`${label} target mismatch: expected ${expectedPlatform}-${expectedArchitecture}, received ${detected.platform}-${detected.architecture}`);
  }
}

function detectNativeTarget(binary) {
  if (binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { platform: "linux", architecture: readArchitecture(binary.readUInt16LE(18)) };
  if (binary.subarray(0, 2).equals(Buffer.from("MZ"))) {
    const headerOffset = binary.readUInt32LE(0x3c);
    if (binary.subarray(headerOffset, headerOffset + 4).toString("ascii") !== "PE\0\0") throw new Error("Invalid PE native helper");
    return { platform: "win32", architecture: readArchitecture(binary.readUInt16LE(headerOffset + 4)) };
  }
  const magic = binary.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) return { platform: "darwin", architecture: readArchitecture(binary.readUInt32LE(4)) };
  if (binary.readUInt32BE(0) === 0xcafebabe || binary.readUInt32BE(0) === 0xcafebabf) throw new Error("Universal Mach-O binaries are not valid sidecar native helpers");
  throw new Error("Unrecognized native binary format");
}

function isNativeBinary(binary) {
  if (binary.byteLength < 4) return false;
  return binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || binary.subarray(0, 2).equals(Buffer.from("MZ"))
    || [0xfeedfacf, 0xfeedface].includes(binary.readUInt32LE(0))
    || [0xcafebabe, 0xcafebabf].includes(binary.readUInt32BE(0));
}

function readArchitecture(machine) {
  if (machine === 0x01000007 || machine === 0x8664 || machine === 62) return "x64";
  if (machine === 0x0100000c || machine === 0xaa64 || machine === 183) return "arm64";
  throw new Error(`Unsupported native architecture machine code: ${machine}`);
}

function parseTarget(target) {
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(target);
  if (!match) throw new Error(`Invalid sidecar target: ${target}`);
  return [match[1], match[2]];
}

async function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}
