import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invokedAsCli = process.argv[1] === fileURLToPath(import.meta.url);

export const SCHEMA_VERSION = 1;
export const BUNDLE_ID = "com.dotobokuri.fleet-console";
export const DEV_BUNDLE_ID = "com.dotobokuri.fleet-console.dev";
export const PRODUCT_NAME = "Fleet Console";
export const IDENTITY_FILE_NAME = "fleet-package-identity.json";
export const PLIST_IDENTITY_KEY = "FleetSourceRevision";
export const ARCHIVE_NAME = "fleet-desktop-mac.zip";
export const RELEASE_CHECK_ENV = "FLEET_CONSOLE_RELEASE_TAG";
export const RELEASE_CHECK_VALUE = "source";
export const EXECUTABLE_RELATIVE_PATH = "Fleet Console.app/Contents/MacOS/Fleet Console";
export const APP_IDENTITY_RELATIVE_PATH = `Fleet Console.app/Contents/Resources/${IDENTITY_FILE_NAME}`;
export const CONSOLE_CLI_RELATIVE_PATH = "console/dist/cli.mjs";
export const CONSOLE_IDENTITY_RELATIVE_PATH = `console/${IDENTITY_FILE_NAME}`;
export const RUNTIME_LATEST_RELATIVE_TO_HOME = ".fleet/desktop/runtime/console/latest";
export const DESKTOP_RESOURCE_ROOT_MARKER = ".fleet-console-resource-root";
export const DESKTOP_RESOURCE_ROOT_MARKER_CONTENT = "1\n";

const APP_CANDIDATES = ["mac-arm64", "mac-x64", "mac"];

export function assertSourceRevision(sourceRevision) {
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("source revision must be 40 lowercase hex characters");
}

export function identityDocument(sourceRevision) {
  assertSourceRevision(sourceRevision);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "fleet-remote-mac-package",
    sourceRevision,
    bundleId: BUNDLE_ID,
    productName: PRODUCT_NAME,
  };
}

export function assertReleaseBundleIdentifier(bundleId) {
  if (bundleId !== BUNDLE_ID) throw new Error(`remote mac package refuses bundle id ${bundleId || "(missing)"}`);
}

export function stampInfoPlist(xml, sourceRevision) {
  assertSourceRevision(sourceRevision);
  if (!xml.includes(`<string>${BUNDLE_ID}</string>`) || xml.includes(`<string>${DEV_BUNDLE_ID}</string>`)) {
    throw new Error("Info.plist is not the release Fleet Console bundle");
  }
  const entry = `<key>${PLIST_IDENTITY_KEY}</key>\n\t<string>${sourceRevision}</string>\n`;
  const existing = new RegExp(String.raw`<key>${PLIST_IDENTITY_KEY}</key>\s*<string>[^<]*</string>\s*`);
  if (existing.test(xml)) return xml.replace(existing, entry);
  const close = xml.lastIndexOf("</dict>");
  if (close < 0) throw new Error("Info.plist is missing its dictionary");
  return `${xml.slice(0, close)}${entry}${xml.slice(close)}`;
}

export function assertPackagedAppPath(appPath, releaseDirectory) {
  const app = resolve(appPath);
  const release = resolve(releaseDirectory);
  const fromRelease = relative(release, app);
  if (fromRelease === "" || fromRelease.startsWith("..") || fromRelease.split(sep).includes("..")) {
    throw new Error("packaged app is outside the worktree release directory");
  }
  if (basename(app) !== `${PRODUCT_NAME}.app`) throw new Error("remote mac package refuses a renamed or development app");
  if (app.split(sep).includes(".stage")) throw new Error("remote mac package refuses the development app wrapper");
  return app;
}

export function remoteMacManifest(input) {
  assertSourceRevision(input.sourceRevision);
  if (!/^[0-9a-f]{64}$/.test(input.archiveSha256)) throw new Error("archive SHA-256 must be 64 lowercase hex characters");
  return {
    schemaVersion: SCHEMA_VERSION,
    format: "zip",
    sourceRevision: input.sourceRevision,
    sourceDirty: input.sourceDirty === true,
    archivePath: input.archivePath,
    archiveSha256: input.archiveSha256,
    bundleId: BUNDLE_ID,
    executableRelativePath: EXECUTABLE_RELATIVE_PATH,
    appIdentityRelativePath: APP_IDENTITY_RELATIVE_PATH,
    plistIdentityKey: PLIST_IDENTITY_KEY,
    consoleCliRelativePath: CONSOLE_CLI_RELATIVE_PATH,
    consoleIdentityRelativePath: CONSOLE_IDENTITY_RELATIVE_PATH,
    runtimeLatestRelativeToHome: RUNTIME_LATEST_RELATIVE_TO_HOME,
    releaseCheckEnv: { name: RELEASE_CHECK_ENV, value: RELEASE_CHECK_VALUE },
  };
}

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function readSourceRevision(repoRoot) {
  const sourceRevision = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  assertSourceRevision(sourceRevision);
  let sourceDirty = false;
  try {
    await execFileAsync("git", ["-C", repoRoot, "diff", "--quiet", "HEAD"]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) sourceDirty = true;
    else throw error;
  }
  if (!sourceDirty) {
    const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
    sourceDirty = untracked.trim() !== "";
  }
  return { sourceRevision, sourceDirty };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

async function ensureElectronBinary() {
  const pathFile = join(desktopDirectory, "node_modules", "electron", "path.txt");
  try {
    await access(pathFile);
  } catch {
    await execFileAsync(process.execPath, [join(desktopDirectory, "node_modules", "electron", "install.js")], { cwd: desktopDirectory });
  }
}

async function findPackagedApp(releaseDirectory) {
  for (const directory of APP_CANDIDATES) {
    const appPath = join(releaseDirectory, directory, `${PRODUCT_NAME}.app`);
    try {
      await access(appPath);
      return assertPackagedAppPath(appPath, releaseDirectory);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

async function buildPackagedApp(repoRoot, releaseDirectory) {
  await ensureElectronBinary();
  // 원격 E2E 번들은 개인 인증서 대신 ad-hoc 서명으로만 만든다.
  const { CSC_LINK, CSC_NAME, CSC_KEY_PASSWORD, ...env } = process.env;
  await execFileAsync("pnpm", ["--filter", "@dotobokuri/fleet-desktop", "package:dir"], {
    cwd: repoRoot,
    env: { ...env, FLEET_DEV_CODESIGN_IDENTITY: "-", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const appPath = await findPackagedApp(releaseDirectory);
  if (!appPath) throw new Error("package:dir did not produce a Fleet Console.app in the worktree release directory");
  return appPath;
}

async function copyTree(from, to) {
  await rm(to, { force: true, recursive: true });
  await execFileAsync("ditto", [from, to]);
}

async function stampApp(appPath, sourceRevision) {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const { stdout: bundleId } = await execFileAsync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist]);
  assertReleaseBundleIdentifier(bundleId.trim());
  const xmlRaw = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", infoPlist]);
  const stamped = stampInfoPlist(xmlRaw.stdout, sourceRevision);
  const rewritten = join(appPath, "Contents", "Info.plist.fleet-stamp");
  await writeFile(rewritten, stamped);
  await execFileAsync("plutil", ["-convert", "binary1", "-o", infoPlist, rewritten]);
  await rm(rewritten, { force: true });
  const identityPath = join(appPath, "Contents", "Resources", IDENTITY_FILE_NAME);
  await mkdir(dirname(identityPath), { recursive: true });
  await writeFile(identityPath, `${JSON.stringify(identityDocument(sourceRevision), null, 2)}\n`);
  await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

async function deployConsole(repoRoot, consoleDirectory, sourceRevision) {
  await rm(consoleDirectory, { force: true, recursive: true });
  await execFileAsync("pnpm", ["--filter", "@dotobokuri/fleet-console", "--legacy", "deploy", "--prod", consoleDirectory], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  await access(join(consoleDirectory, "dist", "cli.mjs"));
  await access(join(consoleDirectory, "node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper"));
  await writeFile(join(consoleDirectory, DESKTOP_RESOURCE_ROOT_MARKER), DESKTOP_RESOURCE_ROOT_MARKER_CONTENT);
  await writeFile(join(consoleDirectory, IDENTITY_FILE_NAME), `${JSON.stringify(identityDocument(sourceRevision), null, 2)}\n`);
}

async function writeZip(stageDirectory, archivePath) {
  await rm(archivePath, { force: true });
  await execFileAsync("ditto", ["-c", "-k", "--norsrc", stageDirectory, archivePath]);
}

async function prepareRemoteMacPackage() {
  if (process.platform !== "darwin") throw new Error("the remote mac package is built on darwin");
  const repoRoot = (await git(desktopDirectory, ["rev-parse", "--show-toplevel"])).trim();
  const { sourceRevision, sourceDirty } = await readSourceRevision(repoRoot);
  if (sourceDirty) throw new Error("refusing to package a dirty source tree");
  await execFileAsync("pnpm", ["--filter", "@dotobokuri/fleet-console", "build"], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  const releaseDirectory = join(desktopDirectory, "release");
  const outputDirectory = join(releaseDirectory, "remote-mac");
  await mkdir(outputDirectory, { recursive: true });
  const appPath = await buildPackagedApp(repoRoot, releaseDirectory);
  await stampApp(appPath, sourceRevision);
  const consoleDirectory = join(outputDirectory, "console");
  await deployConsole(repoRoot, consoleDirectory, sourceRevision);
  const stageDirectory = join(outputDirectory, "stage");
  await rm(stageDirectory, { force: true, recursive: true });
  await mkdir(stageDirectory, { recursive: true });
  const identity = identityDocument(sourceRevision);
  await writeFile(join(stageDirectory, IDENTITY_FILE_NAME), `${JSON.stringify(identity, null, 2)}\n`);
  await copyTree(appPath, join(stageDirectory, `${PRODUCT_NAME}.app`));
  await copyTree(consoleDirectory, join(stageDirectory, "console"));
  const archivePath = join(outputDirectory, ARCHIVE_NAME);
  await writeZip(stageDirectory, archivePath);
  const manifest = remoteMacManifest({
    sourceRevision,
    sourceDirty,
    archivePath,
    archiveSha256: await sha256File(archivePath),
  });
  await writeFile(join(outputDirectory, "fleet-desktop-mac.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (invokedAsCli) {
  prepareRemoteMacPackage()
    .then((manifest) => {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      process.stderr.write(`remote mac package failed: ${message}\n${stderr}`);
      process.exitCode = 1;
    });
}
