import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { verifyPackagedApplication } from "./verify-packaged-app.mjs";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(process.argv[2] ?? join(desktopDirectory, "release"));
const version = JSON.parse(await readFile(join(desktopDirectory, "package.json"), "utf8")).version;
const target = assertReleaseEnvironment();

await assertUpdaterMetadata(releaseDirectory, target.platform);
if (target.platform === "darwin") await verifyMacRelease();
if (target.platform === "win32") await verifyWindowsRelease();
if (target.platform === "linux") await verifyLinuxRelease();

console.log(`release artifact verification passed for ${target.value}`);

async function verifyMacRelease() {
  const artifacts = ["arm64", "x64"].flatMap((architecture) => [`Fleet-Console-${version}-mac-${architecture}.zip`, `Fleet-Console-${version}-mac-${architecture}.dmg`]);
  await requireArtifacts(artifacts);
  for (const artifact of artifacts) {
    if (artifact.endsWith(".zip")) await execFileAsync("unzip", ["-t", join(releaseDirectory, artifact)]);
    else await execFileAsync("hdiutil", ["verify", join(releaseDirectory, artifact)]);
  }
  for (const architecture of ["arm64", "x64"]) await verifyPackagedApplication(findUnpackedDirectory("mac", architecture), "darwin");
}

async function verifyWindowsRelease() {
  const installer = `Fleet-Console-${version}-win-x64.exe`;
  await requireArtifacts([installer]);
  await assertWindowsSignature(join(releaseDirectory, installer));
  await verifyPackagedApplication(findUnpackedDirectory("win", "x64"), "win32");
}

async function verifyLinuxRelease() {
  const appImages = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".AppImage")).sort();
  if (appImages.length !== 1) throw new Error(`Expected exactly one Linux AppImage, found ${appImages.length}`);
  await requireArtifacts([...appImages, "SHA256SUMS", "SHA256SUMS.asc"]);
  await verifyLinuxManifest(appImages);
}

async function verifyLinuxManifest(artifacts) {
  const keyring = process.env.FLEET_LINUX_GPG_KEYRING;
  if (!keyring) throw new Error("FLEET_LINUX_GPG_KEYRING is required to verify Linux release signatures");
  await access(keyring);
  const checksumPath = join(releaseDirectory, "SHA256SUMS");
  await execFileAsync("gpgv", ["--keyring", keyring, `${checksumPath}.asc`, checksumPath]);
  const manifest = new Map();
  for (const line of (await readFile(checksumPath, "utf8")).trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || manifest.has(match[2])) throw new Error("Linux checksum manifest has an invalid or duplicate entry");
    manifest.set(match[2], match[1]);
  }
  if (manifest.size !== artifacts.length || artifacts.some((artifact) => !manifest.has(artifact))) throw new Error("Linux checksum manifest must cover exactly AppImage artifacts");
  for (const artifact of artifacts) {
    const actual = createHash("sha256").update(await readFile(join(releaseDirectory, artifact))).digest("hex");
    if (actual !== manifest.get(artifact)) throw new Error(`Checksum mismatch for ${artifact}`);
  }
}

async function assertWindowsSignature(filePath) {
  const { stdout, stderr } = await execFileAsync("signtool", ["verify", "/pa", "/all", "/v", "/tw", filePath]);
  if (!/successfully verified/i.test(`${stdout}\n${stderr}`) || !/timestamp/i.test(`${stdout}\n${stderr}`)) throw new Error(`Authenticode or timestamp verification failed: ${filePath}`);
}

async function requireArtifacts(names) {
  for (const name of names) await access(join(releaseDirectory, name));
}

function findUnpackedDirectory(platform, architecture) {
  const candidates = platform === "mac" ? [join(releaseDirectory, `mac-${architecture}`), join(releaseDirectory, "mac")] : [join(releaseDirectory, `win-${architecture}-unpacked`), join(releaseDirectory, "win-unpacked")];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) throw new Error(`Missing unpacked ${platform}-${architecture} application for native signature verification`);
  return directory;
}

/**
 * 갱신 메타데이터는 이제 산출물의 일부다 — 셸이 자기 자신을 이 파일로 갱신한다.
 * 비어 있거나 다른 버전을 가리키는 메타데이터는 없는 것보다 나쁘므로, 이름과 함께 버전도 본다.
 * Linux는 자동 갱신 대상이 아니라 메타데이터를 요구하지 않는다.
 */
function updaterMetadataFileName(platform) {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return null;
}

async function assertUpdaterMetadata(root, platform) {
  const fileName = updaterMetadataFileName(platform);
  if (!fileName) return;
  const metadataPath = join(root, fileName);
  await access(metadataPath);
  const metadata = await readFile(metadataPath, "utf8");
  const declared = /^version:\s*(\S+)\s*$/m.exec(metadata)?.[1];
  if (declared !== version) throw new Error(`${fileName} declares version ${declared ?? "(none)"}, expected ${version}`);
  if (!metadata.includes(`Fleet-Console-${version}-`)) throw new Error(`${fileName} does not reference the packaged ${version} artifacts`);
}

function assertReleaseEnvironment() {
  if (process.env.FLEET_DESKTOP_RELEASE !== "1") throw new Error("FLEET_DESKTOP_RELEASE=1 is required for release artifact verification");
  const value = process.env.FLEET_DESKTOP_TARGET;
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(value ?? "");
  if (!match) throw new Error("FLEET_DESKTOP_TARGET must name a supported platform and architecture");
  if (`${process.platform}-${process.arch}` !== value) throw new Error(`Release artifact verification must run on a native ${value} runner`);
  const credentials = match[1] === "darwin" ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] : match[1] === "win32" ? ["CSC_LINK", "CSC_KEY_PASSWORD"] : ["FLEET_LINUX_GPG_KEY", "FLEET_LINUX_GPG_KEYRING"];
  for (const name of credentials) if (!process.env[name]) throw new Error(`${name} is required for ${value} release artifact verification`);
  return { value, platform: match[1], architecture: match[2] };
}
