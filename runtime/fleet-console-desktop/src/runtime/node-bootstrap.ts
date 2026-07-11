import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export interface NodeRuntimeTarget {
  readonly archive: string;
  readonly sha256: string;
}

export interface NodeRuntimeManifest {
  readonly version: string;
  readonly source: string;
  readonly targets: Readonly<Record<string, NodeRuntimeTarget>>;
}

export interface NodeBootstrapFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface NodeBootstrapDependencies {
  readonly download: (url: string, destination: string) => Promise<void>;
  readonly extract: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
  readonly fileSystem: NodeBootstrapFileSystem;
  readonly hash?: (content: Uint8Array) => string;
}

export interface NodeBootstrapResult {
  readonly nodePath: string;
  readonly version: string;
}

export interface BootstrapNodeRuntimeOptions {
  readonly destination: string;
  readonly manifest: NodeRuntimeManifest;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly dependencies?: NodeBootstrapDependencies;
}

export async function bootstrapNodeRuntime(options: BootstrapNodeRuntimeOptions): Promise<NodeBootstrapResult> {
  const dependencies = options.dependencies ?? createNodeBootstrapDependencies();
  const targetKey = `${options.platform}-${options.architecture}`;
  const target = options.manifest.targets[targetKey];
  if (!target) throw new Error(`node_runtime_target_unsupported: ${targetKey}`);
  const staging = `${options.destination}.staging`;
  const archive = path.join(staging, target.archive);
  try {
    await dependencies.fileSystem.rm(staging);
    await dependencies.fileSystem.mkdir(staging);
    await dependencies.download(`${options.manifest.source}/${target.archive}`, archive);
    const downloaded = await dependencies.fileSystem.readFile(archive);
    const digest = (dependencies.hash ?? sha256)(downloaded);
    if (digest !== target.sha256) throw new Error("node_runtime_checksum_mismatch");
    await dependencies.extract(archive, staging, options.platform);
    await dependencies.fileSystem.rm(archive);
    await dependencies.fileSystem.writeFile(path.join(staging, ".runtime-version"), `${options.manifest.version}\n`);
    await dependencies.fileSystem.rm(options.destination);
    await dependencies.fileSystem.rename(staging, options.destination);
    return { nodePath: path.join(options.destination, options.platform === "win32" ? "node.exe" : "bin/node"), version: options.manifest.version };
  } catch (error) {
    await dependencies.fileSystem.rm(staging);
    throw error;
  }
}

export function createNodeBootstrapDependencies(): NodeBootstrapDependencies {
  return {
    download: download,
    extract: extract,
    fileSystem: { mkdir: async (target) => { await mkdir(target, { recursive: true }); }, readFile, rename, rm: async (target) => { await rm(target, { force: true, recursive: true }); }, writeFile: async (target, content) => { await writeFile(target, content); } },
  };
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`node_runtime_download_failed: ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function extract(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const execute = promisify(execFile);
  if (archive.endsWith(".zip")) {
    if (platform === "win32") await execute("powershell", ["-NoProfile", "-NonInteractive", "-Command", `\$extract = Join-Path '${destination}' 'extract'; Expand-Archive -LiteralPath '${archive}' -DestinationPath \$extract -Force; \$runtime = Get-ChildItem -LiteralPath \$extract -Directory | Select-Object -First 1; Move-Item -Path (Join-Path \$runtime.FullName '*') -Destination '${destination}' -Force; Remove-Item -LiteralPath \$extract -Recurse -Force`]);
    else await execute("unzip", ["-q", archive, "-d", destination]);
    return;
  }
  await execute("tar", ["-xf", archive, "-C", destination, "--strip-components=1"]);
}
