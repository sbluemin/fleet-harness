import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const workspaceDirectory = resolve(desktopDirectory, "../..");
const consoleDirectory = join(workspaceDirectory, "runtime", "fleet-console");
const sdkDirectory = join(consoleDirectory, "sdk");
const stageDirectory = join(desktopDirectory, ".stage", "sidecar");
const nodeDirectory = join(stageDirectory, "node");
const serviceDirectory = join(stageDirectory, "fleet-console");
const argumentsByName = new Map(process.argv.slice(2).map((value, index, values) => [value, values[index + 1]]));
// Windows는 x64만 지원/배포한다. arm64 Windows(예: Apple Silicon Parallels)에서도 x64를 스테이징해
// x64 산출물을 만들 수 있게 한다 — arm64 Windows가 x64를 에뮬레이션으로 실행하므로 로컬 테스트가 가능하다.
// 스테이징은 네이티브 바이너리를 "복사"만 하므로(실행하지 않으므로) 크로스 arch가 안전하다.
const supportedTarget = `${process.platform}-${process.platform === "win32" ? "x64" : process.arch}`;
const runtimeTarget = argumentsByName.get("--target") ?? process.env.FLEET_DESKTOP_TARGET ?? supportedTarget;

if (runtimeTarget !== supportedTarget) {
  throw new Error(`Sidecar target ${runtimeTarget} is not supported on this host (expected ${supportedTarget})`);
}
const runtimeArch = runtimeTarget.split("-")[1];

await buildConsolePackage();
await rm(stageDirectory, { force: true, recursive: true });
await mkdir(join(serviceDirectory, "node_modules"), { recursive: true });
await execFileAsync(process.execPath, [join(scriptDirectory, "fetch-node-runtime.mjs"), "--target", runtimeTarget, "--output", nodeDirectory], { cwd: desktopDirectory });

await copyRequiredConsoleFiles();
await copyRuntimeDependency("node-pty");
await pruneNodePtyNativeHelpers();
await copyRuntimeDependency("ws");
await copyRuntimeDependency("font-list");
await copyEsbuildRuntime();
await cp(sdkDirectory, join(serviceDirectory, "node_modules", "@fleet-console", "sdk"), { dereference: true, filter: excludeNodeModules, recursive: true });
await writeSanitizedPackageManifest();
await writeLicenseInventory();
await writeTargetManifest();
await writeDigestManifest();
await preserveExecutableModes();

console.log(JSON.stringify({ nodeDirectory, runtimeTarget, serviceDirectory }));

async function buildConsolePackage() {
  // Windows에서 `pnpm`은 pnpm.cmd 셔임이라 shell 없는 spawn이 ENOENT로 실패하고, 최신 Node는
  // 보안상 .cmd/.bat 직접 실행을 거부한다. 이 스크립트를 실행한 패키지 매니저(npm_execpath는 pnpm의
  // JS 진입점)를 node로 직접 구동해 크로스플랫폼으로 호출하고, npm_execpath가 없을 때(직접 node 실행)만
  // shell 경유로 폴백한다.
  const filterArgs = ["--filter", "@dotobokuri/fleet-console", "build"];
  const packageManagerCli = process.env.npm_execpath;
  if (packageManagerCli) {
    await execFileAsync(process.execPath, [packageManagerCli, ...filterArgs], { cwd: workspaceDirectory });
    return;
  }
  await execFileAsync("pnpm", filterArgs, { cwd: workspaceDirectory, shell: true });
}

async function copyRequiredConsoleFiles() {
  await cp(join(consoleDirectory, "dist", "cli.mjs"), join(serviceDirectory, "dist", "cli.mjs"));
  await cp(join(consoleDirectory, "dist", "client"), join(serviceDirectory, "dist", "client"), { recursive: true });
  await cp(join(consoleDirectory, "dist", "fleet-plugins"), join(serviceDirectory, "dist", "fleet-plugins"), { recursive: true });
  await cp(join(desktopDirectory, "build", "icon.png"), join(serviceDirectory, "icon.png"));
  await writeFile(join(serviceDirectory, ".fleet-console-resource-root"), "1\n");
}

async function copyRuntimeDependency(name) {
  await cp(resolveConsolePackageDirectory(name), join(serviceDirectory, "node_modules", name), { dereference: true, recursive: true });
}

function resolveConsolePackageDirectory(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`, { paths: [consoleDirectory] }));
  } catch {
    // font-list처럼 package.json을 exports로 노출하지 않는 패키지는 node_modules 경로로 직접 해석한다.
    const direct = join(consoleDirectory, "node_modules", name);
    if (!existsSync(direct)) throw new Error(`Cannot resolve runtime dependency ${name} from ${consoleDirectory}`);
    return direct;
  }
}

async function pruneNodePtyNativeHelpers() {
  const nodePtyDirectory = join(serviceDirectory, "node_modules", "node-pty");
  // node-pty는 build/Release를 prebuilds보다 먼저 로드한다(lib/utils.js). build/는 호스트에서
  // 컴파일된 산출물이라 크로스빌드(예: arm64 호스트→win32-x64)에서 arch가 어긋난다. 제거해서
  // 배포용 arch별 prebuilds가 사용되게 한다(네이티브 빌드도 prebuilds로 동일하게 동작).
  const nodePtyBuildDirectory = join(nodePtyDirectory, "build");
  if (existsSync(nodePtyBuildDirectory)) await rm(nodePtyBuildDirectory, { force: true, recursive: true });
  const prebuildsDirectory = join(nodePtyDirectory, "prebuilds");
  const expectedPrebuild = runtimeTarget;
  for (const entry of await readdir(prebuildsDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== expectedPrebuild) await rm(join(prebuildsDirectory, entry.name), { force: true, recursive: true });
  }
  const conPtyDirectory = join(nodePtyDirectory, "third_party", "conpty");
  if (!existsSync(conPtyDirectory)) return;
  if (process.platform !== "win32") {
    await rm(conPtyDirectory, { force: true, recursive: true });
    return;
  }
  for (const version of await readdir(conPtyDirectory, { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    const versionDirectory = join(conPtyDirectory, version.name);
    for (const entry of await readdir(versionDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== `win10-${runtimeArch}`) await rm(join(versionDirectory, entry.name), { force: true, recursive: true });
    }
  }
}

async function copyEsbuildRuntime() {
  const packageJson = require.resolve("esbuild/package.json", { paths: [consoleDirectory] });
  const packageDirectory = dirname(packageJson);
  const packageManifest = JSON.parse(await readFile(packageJson, "utf8"));
  const platformPackage = Object.keys(packageManifest.optionalDependencies ?? {}).find((name) => name === `@esbuild/${runtimeTarget}`);
  if (!platformPackage) throw new Error(`No esbuild runtime package for ${runtimeTarget}`);
  await cp(packageDirectory, join(serviceDirectory, "node_modules", "esbuild"), { dereference: true, recursive: true });
  // @esbuild/<platform>은 esbuild의 optional 의존성이라, pnpm isolated 레이아웃에서는 consoleDirectory가
  // 아니라 esbuild 패키지 디렉터리 기준으로만 해석된다(모든 OS에서 더 정확).
  const platformPackageJson = require.resolve(`${platformPackage}/package.json`, { paths: [packageDirectory, consoleDirectory] });
  await cp(dirname(platformPackageJson), join(serviceDirectory, "node_modules", "@esbuild", basename(platformPackage)), { dereference: true, recursive: true });
}

async function writeSanitizedPackageManifest() {
  const sourceManifest = JSON.parse(await readFile(join(consoleDirectory, "package.json"), "utf8"));
  const stagedManifest = {
    name: sourceManifest.name,
    private: true,
    type: "module",
    version: sourceManifest.version,
    main: "dist/cli.mjs",
    dependencies: {
      "node-pty": sourceManifest.dependencies["node-pty"],
      ws: sourceManifest.dependencies.ws,
      "font-list": sourceManifest.dependencies["font-list"],
      esbuild: sourceManifest.devDependencies.esbuild,
      "@fleet-console/sdk": sourceManifest.version,
    },
  };
  const serialized = JSON.stringify(stagedManifest, null, 2).concat("\n");
  if (serialized.includes("workspace:*")) throw new Error("Staged Console manifest contains workspace:* dependency");
  await writeFile(join(serviceDirectory, "package.json"), serialized);
}

async function writeLicenseInventory() {
  const packages = ["node-pty", "ws", "font-list", "esbuild", "@esbuild", "@fleet-console/sdk"];
  const entries = [];
  for (const packageName of packages) {
    entries.push(...await collectLicenseFiles(join(serviceDirectory, "node_modules", packageName)));
  }
  await writeFile(join(serviceDirectory, "LICENSES.json"), JSON.stringify(entries.sort(), null, 2).concat("\n"));
}

async function writeTargetManifest() {
  await writeFile(join(stageDirectory, "target.json"), JSON.stringify({ target: runtimeTarget }, null, 2).concat("\n"));
}

async function collectLicenseFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const licenses = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      licenses.push(...await collectLicenseFiles(filePath));
    } else if (/^(license|copying|notice)(\.|$)/i.test(entry.name)) {
      licenses.push(relative(serviceDirectory, filePath));
    }
  }
  return licenses;
}

async function writeDigestManifest() {
  const files = await collectFiles(stageDirectory);
  const manifest = [];
  for (const file of files) {
    const metadata = await stat(file);
    manifest.push({
      mode: `0${(metadata.mode & 0o777).toString(8)}`,
      path: relative(stageDirectory, file),
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    });
  }
  await writeFile(join(stageDirectory, "manifest.json"), JSON.stringify(manifest.sort((left, right) => left.path.localeCompare(right.path)), null, 2).concat("\n"));
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(filePath));
    else if ((await lstat(filePath)).isFile()) files.push(filePath);
  }
  return files;
}

async function preserveExecutableModes() {
  const nodeExecutable = process.platform === "win32" ? join(nodeDirectory, "node.exe") : join(nodeDirectory, "bin", "node");
  if (process.platform !== "win32") await chmod(nodeExecutable, 0o755);
}

function excludeNodeModules(source) {
  return !source.includes(`${join(sdkDirectory, "node_modules")}`);
}
