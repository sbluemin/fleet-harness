import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSOLE_PACKAGE_NAME,
  CONSOLE_RELEASE_CHECKSUMS_ASSET,
  CONSOLE_RELEASE_MANIFEST_ASSET,
  CONSOLE_RELEASE_SCHEMA_VERSION,
  CONSOLE_RELEASE_TARBALL_ALIAS,
  consoleReleaseTagForVersion,
  consoleTarballName,
  isExperimentConsoleVersion,
  isStableConsoleVersion,
  parseConsoleReleaseManifest,
} from "../runtime/fleet-console/protocol/release/index.ts";

// GitHub Release에 올릴 Console 자산을 만든다. stable 릴리스(stable-release.yml의 console-assets)와
// 지휘관이 로컬에서 게시하는 실험 prerelease가 같은 경로를 쓴다 — 두 경로의 자산이 갈라지면
// 실험 e2e가 stable을 입증하지 못한다.
//
//   node scripts/pack-fleet-console-release.mjs --out <dir> [--version <semver>] [--smoke] [--skip-build]
//
// --skip-build는 방금 `pnpm install`의 postinstall이 같은 트리를 빌드한 CI에서만 쓴다.
// --version을 생략하면 package.json의 버전을 쓴다. 트리와 다른 버전은 실험 prerelease(X.Y.Z-exp.N)로만
// 허용한다 — stable 번호를 트리가 선언하지 않은 내용에 붙이지 않기 위해서다.
//
// 자산 이름·태그 규칙·manifest 스키마는 업데이터와 같은 @fleet-console/protocol/release를 읽는다
// (import가 없는 순수 TS라 Node 22 type stripping으로 바로 불러온다). 생성한 manifest도 그 parser에
// 다시 넣어 확인하므로, 생성기와 소비자가 어긋나면 게시 전에 여기서 멈춘다.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PKG_DIR = path.join(REPO_ROOT, "runtime/fleet-console");
const PKG_PATH = path.join(PKG_DIR, "package.json");

main(parseArgs(process.argv.slice(2)));

function parseArgs(argv) {
  const options = { out: undefined, version: undefined, smoke: false, skipBuild: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++index];
    if (flag === "--out") options.out = value();
    else if (flag === "--version") options.version = value();
    else if (flag === "--smoke") options.smoke = true;
    else if (flag === "--skip-build") options.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}\nUsage: pack-fleet-console-release.mjs --out <dir> [--version <semver>] [--smoke] [--skip-build]`);
  }
  if (!options.out) throw new Error("--out <dir> is required");
  return options;
}

function main(options) {
  const original = readFileSync(PKG_PATH, "utf8");
  const pkg = JSON.parse(original);
  const version = options.version ?? pkg.version;
  const tag = consoleReleaseTagForVersion(version);
  if (tag === null) throw new Error(`Unsupported Console release version: ${version} (expected X.Y.Z or X.Y.Z-exp.N)`);
  if (pkg.name !== CONSOLE_PACKAGE_NAME) throw new Error(`${PKG_PATH} names ${pkg.name}, not ${CONSOLE_PACKAGE_NAME}`);
  if (version !== pkg.version && !isExperimentConsoleVersion(version)) {
    throw new Error(`Version ${version} differs from ${pkg.name}@${pkg.version}; only an experimental X.Y.Z-exp.N may override the tree version.`);
  }

  const outDir = path.resolve(options.out);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty; use a fresh directory so no stale asset is uploaded.`);
  }
  mkdirSync(outDir, { recursive: true });

  if (!options.skipBuild) execFileSync("pnpm", ["build"], { cwd: PKG_DIR, stdio: "inherit" });

  const packDir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-pack-"));
  let packed;
  try {
    // npm pack이 prepack/postpack으로 게시용 manifest를 만들고 되돌린다. 버전만 여기서 잠시 바꾼다.
    if (version !== pkg.version) writeFileSync(PKG_PATH, original.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
    const [result] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: PKG_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: withoutNpmConfig(process.env) }));
    packed = path.join(packDir, result.filename);
  } finally {
    writeFileSync(PKG_PATH, original);
  }

  const tarballName = consoleTarballName(version);
  const tarballPath = path.join(outDir, tarballName);
  renameOrCopy(packed, tarballPath);
  rmSync(packDir, { recursive: true, force: true });
  assertPackedManifest(tarballPath, CONSOLE_PACKAGE_NAME, version);
  copyFileSync(tarballPath, path.join(outDir, CONSOLE_RELEASE_TARBALL_ALIAS));

  const tarball = { name: tarballName, size: statSync(tarballPath).size, sha256: sha256(tarballPath) };
  const manifest = { schema: CONSOLE_RELEASE_SCHEMA_VERSION, package: CONSOLE_PACKAGE_NAME, version, tag, tarball, engines: { node: pkg.engines.node } };
  const parsed = parseConsoleReleaseManifest(manifest, isStableConsoleVersion(version) ? {} : { tag });
  if (!parsed.ok) throw new Error(`Generated manifest is rejected by the release contract: ${parsed.reason}`);
  writeFileSync(path.join(outDir, CONSOLE_RELEASE_MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);
  // GNU coreutils 형식(`<hex>␠␠<name>`)이라 `shasum -a 256 -c`와 `sha256sum -c`가 그대로 읽는다.
  const sums = [tarballName, CONSOLE_RELEASE_TARBALL_ALIAS, CONSOLE_RELEASE_MANIFEST_ASSET].map((name) => `${sha256(path.join(outDir, name))}  ${name}`);
  writeFileSync(path.join(outDir, CONSOLE_RELEASE_CHECKSUMS_ASSET), `${sums.join("\n")}\n`);

  if (options.smoke) smokeInstall(tarballPath, version);

  console.log(`Console release assets for ${tag} in ${outDir}:`);
  for (const name of readdirSync(outDir).sort()) console.log(`  ${name}`);
}

// 게시용 manifest가 실제로 tarball에 들어갔는지 확인한다. private이 남으면 설치본이 local 채널로
// 판정되고, 버전이 어긋나면 manifest가 다른 내용을 가리킨다.
function assertPackedManifest(tarballPath, name, version) {
  const packed = JSON.parse(execFileSync("tar", ["-xzOf", tarballPath, "package/package.json"], { encoding: "utf8" }));
  const problems = [];
  if (packed.name !== name) problems.push(`name=${packed.name}`);
  if (packed.version !== version) problems.push(`version=${packed.version}`);
  if (packed.private) problems.push("private=true");
  if (Object.values(packed.dependencies ?? {}).some((range) => String(range).startsWith("workspace:"))) problems.push("workspace: dependency");
  if (problems.length > 0) throw new Error(`Packed manifest is not publishable (${problems.join(", ")})`);
}

// 격리 prefix에 전역 설치해 설치된 fleet이 이 버전을 게시본(stable, 실험판은 experiment)으로 보고하는지 본다. 의존성은 npm
// 레지스트리에서 풀리므로 external 목록이 설치 가능한지도 함께 확인된다.
function smokeInstall(tarballPath, version) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "fleet-console-smoke-"));
  try {
    const prefix = path.join(sandbox, "prefix");
    const env = {
      ...withoutNpmConfig(process.env),
      FLEET_CONSOLE_NO_AUTO_START: "1",
      FLEET_DATA_DIR: path.join(sandbox, "data"),
      FLEET_CONSOLE_DATA_DIR: path.join(sandbox, "data", "console"),
    };
    execFileSync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarballPath], { stdio: "inherit", env });
    const bin = process.platform === "win32" ? path.join(prefix, "fleet.cmd") : path.join(prefix, "bin", "fleet");
    const reported = execFileSync(bin, ["--version"], { encoding: "utf8", env, shell: process.platform === "win32" }).split("\n")[0].trim();
    const expected = `${CONSOLE_PACKAGE_NAME} ${version} (${isExperimentConsoleVersion(version) ? "experiment" : "stable"})`;
    if (reported !== expected) throw new Error(`Smoke install reported "${reported}", expected "${expected}"`);
    console.log(`Smoke install OK: ${reported}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// pnpm이나 npm 스크립트 아래에서 실행되면 npm_config_*가 새어 들어와 pack·설치의 대상과 prefix를 바꾼다.
function withoutNpmConfig(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
}

function renameOrCopy(from, to) {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
