import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { existsSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productName = "Fleet Console";
const invokedAsCli = process.argv[1] === fileURLToPath(import.meta.url);
const cliArguments = invokedAsCli ? parseCliArguments(process.argv.slice(2)) : { preflight: false, release: false, releaseDirectory: undefined };
const requiresReleaseSignature = process.env.FLEET_DESKTOP_RELEASE === "1" || cliArguments.release;

export default async function verifyAfterPack(context) {
  const platform = context?.electronPlatformName ?? process.platform;
  const applications = await findApplications(context?.appOutDir ?? join(desktopDirectory, "release"), platform);
  if (applications.length === 0) throw new Error("afterPack did not produce an unpacked Fleet Console application");
  for (const application of applications) await verifyPackagedArchitecture(application, platform);
}

if (invokedAsCli) {
  if (cliArguments.preflight) {
    assertReleasePreflight();
  } else {
    const releaseDirectory = resolve(cliArguments.releaseDirectory ?? join(desktopDirectory, "release"));
    await verifyPackagedApplication(releaseDirectory, process.env.FLEET_DESKTOP_PLATFORM ?? process.platform);
    if (cliArguments.release && process.platform === "linux") await signAndVerifyLinuxRelease(releaseDirectory);
  }
}

export async function verifyPackagedApplication(releaseDirectory, platform = process.platform, options = {}) {
  const applications = await findApplications(releaseDirectory, platform);
  if (applications.length === 0) throw new Error(`No unpacked Fleet Console application found in ${releaseDirectory}`);
  for (const application of applications) await verifyApplication(application, platform, options);
  console.log(`packaged application verification passed for ${applications.length} artifact(s)`);
}

async function verifyApplication(application, platform, options) {
  const nativeHelpers = await verifyPackagedArchitecture(application, platform, options);
  await assertFuses(application.electronBinary);
  await assertMacSignature(application, nativeHelpers);
  if (platform === "win32" && requiresReleaseSignature) await assertWindowsSignatures([application.electronBinary, application.sidecarNode, ...nativeHelpers]);
}

async function verifyPackagedArchitecture(application, platform, options = {}) {
  const sidecarTarget = JSON.parse(await readFile(join(application.sidecarDirectory, "target.json"), "utf8")).target;
  const [sidecarPlatform, sidecarArchitecture] = parseTarget(sidecarTarget);
  if (sidecarPlatform !== platform) throw new Error(`Sidecar platform ${sidecarPlatform} does not match packaged platform ${platform}`);
  if (requiresReleaseSignature && !options.allowCrossTargetRelease) assertReleaseEnvironment(sidecarTarget);
  await access(application.asar);
  await access(application.sidecarNode);
  await access(application.sidecarService);
  await access(join(application.sidecarService, ".fleet-console-resource-root"));
  await assertSidecarOutsideAsar(application.asar, application.sidecarNode, application.sidecarService);
  await assertNativeTarget(application.electronBinary, platform, sidecarArchitecture, "Electron binary");
  await assertNativeTarget(application.sidecarNode, sidecarPlatform, sidecarArchitecture, "sidecar Node");
  const nativeHelpers = await verifyRuntimeNativeHelpers(application.sidecarService, sidecarPlatform, sidecarArchitecture);
  if (platform !== "win32" && ((await stat(application.sidecarNode)).mode & 0o111) === 0) throw new Error(`Sidecar Node is not executable: ${application.sidecarNode}`);
  return nativeHelpers;
}

async function findApplications(root, platform) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const applications = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== "resources") continue;
    const resourceDirectory = join(entry.parentPath, entry.name);
    const sidecarDirectory = join(resourceDirectory, "sidecar");
    const asar = join(resourceDirectory, "app.asar");
    const sidecarNode = platform === "win32" ? join(sidecarDirectory, "node", "node.exe") : join(sidecarDirectory, "node", "bin", "node");
    if (!existsSync(asar) || !existsSync(sidecarNode)) continue;
    const appRoot = platform === "darwin" ? dirname(dirname(resourceDirectory)) : dirname(resourceDirectory);
    applications.push({
      appBundle: platform === "darwin" ? appRoot : null,
      appRoot,
      asar,
      electronBinary: findInstalledElectronBinary(resourceDirectory, platform),
      sidecarDirectory,
      sidecarNode,
      sidecarService: join(sidecarDirectory, "fleet-console"),
    });
  }
  return applications;
}

function findInstalledElectronBinary(resourceDirectory, platform) {
  const contentsDirectory = dirname(resourceDirectory);
  if (platform === "darwin") return join(contentsDirectory, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  if (platform === "win32") return join(dirname(resourceDirectory), `${productName}.exe`);
  return join(dirname(resourceDirectory), productName);
}

async function verifyRuntimeNativeHelpers(serviceDirectory, platform, architecture) {
  // @esbuild의 Windows 패키지는 바이너리를 패키지 루트(esbuild.exe)에 두고, unix 패키지는 bin/esbuild에 둔다.
  const esbuildPackageDirectory = join(serviceDirectory, "node_modules", "@esbuild", `${platform}-${architecture}`);
  const esbuildBinary = platform === "win32"
    ? join(esbuildPackageDirectory, "esbuild.exe")
    : join(esbuildPackageDirectory, "bin", "esbuild");
  await access(esbuildBinary);
  await assertNativeTarget(esbuildBinary, platform, architecture, "esbuild binary");
  const nodePtyDirectory = join(serviceDirectory, "node_modules", "node-pty");
  const nodePtyHelpers = await collectNodePtyNativeHelpers(nodePtyDirectory);
  if (nodePtyHelpers.length === 0) throw new Error("node-pty native helper is missing");
  for (const helper of nodePtyHelpers) await assertNativeTarget(helper, platform, architecture, `node-pty helper ${relative(nodePtyDirectory, helper)}`);
  return [esbuildBinary, ...nodePtyHelpers];
}

async function assertSidecarOutsideAsar(asar, node, service) {
  const asarPrefix = `${resolve(asar)}${process.platform === "win32" ? "\\\\" : "/"}`;
  if (resolve(node).startsWith(asarPrefix) || resolve(service).startsWith(asarPrefix)) throw new Error("Sidecar is inside app.asar");
}

async function assertFuses(electronBinary) {
  const wire = await getCurrentFuseWire(electronBinary);
  const required = [
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  ];
  for (const [fuse, expected] of required) {
    if (wire[fuse] !== expected) throw new Error(`Electron fuse ${fuse} is not configured securely`);
  }
}

async function assertMacSignature(application, nativeHelpers) {
  if (process.platform !== "darwin" || !application.appBundle) return;
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", application.appBundle]);
  const signedFiles = [application.electronBinary, application.sidecarNode, ...nativeHelpers];
  for (const filePath of signedFiles) await assertDeveloperIdOrAdHocSignature(filePath, requiresReleaseSignature);
  if (requiresReleaseSignature) {
    await execFileAsync("xcrun", ["stapler", "validate", application.appBundle]);
    await execFileAsync("spctl", ["--assess", "--type", "execute", "--verbose=4", application.appBundle]);
  }
}

async function assertDeveloperIdOrAdHocSignature(filePath, requireDeveloperId) {
  await execFileAsync("codesign", ["--verify", "--strict", filePath]);
  const { stderr } = await execFileAsync("codesign", ["-dvvv", filePath]);
  if (requireDeveloperId && !stderr.includes("Authority=Developer ID Application")) throw new Error(`Release native helper is not Developer ID signed: ${filePath}`);
  if (!requireDeveloperId && !stderr.includes("Signature=adhoc") && !stderr.includes("Authority=Developer ID Application")) throw new Error(`Local native helper has no valid signature: ${filePath}`);
}

async function assertWindowsSignatures(files) {
  for (const filePath of files) {
    const { stdout, stderr } = await execFileAsync("signtool", ["verify", "/pa", "/all", "/v", "/tw", filePath]);
    if (!/successfully verified/i.test(`${stdout}\n${stderr}`) || !/timestamp/i.test(`${stdout}\n${stderr}`)) throw new Error(`Authenticode timestamp verification failed: ${filePath}`);
  }
}

async function signAndVerifyLinuxRelease(releaseDirectory) {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  await execFileAsync(process.execPath, [join(scriptsDirectory, "sign-linux-checksums.mjs"), releaseDirectory]);
  await execFileAsync(process.execPath, [join(scriptsDirectory, "verify-release-artifacts.mjs"), releaseDirectory]);
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
    if (binary.subarray(headerOffset, headerOffset + 4).toString("ascii") !== "PE\0\0") throw new Error("Invalid PE binary");
    return { platform: "win32", architecture: readArchitecture(binary.readUInt16LE(headerOffset + 4)) };
  }
  const magic = binary.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) return { platform: "darwin", architecture: readArchitecture(binary.readUInt32LE(4)) };
  if (binary.readUInt32BE(0) === 0xcafebabe || binary.readUInt32BE(0) === 0xcafebabf) throw new Error("Universal Electron binaries are not valid single-target packages");
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
  if (!match) throw new Error(`Invalid packaged sidecar target: ${target}`);
  return [match[1], match[2]];
}

function parseCliArguments(argumentsList) {
  let preflight = false;
  let release = false;
  let releaseDirectory;
  for (const argument of argumentsList) {
    if (argument === "--preflight") {
      if (preflight) throw new Error("--preflight may only be provided once");
      preflight = true;
      continue;
    }
    if (argument === "--release") {
      if (release) throw new Error("--release may only be provided once");
      release = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown verification option: ${argument}`);
    if (releaseDirectory) throw new Error("Only one packaged application directory may be provided");
    releaseDirectory = argument;
  }
  if (preflight && (release || releaseDirectory)) throw new Error("--preflight cannot be combined with release verification arguments");
  return { preflight, release, releaseDirectory };
}

function assertReleasePreflight() {
  const target = process.env.FLEET_DESKTOP_TARGET;
  if (!target) throw new Error("FLEET_DESKTOP_TARGET is required for release verification");
  parseTarget(target);
  assertReleaseEnvironment(target);
}

function assertReleaseEnvironment(target) {
  if (process.env.FLEET_DESKTOP_RELEASE !== "1") throw new Error("FLEET_DESKTOP_RELEASE=1 is required for release verification");
  if (process.env.FLEET_DESKTOP_TARGET !== target) throw new Error(`FLEET_DESKTOP_TARGET must match packaged sidecar target ${target}`);
  if (`${process.platform}-${process.arch}` !== target) throw new Error(`Release verification must run on a native ${target} runner`);
  const credentials = process.platform === "darwin"
    ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
    : process.platform === "win32"
      ? ["CSC_LINK", "CSC_KEY_PASSWORD"]
      : ["FLEET_LINUX_GPG_KEY", "FLEET_LINUX_GPG_KEYRING"];
  for (const name of credentials) if (!process.env[name]) throw new Error(`${name} is required for ${target} release verification`);
}
