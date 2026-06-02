import * as fs from "node:fs";
import * as path from "node:path";

import { assertDirectoryIdentity, assertWithinRoot, readDirectoryIdentity, type DirectoryIdentity } from "@dotobokuri/fleet-infra/fs-store";

import type { CodexSubagentRoleDefinition, CodexSubagentToml } from "../subagents/types.js";
import { getCarriersFilePath, withStoreLock } from "./state-io.js";

export interface CodexSubagentRoleFile {
  readonly configFile: string;
  readonly definition: CodexSubagentRoleDefinition;
  readonly instructionsFile: string;
}

const CODEX_AGENTS_DIR_NAME = "codex-agents";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_WRITE_MAX_ATTEMPTS = 10;
const TOML_BASIC_STRING_ESCAPE_PATTERN = /[\u0000-\u001f"\\\u007f]/g;

export function ensureCodexSubagentRoleFile(
  definition: CodexSubagentRoleDefinition,
): CodexSubagentRoleFile | undefined {
  const configFile = getCodexSubagentRoleFilePath(definition.roleKey);
  const instructionsFile = getCodexSubagentInstructionsFilePath(definition.roleKey);
  if (!configFile || !instructionsFile) return undefined;
  withStoreLock(() => {
    const rootDir = getCodexSubagentRootDir();
    if (!rootDir) return;
    const rootIdentity = ensureCodexSubagentRootDir(rootDir);
    chmodBestEffort(rootDir, DIRECTORY_MODE);
    writeTextFileAtomic(instructionsFile, definition.instructions, rootDir, rootIdentity);
    writeTextFileAtomic(configFile, serializeCodexSubagentRoleToml({
      ...definition.toml,
      model_instructions_file: instructionsFile,
    }), rootDir, rootIdentity);
    fsyncDirectoryBestEffort(rootDir);
  });
  return { definition, configFile, instructionsFile };
}

export function removeCodexSubagentRoleFile(roleKey: string): void {
  const configFile = getCodexSubagentRoleFilePath(roleKey);
  const instructionsFile = getCodexSubagentInstructionsFilePath(roleKey);
  if (!configFile || !instructionsFile) return;
  withStoreLock(() => {
    const rootDir = getCodexSubagentRootDir();
    const rootIdentity = rootDir ? readDirectoryIdentity(rootDir) : null;
    if (!rootDir || !rootIdentity) return;
    try {
      assertCodexSubagentRootIdentity(rootDir, rootIdentity);
      removeFileIfPresent(configFile);
      removeFileIfPresent(instructionsFile);
      assertCodexSubagentRootIdentity(rootDir, rootIdentity);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      assertCodexSubagentRootIdentity(rootDir, rootIdentity);
    }
  });
}

export function getCodexSubagentRoleFilePath(roleKey: string): string | undefined {
  const rootDir = getCodexSubagentRootDir();
  return rootDir ? resolveConfinedCodexSubagentPath(rootDir, `${roleKey}.toml`) : undefined;
}

export function getCodexSubagentInstructionsFilePath(roleKey: string): string | undefined {
  const rootDir = getCodexSubagentRootDir();
  return rootDir ? resolveConfinedCodexSubagentPath(rootDir, `${roleKey}.md`) : undefined;
}

export function serializeCodexSubagentRoleToml(toml: CodexSubagentToml): string {
  const lines = [
    `name = "${escapeTomlBasicString(toml.name)}"`,
    `description = "${escapeTomlBasicString(toml.description)}"`,
    ...(toml.model ? [`model = "${escapeTomlBasicString(toml.model)}"`] : []),
    ...(toml.model_reasoning_effort ? [`model_reasoning_effort = "${escapeTomlBasicString(toml.model_reasoning_effort)}"`] : []),
    ...(toml.model_instructions_file ? [`model_instructions_file = "${escapeTomlBasicString(toml.model_instructions_file)}"`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

function getCodexSubagentRootDir(): string | undefined {
  const statesFilePath = getCarriersFilePath();
  return statesFilePath ? path.join(path.dirname(statesFilePath), CODEX_AGENTS_DIR_NAME) : undefined;
}

function ensureCodexSubagentRootDir(rootDir: string): DirectoryIdentity {
  assertCodexSubagentRootIsNotSymlink(rootDir);
  fs.mkdirSync(rootDir, { recursive: true, mode: DIRECTORY_MODE });
  return readRequiredCodexSubagentRootIdentity(rootDir);
}

// [MEDIUM #7] fs-store DirectoryIdentity/readDirectoryIdentity/assertDirectoryIdentity 위임
// writeTextFileAtomic 로컬 구현은 유지 (테스트 mock hook 호환·identity 인터리빙 정당)

function readRequiredCodexSubagentRootIdentity(rootDir: string): DirectoryIdentity {
  const identity = readDirectoryIdentity(rootDir);
  if (!identity) throw new Error(`Codex subagent root is missing: ${rootDir}`);
  return identity;
}

function assertCodexSubagentRootIsNotSymlink(rootDir: string): void {
  try {
    const stats = fs.lstatSync(rootDir);
    if (stats.isSymbolicLink()) {
      throw new Error(`Codex subagent root must not be a symlink: ${rootDir}`);
    }
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function assertCodexSubagentRootIdentity(rootDir: string, expected: DirectoryIdentity): void {
  // assertDirectoryIdentity 위임 — 불일치시 "Directory identity changed" throw
  // 기존 "changed during role file operation" 메시지 대신 fs-store 표준 메시지 사용
  assertDirectoryIdentity(rootDir, expected);
}

function writeTextFileAtomic(
  filePath: string,
  contents: string,
  rootDir: string,
  rootIdentity: DirectoryIdentity,
): void {
  let lastExistsError: unknown;
  for (let attempt = 0; attempt < TEMP_WRITE_MAX_ATTEMPTS; attempt++) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let tempCreated = false;
    try {
      assertCodexSubagentRootIdentity(rootDir, rootIdentity);
      // path 기반 writeFileSync + flag:"wx" (O_EXCL 의미, 테스트 mock hook 호환)
      fs.writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: FILE_MODE });
      tempCreated = true;
      chmodBestEffort(tempPath, FILE_MODE);
      fsyncFileBestEffort(tempPath);
      assertCodexSubagentRootIdentity(rootDir, rootIdentity);
      fs.renameSync(tempPath, filePath);
      chmodBestEffort(filePath, FILE_MODE);
      return;
    } catch (error) {
      if (!tempCreated && isFileExistsError(error)) {
        lastExistsError = error;
        continue;
      }
      if (tempCreated) {
        try { fs.unlinkSync(tempPath); } catch { /* 임시 파일 정리 실패는 원래 오류를 유지한다. */ }
      }
      throw error;
    }
  }
  throw lastExistsError;
}

function removeFileIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function escapeTomlBasicString(value: string): string {
  return value.replace(TOML_BASIC_STRING_ESCAPE_PATTERN, (char) => {
    switch (char) {
      case "\b":
        return "\\b";
      case "\t":
        return "\\t";
      case "\n":
        return "\\n";
      case "\f":
        return "\\f";
      case "\r":
        return "\\r";
      case "\"":
        return "\\\"";
      case "\\":
        return "\\\\";
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

function resolveConfinedCodexSubagentPath(rootDir: string, fileName: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const candidatePath = path.resolve(resolvedRoot, fileName);
  assertWithinRoot(resolvedRoot, candidatePath);
  return candidatePath;
}

function fsyncFileBestEffort(filePath: string): void {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fsync 실패는 원자성 보장 손실이지만 role 파일 생성을 막지는 않는다.
  }
}

function fsyncDirectoryBestEffort(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 일부 플랫폼의 디렉터리 fsync 제한은 role 파일 생성을 막지 않는다.
  }
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한을 지원하지 않는 파일시스템에서는 best-effort로 둔다.
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
