import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export interface NodeRuntimeTarget { readonly archive: string; readonly sha256: string; }
export interface NodeRuntimeManifest { readonly version: string; readonly source: string; readonly targets: Readonly<Record<string, NodeRuntimeTarget>>; }

export interface NodeBootstrapFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface NodeBootstrapDependencies {
  readonly download: (url: string, destination: string) => Promise<void>;
  readonly extract: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
  readonly fileSystem: NodeBootstrapFileSystem;
  readonly hash?: (content: Uint8Array) => string;
}

export interface NodeBootstrapResult { readonly nodePath: string; readonly version: string; }
export interface BootstrapNodeRuntimeOptions { readonly destination: string; readonly manifest: NodeRuntimeManifest; readonly platform: NodeJS.Platform; readonly architecture: string; readonly dependencies?: NodeBootstrapDependencies; }

export async function bootstrapNodeRuntime(options: BootstrapNodeRuntimeOptions): Promise<NodeBootstrapResult> {
  const dependencies = options.dependencies ?? createNodeBootstrapDependencies();
  const targetKey = `${options.platform}-${options.architecture}`;
  const target = options.manifest.targets[targetKey];
  if (!target) throw new Error(`node_runtime_target_unsupported: ${targetKey}`);
  const staging = `${options.destination}.staging`;
  try {
    await dependencies.fileSystem.rm(staging);
    await dependencies.fileSystem.mkdir(staging);
    const archive = path.join(staging, target.archive);
    await dependencies.download(`${options.manifest.source}/${target.archive}`, archive);
    const downloaded = await dependencies.fileSystem.readFile(archive);
    const digest = (dependencies.hash ?? sha256)(downloaded);
    if (digest !== target.sha256) throw new Error("node_runtime_checksum_mismatch");
    await dependencies.extract(archive, staging, options.platform);
    await dependencies.fileSystem.rm(archive);
    await dependencies.fileSystem.writeFile(path.join(staging, ".runtime-version"), `${options.manifest.version}\n`);
    await replaceNodeRuntime(options.destination, staging, dependencies.fileSystem);
    return { nodePath: nodeBinaryPath(options.destination, options.platform), version: options.manifest.version };
  } catch (error) {
    await dependencies.fileSystem.rm(staging);
    throw error;
  }
}

export async function isManagedNodeRuntimeValid(destination: string, manifest: NodeRuntimeManifest, platform: NodeJS.Platform, fileSystem: Pick<NodeBootstrapFileSystem, "readFile" | "stat"> = createNodeBootstrapDependencies().fileSystem): Promise<boolean> {
  try {
    const version = new TextDecoder().decode(await fileSystem.readFile(path.join(destination, ".runtime-version"))).trim();
    await fileSystem.stat(nodeBinaryPath(destination, platform));
    return version === manifest.version;
  } catch {
    return false;
  }
}

export async function reconcileNodeRuntime(destination: string, fileSystem: Pick<NodeBootstrapFileSystem, "rm" | "rename" | "stat"> = createNodeBootstrapDependencies().fileSystem): Promise<void> {
  const backup = `${destination}.rollback`;
  const hasNode = await pathExists(destination, fileSystem);
  const hasBackup = await pathExists(backup, fileSystem);
  // 중단된 트랜잭션 복구: node가 없고 rollback만 있으면(교체 중 종료) 다운로드 시도 전에 rollback을 복원한다.
  // 그래야 오프라인에서도 유효한 이전 런타임으로 부팅할 수 있다(console latest.rollback과 대칭).
  if (!hasNode && hasBackup) {
    await fileSystem.rename(backup, destination);
    return;
  }
  // 유효한 node가 있으면 고아 rollback을 best-effort로 정리한다(정리 실패는 다음 시작으로 미룬다).
  if (hasBackup) {
    try {
      await fileSystem.rm(backup);
    } catch {
      // transaction-only rollback 정리는 다음 시작으로 미룬다.
    }
  }
}

export function satisfiesNodeEngine(version: string, engine: string | null): boolean {
  if (!engine) return true;
  const minimum = engine.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  const current = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!minimum || !current) return false;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(current[index]);
    const right = Number(minimum[index]);
    if (left !== right) return left > right;
  }
  return true;
}

export function createPowerShellExtractionCommand(archive: string, destination: string): string {
  const escapedArchive = escapePowerShellLiteral(archive);
  const escapedDestination = escapePowerShellLiteral(destination);
  return `\$extract = Join-Path '${escapedDestination}' 'extract'; Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath \$extract -Force; \$runtime = Get-ChildItem -LiteralPath \$extract -Directory | Select-Object -First 1; Move-Item -Path (Join-Path \$runtime.FullName '*') -Destination '${escapedDestination}' -Force; Remove-Item -LiteralPath \$extract -Recurse -Force`;
}

export function createNodeBootstrapDependencies(): NodeBootstrapDependencies {
  return {
    download,
    extract,
    fileSystem: { mkdir: async (target) => { await mkdir(target, { recursive: true }); }, readFile, rename, rm: async (target) => { await rm(target, { force: true, recursive: true }); }, stat: async (target) => { await stat(target); }, writeFile: async (target, content) => { await writeFile(target, content); } },
  };
}

async function replaceNodeRuntime(destination: string, staging: string, fileSystem: NodeBootstrapFileSystem): Promise<void> {
  const backup = `${destination}.rollback`;
  let movedCurrent = false;
  try {
    if (await pathExists(destination, fileSystem)) {
      await fileSystem.rm(backup);
      await fileSystem.rename(destination, backup);
      movedCurrent = true;
    } else if (await pathExists(backup, fileSystem)) {
      await fileSystem.rename(backup, destination);
      await fileSystem.rename(destination, backup);
      movedCurrent = true;
    }
    await fileSystem.rename(staging, destination);
  } catch (error) {
    if (movedCurrent && !await pathExists(destination, fileSystem)) {
      try { await fileSystem.rename(backup, destination); } catch { /* 기존 런타임 복구 실패는 원인 오류로 보고한다. */ }
    }
    throw error;
  }
  if (movedCurrent) {
    try { await fileSystem.rm(backup); } catch { /* 다음 갱신에서 고아 rollback을 정리한다. */ }
  }
}

function sha256(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function nodeBinaryPath(root: string, platform: NodeJS.Platform): string { return path.join(root, platform === "win32" ? "node.exe" : "bin/node"); }

async function pathExists(target: string, fileSystem: Pick<NodeBootstrapFileSystem, "stat">): Promise<boolean> {
  try { await fileSystem.stat(target); return true; } catch { return false; }
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`node_runtime_download_failed: ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function extract(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const execute = promisify(execFile);
  if (archive.endsWith(".zip")) {
    if (platform === "win32") await execute("powershell", ["-NoProfile", "-NonInteractive", "-Command", createPowerShellExtractionCommand(archive, destination)]);
    else await execute("unzip", ["-q", archive, "-d", destination]);
    return;
  }
  await execute("tar", ["-xf", archive, "-C", destination, "--strip-components=1"]);
}

function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
