import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertWithinRoot,
  ensureSafeDirectory,
  safeLstat,
  withDirectoryLock,
  writeAtomicSync,
} from "../fs-store/index.js";
export interface WorkspaceDirectory {
  readonly cwd: string;
  readonly identityPath: string;
  readonly name: string;
  readonly path: string;
  readonly root: string;
}

export interface WorkspaceDirectoryIdentity {
  readonly cwd: string;
}

const WORKSPACES_DIRECTORY_NAME = "workspaces";
const WORKSPACE_IDENTITY_FILE_NAME = "cwd.json";
const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export function toWorkspaceDirectoryName(canonicalCwd: string): string {
  if (!canonicalCwd) {
    throw new Error("Workspace cwd is required");
  }
  return canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function getWorkspaceDirectoryRoot(dataDir: string): string {
  if (!dataDir.trim()) {
    throw new Error("Fleet data directory is required");
  }
  return path.join(path.resolve(dataDir), WORKSPACES_DIRECTORY_NAME);
}

export function resolveWorkspaceDirectory(dataDir: string, cwd: string): WorkspaceDirectory {
  const canonicalCwd = canonicalizeWorkspaceCwd(cwd);
  return buildWorkspaceDirectory(dataDir, toWorkspaceDirectoryName(canonicalCwd), canonicalCwd);
}

export function ensureWorkspaceDirectory(dataDir: string, cwd: string): WorkspaceDirectory {
  const workspace = resolveWorkspaceDirectory(dataDir, cwd);
  const resolvedDataDir = path.resolve(dataDir);
  ensureSafeDirectory(resolvedDataDir);
  ensureSafeDirectory(workspace.root);
  assertWithinRoot(workspace.root, workspace.path);

  withDirectoryLock({ lockDir: `${workspace.path}.lock` }, () => {
    ensureSafeDirectory(workspace.path);
    const existing = readWorkspaceIdentity(workspace.identityPath);
    if (existing && existing.cwd !== workspace.cwd) {
      throw new Error(
        `Workspace directory identity collision for ${workspace.name}: expected ${workspace.cwd}, found ${existing.cwd}`,
      );
    }
    if (!existing) {
      writeAtomicSync(
        workspace.identityPath,
        `${JSON.stringify({ cwd: workspace.cwd } satisfies WorkspaceDirectoryIdentity, null, 2)}\n`,
      );
    }
  });

  return workspace;
}

export function findWorkspaceDirectory(dataDir: string, cwd: string): WorkspaceDirectory | null {
  const expected = resolveWorkspaceDirectory(dataDir, cwd);
  assertSafeWorkspaceRoot(dataDir, expected.root, true);
  const workspaceStat = safeLstat(expected.path);
  if (!workspaceStat) return null;
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error(`Workspace directory not found or unsafe: ${expected.name}`);
  }
  const existing = readExistingWorkspaceDirectory(expected.root, expected.name, expected.path);
  if (existing.cwd !== expected.cwd) {
    throw new Error(
      `Workspace directory identity collision for ${expected.name}: expected ${expected.cwd}, found ${existing.cwd}`,
    );
  }
  return existing;
}

export function resolveWorkspaceDirectoryByName(dataDir: string, name: string): WorkspaceDirectory {
  assertWorkspaceDirectoryName(name);
  const root = getWorkspaceDirectoryRoot(dataDir);
  assertSafeWorkspaceRoot(dataDir, root, false);
  const workspacePath = path.join(root, name);
  assertWithinRoot(root, workspacePath);

  const workspaceStat = safeLstat(workspacePath);
  if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error(`Workspace directory not found or unsafe: ${name}`);
  }
  return readExistingWorkspaceDirectory(root, name, workspacePath);
}

function readExistingWorkspaceDirectory(root: string, name: string, workspacePath: string): WorkspaceDirectory {
  const identityPath = path.join(workspacePath, WORKSPACE_IDENTITY_FILE_NAME);
  const identity = readWorkspaceIdentity(identityPath);
  if (!identity) {
    throw new Error(`Workspace directory identity is missing: ${name}`);
  }
  if (toWorkspaceDirectoryName(identity.cwd) !== name) {
    throw new Error(`Workspace directory identity does not match its name: ${name}`);
  }

  return {
    cwd: identity.cwd,
    identityPath,
    name,
    path: workspacePath,
    root,
  };
}

function assertSafeWorkspaceRoot(dataDir: string, root: string, allowMissing: boolean): void {
  const resolvedDataDir = path.resolve(dataDir);
  const dataDirStat = safeLstat(resolvedDataDir);
  if (!dataDirStat) {
    if (allowMissing) return;
    throw new Error(`Workspace data directory not found or unsafe: ${resolvedDataDir}`);
  }
  if (!dataDirStat.isDirectory() || dataDirStat.isSymbolicLink()) {
    throw new Error(`Workspace data directory not found or unsafe: ${resolvedDataDir}`);
  }
  const rootStat = safeLstat(root);
  if (!rootStat) {
    if (allowMissing) return;
    throw new Error(`Workspace directory root not found or unsafe: ${root}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Workspace directory root not found or unsafe: ${root}`);
  }
}

function buildWorkspaceDirectory(dataDir: string, name: string, cwd: string): WorkspaceDirectory {
  assertWorkspaceDirectoryName(name);
  const root = getWorkspaceDirectoryRoot(dataDir);
  const workspacePath = path.join(root, name);
  assertWithinRoot(root, workspacePath);
  return {
    cwd,
    identityPath: path.join(workspacePath, WORKSPACE_IDENTITY_FILE_NAME),
    name,
    path: workspacePath,
    root,
  };
}

function canonicalizeWorkspaceCwd(cwd: string): string {
  if (!cwd.trim()) {
    throw new Error("Workspace cwd is required");
  }
  return fs.realpathSync.native(path.resolve(cwd));
}

function assertWorkspaceDirectoryName(name: string): void {
  if (!name || !WORKSPACE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid workspace directory name: ${name}`);
  }
}

function readWorkspaceIdentity(identityPath: string): WorkspaceDirectoryIdentity | null {
  const stat = safeLstat(identityPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe workspace identity file: ${identityPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid workspace identity file: ${identityPath}`, { cause: error });
  }
  if (!isWorkspaceDirectoryIdentity(parsed)) {
    throw new Error(`Invalid workspace identity payload: ${identityPath}`);
  }
  return parsed;
}

function isWorkspaceDirectoryIdentity(value: unknown): value is WorkspaceDirectoryIdentity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.cwd === "string" && record.cwd.length > 0;
}

/**
 * 워크스페이스 디렉터리가 예전 자리에 남아 있으면 새 자리로 한 번 옮긴다.
 *
 * 승계 판정기(`createStoreCarryOver`)가 다루는 것은 JSON 파일 하나지만 이쪽은 프로젝트별
 * 지식이 쌓인 디렉터리 트리라, 값을 읽어 합치는 대신 통째로 옮긴다. 새 자리에 이미 디렉터리가
 * 있으면 그쪽이 사실이므로 손대지 않는다 — 두 자리를 합치려 들면 같은 프로젝트의 지식이
 * 어느 쪽 것인지 판정할 근거가 없다.
 *
 * best-effort다. 옮기지 못해도 옛 자리는 그대로 남으므로 잃는 것은 없고, 새 자리는 빈 채로
 * 시작한다. 파일시스템이 다르면(local 채널 슬롯이 다른 볼륨인 경우) rename이 EXDEV로 실패하는데,
 * 그때 반쯤 복사된 트리를 남기느니 옮기지 않는 편이 낫다.
 */
export function adoptLegacyWorkspaces(legacyDataDir: string, dataDir: string): void {
  try {
    const source = getWorkspaceDirectoryRoot(legacyDataDir);
    const destination = getWorkspaceDirectoryRoot(dataDir);
    if (source === destination) return;
    if (safeLstat(destination) || !safeLstat(source)?.isDirectory()) return;
    ensureSafeDirectory(path.resolve(dataDir));
    fs.renameSync(source, destination);
  } catch {
    // 옮기지 못한 것은 결론이 아니다. 옛 자리가 그대로 남아 다음 기동이 다시 시도한다.
  }
}
