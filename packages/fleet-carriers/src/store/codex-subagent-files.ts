import * as fs from "node:fs";
import * as path from "node:path";

import type { CodexSubagentRoleDefinition, CodexSubagentToml } from "../subagents/types.js";
import { getCarriersFilePath, withStoreLock } from "./state-io.js";

export interface CodexSubagentRoleFile {
  readonly configFile: string;
  readonly definition: CodexSubagentRoleDefinition;
  readonly instructionsFile: string;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
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
    const rootIdentity = rootDir ? readCodexSubagentRootIdentity(rootDir) : null;
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

function readRequiredCodexSubagentRootIdentity(rootDir: string): DirectoryIdentity {
  const identity = readCodexSubagentRootIdentity(rootDir);
  if (!identity) throw new Error(`Codex subagent root is missing: ${rootDir}`);
  return identity;
}

function readCodexSubagentRootIdentity(rootDir: string): DirectoryIdentity | null {
  const stats = lstatCodexSubagentRoot(rootDir);
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw new Error(`Codex subagent root must not be a symlink: ${rootDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Codex subagent root must be a directory: ${rootDir}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

function lstatCodexSubagentRoot(rootDir: string): fs.Stats | null {
  try {
    return fs.lstatSync(rootDir);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function assertCodexSubagentRootIsNotSymlink(rootDir: string): void {
  const stats = lstatCodexSubagentRoot(rootDir);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Codex subagent root must not be a symlink: ${rootDir}`);
  }
}

function assertCodexSubagentRootIdentity(rootDir: string, expected: DirectoryIdentity): void {
  const actual = readRequiredCodexSubagentRootIdentity(rootDir);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Codex subagent root changed during role file operation: ${rootDir}`);
  }
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
      fs.writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: FILE_MODE });
      tempCreated = true;
      chmodBestEffort(tempPath, FILE_MODE);
      fsyncFile(tempPath);
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
  if (!candidatePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Codex subagent role path escapes root: ${fileName}`);
  }
  return candidatePath;
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
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
