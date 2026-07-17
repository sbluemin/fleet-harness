import { extractFile, listPackage } from "@electron/asar";
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { existsSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invokedAsCli = process.argv[1] === fileURLToPath(import.meta.url);
const cliArguments = invokedAsCli ? parseCliArguments(process.argv.slice(2)) : { preflight: false, release: false, releaseDirectory: undefined };
const requiresReleaseSignature = process.env.FLEET_DESKTOP_RELEASE === "1" || cliArguments.release;

export default async function verifyAfterPack(context) {
  const platform = context?.electronPlatformName ?? process.platform;
  const outputDirectory = context?.appOutDir ?? join(desktopDirectory, "release");
  await applyRequiredFuses(outputDirectory, platform);
  await verifyPackagedApplication(outputDirectory, platform);
}

if (invokedAsCli) {
  if (cliArguments.preflight) assertReleasePreflight();
  else {
    const releaseDirectory = resolve(cliArguments.releaseDirectory ?? join(desktopDirectory, "release"));
    const platform = process.env.FLEET_DESKTOP_PLATFORM ?? process.platform;
    await verifyPackagedApplication(releaseDirectory, platform);
    if (requiresReleaseSignature && platform === "linux") await signAndVerifyLinuxRelease(releaseDirectory);
  }
}

export async function verifyPackagedApplication(releaseDirectory, platform = process.platform) {
  await assertNoUpdaterArtifacts(releaseDirectory);
  const applications = await findApplications(releaseDirectory, platform);
  if (applications.length === 0) throw new Error(`No unpacked Fleet Console application found in ${releaseDirectory}`);
  for (const application of applications) await verifyApplication(application, platform);
  console.log(`packaged application verification passed for ${applications.length} artifact(s)`);
}

async function verifyApplication(application, platform) {
  await access(application.asar);
  if (existsSync(join(application.resourcesDirectory, "sidecar"))) throw new Error("Embedded sidecar directory is forbidden");
  await assertShellOnlyAsar(application.asar);
  const expectedArchitecture = expectedArchitectureForApplication(application.resourcesDirectory, platform);
  await assertElectronArchitecture(application.fuseBinary, platform, expectedArchitecture);
  await assertFuses(application.fuseBinary);
  await assertMacSignature(application, platform);
  if (platform === "win32" && requiresReleaseSignature) await assertWindowsSignature(application.electronBinary);
}

async function applyRequiredFuses(outputDirectory, platform) {
  for (const application of await findApplications(outputDirectory, platform)) {
    await flipFuses(application.fuseBinary, {
      version: FuseVersion.V1,
      // flipFuses의 config 값은 불리언 계약이다 — FuseState 상수(48/49)는 truthy라 전부 ENABLE로 기록되는 함정.
      // FuseState는 판독(assertFuses) 비교 전용으로만 쓴다.
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // 이 fuse를 끄면 렌더러가 asar 내부를 file://로 읽는 특권을 잃어, 셸이 자기 엔트리 HTML
      // (dist/assets/entry/index.html 및 pairing/index.html, ASAR 내부)을 loadFile로 로드하지 못하고 ERR_FILE_NOT_FOUND로
      // 창이 뜨기 전에 죽는다. 이 셸은 신뢰 불가한 file:// 콘텐츠를 로드하는 경로가 없고(엔트리는
      // 스크립트 없는 CSP 잠금 로컬 페이지, 콘솔은 http loopback) 실질 보안 효과가 없으므로 켜둔다.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
      resetAdHocDarwinSignature: true,
    });
  }
}

async function assertShellOnlyAsar(asar) {
  const files = new Map(listPackage(asar, { isPack: false }).map((file) => [normalizeAsarContractPath(file), normalizeAsarEntryPath(file)]));
  const required = ["dist/assets/entry/index.html", "dist/assets/entry/entry.css", "dist/assets/pairing/index.html", "dist/assets/pairing/pairing.css", "dist/build/node-runtime.json", "dist/build/trayTemplate.png", "dist/build/trayTemplate@2x.png"];
  for (const file of required) if (!files.has(file)) throw new Error(`Shell ASAR is missing ${file}`);
  const forbidden = [".fleet-console-resource-root", "dist/cli.mjs", "fleet-console/", "node-pty/", "node_modules/"];
  for (const file of files.keys()) if (forbidden.some((prefix) => file === prefix || file.includes(`/${prefix}`))) throw new Error(`Shell ASAR embeds forbidden runtime payload: ${file}`);
  const entryHtml = extractFile(asar, files.get("dist/assets/entry/index.html")).toString("utf8");
  if (!entryHtml.includes("default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'")) throw new Error("Entry CSP contract is missing");
  if (/<(script|button|a|form|input)\b|contenteditable|tabindex/i.test(entryHtml)) throw new Error("Entry HTML is not passive and scriptless");
  const pairingHtml = extractFile(asar, files.get("dist/assets/pairing/index.html")).toString("utf8");
  if (!pairingHtml.includes("default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action fleet-desktop-pairing:")) throw new Error("Pairing CSP contract is missing");
  if (/<script\b|\bon\w+\s*=/i.test(pairingHtml)) throw new Error("Pairing HTML contains JavaScript");
}

async function findApplications(root, platform) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const applications = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== "resources") continue;
    const resourcesDirectory = join(entry.parentPath, entry.name);
    const asar = join(resourcesDirectory, "app.asar");
    if (!existsSync(asar)) continue;
    const appRoot = platform === "darwin" ? dirname(dirname(resourcesDirectory)) : dirname(resourcesDirectory);
    const electronBinary = findInstalledElectronBinary(resourcesDirectory, platform);
    applications.push({ appBundle: platform === "darwin" ? appRoot : null, asar, electronBinary, fuseBinary: findFuseBinary(resourcesDirectory, electronBinary, platform), resourcesDirectory });
  }
  return applications;
}

function findInstalledElectronBinary(resourcesDirectory, platform) {
  const contentsDirectory = dirname(resourcesDirectory);
  if (platform === "darwin") return join(contentsDirectory, "MacOS", "Fleet Console");
  if (platform === "win32") return join(dirname(resourcesDirectory), "Fleet Console.exe");
  return join(dirname(resourcesDirectory), "Fleet Console");
}

// macOS의 fuse 와이어는 런처가 아니라 Electron Framework 바이너리에 있다. @electron/fuses는 런처 경로를
// 내부적으로 프레임워크로 redirect하지만, 보안 하드닝 대상을 라이브러리 내부 동작에 의존하지 않고 명시적으로
// 프레임워크 바이너리를 겨냥한다(런처는 fuse sentinel이 없어 직접 대상이 될 수 없다). 서명 검사는 런처를 계속 쓴다.
function findFuseBinary(resourcesDirectory, electronBinary, platform) {
  if (platform !== "darwin") return electronBinary;
  const contentsDirectory = dirname(resourcesDirectory);
  return join(contentsDirectory, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
}

async function assertFuses(electronBinary) {
  const wire = await getCurrentFuseWire(electronBinary);
  // GrantFileProtocolExtraPrivileges=ENABLE도 검증한다 — 이 fuse가 꺼지면 렌더러가 asar 내부 엔트리를
  // file://로 못 읽어 부팅이 ERR_FILE_NOT_FOUND로 깨지므로, 부팅 필수 계약으로서 회귀를 여기서 잡는다.
  const required = [[FuseV1Options.RunAsNode, FuseState.DISABLE], [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE], [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE], [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE], [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE], [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.ENABLE]];
  for (const [fuse, expected] of required) if (wire[fuse] !== expected) throw new Error(`Electron fuse ${fuse} is not configured securely`);
}

async function assertMacSignature(application, platform) {
  if (process.platform !== "darwin" || platform !== "darwin" || !application.appBundle) return;
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", application.appBundle]);
  const { stderr } = await execFileAsync("codesign", ["-dvvv", application.electronBinary]);
  if (requiresReleaseSignature && !stderr.includes("Authority=Developer ID Application")) throw new Error("Release Electron binary is not Developer ID signed");
  if (!requiresReleaseSignature && !stderr.includes("Signature=adhoc") && !stderr.includes("Authority=Developer ID Application")) throw new Error("Local Electron binary has no valid signature");
  if (requiresReleaseSignature) {
    await execFileAsync("xcrun", ["stapler", "validate", application.appBundle]);
    await execFileAsync("spctl", ["--assess", "--type", "execute", "--verbose=4", application.appBundle]);
  }
}

async function assertWindowsSignature(filePath) {
  const { stdout, stderr } = await execFileAsync("signtool", ["verify", "/pa", "/all", "/v", "/tw", filePath]);
  if (!/successfully verified/i.test(`${stdout}\n${stderr}`) || !/timestamp/i.test(`${stdout}\n${stderr}`)) throw new Error(`Authenticode timestamp verification failed: ${filePath}`);
}

export async function assertElectronArchitecture(electronBinary, platform, expectedArchitecture) {
  const detected = detectElectronArchitecture(await readFile(electronBinary));
  if (detected.platform !== platform || detected.architecture !== expectedArchitecture) throw new Error(`Electron binary target mismatch: expected ${platform}-${expectedArchitecture}, received ${detected.platform}-${detected.architecture}`);
}

export function expectedArchitectureFromDirectory(resourcesDirectory) {
  let current = resolve(resourcesDirectory);
  while (dirname(current) !== current) {
    const match = /(?:^|-)(arm64|x64)(?:-unpacked)?$/i.exec(basename(current));
    if (match) return match[1].toLowerCase();
    current = dirname(current);
  }
  return null;
}

export function expectedArchitectureForApplication(resourcesDirectory, platform, environment = process.env, nativeArchitecture = process.arch) {
  const fromDirectory = expectedArchitectureFromDirectory(resourcesDirectory);
  if (fromDirectory) return fromDirectory;
  const target = environment.FLEET_DESKTOP_TARGET;
  if (target) {
    const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(target);
    if (!match || match[1] !== platform) throw new Error(`FLEET_DESKTOP_TARGET cannot determine architecture for ${platform} package verification`);
    return match[2];
  }
  const contextPlatform = environment.FLEET_DESKTOP_PLATFORM;
  if (contextPlatform && contextPlatform !== platform) throw new Error(`FLEET_DESKTOP_PLATFORM does not match ${platform} package verification`);
  if (nativeArchitecture === "arm64" || nativeArchitecture === "x64") return nativeArchitecture;
  throw new Error(`Unable to determine expected Electron architecture for ${platform} package verification`);
}

async function signAndVerifyLinuxRelease(releaseDirectory) {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  await execFileAsync(process.execPath, [join(scriptsDirectory, "sign-linux-checksums.mjs"), releaseDirectory]);
  await execFileAsync(process.execPath, [join(scriptsDirectory, "verify-release-artifacts.mjs"), releaseDirectory]);
}

function detectElectronArchitecture(binary) {
  if (binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { platform: "linux", architecture: readArchitecture(binary.readUInt16LE(18)) };
  if (binary.subarray(0, 2).equals(Buffer.from("MZ"))) {
    const headerOffset = binary.readUInt32LE(0x3c);
    if (binary.subarray(headerOffset, headerOffset + 4).toString("ascii") !== "PE\0\0") throw new Error("Invalid PE Electron binary");
    return { platform: "win32", architecture: readArchitecture(binary.readUInt16LE(headerOffset + 4)) };
  }
  const magic = binary.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) return { platform: "darwin", architecture: readArchitecture(binary.readUInt32LE(4)) };
  if (binary.readUInt32BE(0) === 0xcafebabe || binary.readUInt32BE(0) === 0xcafebabf) throw new Error("Universal Electron binaries are not valid single-target packages");
  throw new Error("Unrecognized Electron binary format");
}

function readArchitecture(machine) {
  if (machine === 0x01000007 || machine === 0x8664 || machine === 62) return "x64";
  if (machine === 0x0100000c || machine === 0xaa64 || machine === 183) return "arm64";
  throw new Error(`Unsupported Electron binary machine code: ${machine}`);
}

function normalizeAsarContractPath(file) {
  return file.replace(/\\/g, "/").replace(/^\//, "");
}

function normalizeAsarEntryPath(file) {
  return file.replace(/^[\\/]/, "");
}

async function assertNoUpdaterArtifacts(root) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) if (entry.isFile() && (/^latest.*\.yml$/i.test(entry.name) || entry.name.endsWith(".blockmap"))) throw new Error(`Updater artifact is forbidden: ${join(entry.parentPath, entry.name)}`);
}

function parseCliArguments(argumentsList) {
  let preflight = false;
  let release = false;
  let releaseDirectory;
  for (const argument of argumentsList) {
    if (argument === "--preflight") preflight = true;
    else if (argument === "--release") release = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown verification option: ${argument}`);
    else if (releaseDirectory) throw new Error("Only one packaged application directory may be provided");
    else releaseDirectory = argument;
  }
  if (preflight && (release || releaseDirectory)) throw new Error("--preflight cannot be combined with release verification arguments");
  return { preflight, release, releaseDirectory };
}

function assertReleasePreflight() {
  const target = process.env.FLEET_DESKTOP_TARGET;
  if (!target) throw new Error("FLEET_DESKTOP_TARGET is required for release verification");
  if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) throw new Error("FLEET_DESKTOP_TARGET must name a supported platform and architecture");
  if (process.env.FLEET_DESKTOP_RELEASE !== "1") throw new Error("FLEET_DESKTOP_RELEASE=1 is required for release verification");
  if (`${process.platform}-${process.arch}` !== target) throw new Error(`Release verification must run on a native ${target} runner`);
  const credentials = process.platform === "darwin" ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] : process.platform === "win32" ? ["CSC_LINK", "CSC_KEY_PASSWORD"] : ["FLEET_LINUX_GPG_KEY", "FLEET_LINUX_GPG_KEYRING"];
  for (const name of credentials) if (!process.env[name]) throw new Error(`${name} is required for ${target} release verification`);
}
