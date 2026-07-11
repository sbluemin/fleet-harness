import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
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

await access(releaseDirectory);
if (target.platform === "darwin") await verifyMacRelease();
if (target.platform === "win32") await verifyWindowsRelease();
if (target.platform === "linux") await verifyLinuxRelease();

console.log(`release artifact verification passed for ${target.value}`);

async function verifyMacRelease() {
  const zipArtifacts = [
    `Fleet Console-${version}-mac-arm64.zip`,
    `Fleet Console-${version}-mac-x64.zip`,
  ];
  const dmgArtifacts = [
    `Fleet Console-${version}-mac-arm64.dmg`,
    `Fleet Console-${version}-mac-x64.dmg`,
  ];
  await requireArtifacts([...zipArtifacts, ...dmgArtifacts, "latest-mac.yml"]);
  await verifyUpdaterMetadata("latest-mac.yml", zipArtifacts);
  for (const artifact of zipArtifacts) await execFileAsync("unzip", ["-t", join(releaseDirectory, artifact)]);
  for (const artifact of dmgArtifacts) await execFileAsync("hdiutil", ["verify", join(releaseDirectory, artifact)]);
  for (const architecture of ["arm64", "x64"]) {
    await verifyPackagedApplication(findUnpackedDirectory("mac", architecture), "darwin", { allowCrossTargetRelease: architecture !== target.architecture });
  }
}

async function verifyWindowsRelease() {
  const installer = `Fleet Console-${version}-win-x64.exe`;
  await requireArtifacts([installer, `${installer}.blockmap`, "latest.yml"]);
  await verifyUpdaterMetadata("latest.yml", [installer]);
  await assertWindowsSignature(join(releaseDirectory, installer));
  const unpackedDirectory = findUnpackedDirectory("win", "x64");
  await verifyPackagedApplication(unpackedDirectory, "win32");
  const nestedPortableExecutables = (await collectFiles(unpackedDirectory)).filter((filePath) => [".exe", ".dll", ".node"].includes(extname(filePath).toLowerCase()));
  if (nestedPortableExecutables.length === 0) throw new Error("Windows unpacked application has no nested PE files to verify");
  for (const filePath of nestedPortableExecutables) await assertWindowsSignature(filePath);
}

async function verifyLinuxRelease() {
  const entries = await readdir(releaseDirectory);
  const appImages = entries.filter((name) => name.endsWith(".AppImage")).sort();
  if (appImages.length !== 1) throw new Error(`Expected exactly one Linux AppImage, found ${appImages.length}`);
  const updater = "latest-linux.yml";
  const signedArtifacts = [...appImages, ...appImages.map((artifact) => `${artifact}.blockmap`), updater];
  await requireArtifacts([...signedArtifacts, "SHA256SUMS", "SHA256SUMS.asc"]);
  await verifyUpdaterMetadata(updater, appImages);
  await verifyLinuxManifest(signedArtifacts);
}

async function verifyUpdaterMetadata(metadataName, expectedArtifacts) {
  const metadata = parseUpdaterYaml(await readFile(join(releaseDirectory, metadataName), "utf8"));
  if (metadata.version !== version) throw new Error(`${metadataName} version mismatch: expected ${version}, received ${metadata.version}`);
  const urls = metadata.files.map((entry) => entry.url);
  if (new Set(urls).size !== urls.length) throw new Error(`${metadataName} contains duplicate updater file metadata`);
  if (urls.length !== expectedArtifacts.length || expectedArtifacts.some((artifact) => !urls.includes(artifact))) {
    throw new Error(`${metadataName} does not contain exactly the expected updater artifacts`);
  }
  for (const artifact of expectedArtifacts) {
    const entry = metadata.files.find((candidate) => candidate.url === artifact);
    await verifyUpdaterFile(metadataName, artifact, entry);
  }
  if (!metadata.path || !urls.includes(metadata.path)) throw new Error(`${metadataName} path must reference one declared updater artifact`);
  if (metadata.sha512) {
    const pathEntry = metadata.files.find((entry) => entry.url === metadata.path);
    if (metadata.sha512 !== pathEntry.sha512) throw new Error(`${metadataName} root SHA-512 does not match its path artifact`);
  }
}

async function verifyUpdaterFile(metadataName, artifact, entry) {
  if (!entry?.sha512 || !Number.isSafeInteger(entry.size)) throw new Error(`${metadataName} has incomplete metadata for ${artifact}`);
  const artifactPath = join(releaseDirectory, artifact);
  const bytes = await readFile(artifactPath);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  if (entry.sha512 !== sha512) throw new Error(`${metadataName} SHA-512 mismatch for ${artifact}`);
  if (entry.size !== bytes.byteLength) throw new Error(`${metadataName} size mismatch for ${artifact}`);
  const blockmapPath = join(releaseDirectory, `${artifact}.blockmap`);
  const blockmap = await stat(blockmapPath);
  if (blockmap.size === 0) throw new Error(`Empty updater blockmap for ${artifact}`);
  if (entry.blockMapSize !== undefined && entry.blockMapSize !== blockmap.size) throw new Error(`${metadataName} blockmap size mismatch for ${artifact}`);
}

async function verifyLinuxManifest(signedArtifacts) {
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
  if (manifest.size !== signedArtifacts.length || signedArtifacts.some((artifact) => !manifest.has(artifact))) {
    throw new Error("Linux checksum manifest must cover exactly AppImage, blockmap, and latest-linux.yml artifacts");
  }
  for (const artifact of signedArtifacts) {
    const actual = createHash("sha256").update(await readFile(join(releaseDirectory, artifact))).digest("hex");
    if (actual !== manifest.get(artifact)) throw new Error(`Checksum mismatch for ${artifact}`);
  }
}

async function assertWindowsSignature(filePath) {
  const { stdout, stderr } = await execFileAsync("signtool", ["verify", "/pa", "/all", "/v", "/tw", filePath]);
  const output = `${stdout}\n${stderr}`;
  if (!/successfully verified/i.test(output) || !/timestamp/i.test(output)) throw new Error(`Authenticode or timestamp verification failed: ${filePath}`);
}

async function requireArtifacts(names) {
  for (const name of names) await access(join(releaseDirectory, name));
}

function findUnpackedDirectory(platform, architecture) {
  const candidates = platform === "mac"
    ? [join(releaseDirectory, `mac-${architecture}`), join(releaseDirectory, "mac")]
    : [join(releaseDirectory, `win-${architecture}-unpacked`), join(releaseDirectory, "win-unpacked")];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) throw new Error(`Missing unpacked ${platform}-${architecture} application for native signature verification`);
  return directory;
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

function parseUpdaterYaml(contents) {
  const metadata = { files: [] };
  let currentFile;
  for (const rawLine of contents.split("\n")) {
    if (/^\s*(#|$)/.test(rawLine)) continue;
    const listUrl = /^\s*-\s+url:\s*(.+?)\s*$/.exec(rawLine);
    if (listUrl) {
      currentFile = { url: parseYamlScalar(listUrl[1]) };
      metadata.files.push(currentFile);
      continue;
    }
    const nested = /^\s{4,}(sha512|size|blockMapSize):\s*(.+?)\s*$/.exec(rawLine);
    if (nested && currentFile) {
      currentFile[nested[1]] = parseYamlScalar(nested[2]);
      continue;
    }
    const root = /^(version|path|sha512):\s*(.+?)\s*$/.exec(rawLine);
    if (root) metadata[root[1]] = parseYamlScalar(root[2]);
  }
  return metadata;
}

function parseYamlScalar(value) {
  const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
  if (/^\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function assertReleaseEnvironment() {
  if (process.env.FLEET_DESKTOP_RELEASE !== "1") throw new Error("FLEET_DESKTOP_RELEASE=1 is required for release artifact verification");
  const value = process.env.FLEET_DESKTOP_TARGET;
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(value ?? "");
  if (!match) throw new Error("FLEET_DESKTOP_TARGET must name a supported platform and architecture");
  if (`${process.platform}-${process.arch}` !== value) throw new Error(`Release artifact verification must run on a native ${value} runner`);
  const credentials = match[1] === "darwin"
    ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
    : match[1] === "win32"
      ? ["CSC_LINK", "CSC_KEY_PASSWORD"]
      : ["FLEET_LINUX_GPG_KEY", "FLEET_LINUX_GPG_KEYRING"];
  for (const name of credentials) if (!process.env[name]) throw new Error(`${name} is required for ${value} release artifact verification`);
  return { value, platform: match[1], architecture: match[2] };
}
