import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

interface FileSnapshot {
  readonly content: string;
  readonly mtimeMs?: number;
  readonly size?: number;
}

interface PatchCodexConfigOptions {
  readonly codexHome: string;
  readonly pluginKey: string;
}

interface TomlDocument {
  readonly finalNewline: boolean;
  readonly lines: readonly string[];
  readonly newline: string;
}

interface TableRange {
  readonly end: number;
  readonly name: readonly string[];
  readonly start: number;
}

const CONFIG_FILE_NAME = "config.toml";
const CONFIG_FILE_MODE = 0o600;
const STALE_FLEET_PLUGIN_KEYS = [
  "fleet@fleet",
  "fleet@fleet-local",
  "fleet@fleet-marketplace",
  "fleet@dotobokuri",
] as const;

export function neutralizeCodexFleetPluginConfig(options: PatchCodexConfigOptions): void {
  mutateCodexConfigWithRetry(options, 0);
}

function mutateCodexConfigWithRetry(options: PatchCodexConfigOptions, attempt: number): void {
  const configPath = path.join(options.codexHome, CONFIG_FILE_NAME);
  // config.toml이 심링크(예: dotfiles 저장소로 링크)일 수 있다. 실제 대상 파일을 따라가 읽고,
  // atomic rename도 실제 대상 디렉터리에서 수행해 심링크 자체는 보존하면서 내용만 갱신한다.
  const targetPath = resolveRealConfigPath(configPath);
  const snapshot = readConfigSnapshot(targetPath);
  const nextContent = patchCodexConfig(snapshot.content, options);
  if (nextContent === snapshot.content) return;
  try {
    writeConfigIfUnchanged(targetPath, snapshot, nextContent);
  } catch (error) {
    if (attempt < 1 && isRaceError(error)) {
      mutateCodexConfigWithRetry(options, attempt + 1);
      return;
    }
    throw error;
  }
}

function resolveRealConfigPath(configPath: string): string {
  try {
    return realpathSync(configPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    // 파일이 아직 없으면 실제 디렉터리(심링크 디렉터리 대응) 기준으로 경로를 구성한다.
    try {
      return path.join(realpathSync(path.dirname(configPath)), path.basename(configPath));
    } catch (dirError) {
      if (isNodeError(dirError, "ENOENT")) return configPath;
      throw dirError;
    }
  }
}

function patchCodexConfig(content: string, options: PatchCodexConfigOptions): string {
  // 마켓플레이스 등록은 건드리지 않는다(활성 마켓플레이스의 TOML 키가 "fleet"일 수 있어 삭제 시 churn/로드 깨짐 위험).
  // Fleet plugin은 전역에서 enabled=false로 중화하고, stale 플러그인 엔트리만 비활성화한다.
  const document = parseTomlDocument(content);
  let lines = [...document.lines];
  lines = setPluginEnabled(lines, options.pluginKey, false);
  for (const pluginKey of STALE_FLEET_PLUGIN_KEYS) {
    if (pluginKey === options.pluginKey) continue;
    lines = setPluginEnabled(lines, pluginKey, false, { onlyExisting: true });
  }
  return serializeTomlDocument({ ...document, lines });
}

function readConfigSnapshot(configPath: string): FileSnapshot {
  let fd: number | undefined;
  try {
    // configPath는 이미 resolveRealConfigPath로 심링크가 해소된 실제 파일 경로다.
    fd = openSync(configPath, constants.O_RDONLY);
    const stat = fstatSync(fd);
    return {
      content: readFileSync(fd, "utf8"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { content: "" };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeConfigIfUnchanged(configPath: string, snapshot: FileSnapshot, content: string): void {
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  assertConfigUnchanged(configPath, snapshot);
  const tempPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CONFIG_FILE_MODE);
    writeFileSync(fd, content, { encoding: "utf8" });
    closeSync(fd);
    fd = undefined;
    assertConfigUnchanged(configPath, snapshot);
    renameSync(tempPath, configPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkBestEffort(tempPath);
  }
}

function assertConfigUnchanged(configPath: string, snapshot: FileSnapshot): void {
  if (snapshot.mtimeMs === undefined || snapshot.size === undefined) {
    if (existsSync(configPath)) {
      throw new Error("Codex config changed during Fleet plugin neutralization");
    }
    return;
  }
  const stat = statSync(configPath, { throwIfNoEntry: false });
  if (!stat || stat.mtimeMs !== snapshot.mtimeMs || stat.size !== snapshot.size) {
    throw new Error("Codex config changed during Fleet plugin neutralization");
  }
}

function parseTomlDocument(content: string): TomlDocument {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = content.length === 0 || /\r?\n$/.test(content);
  const lines = content.length === 0
    ? []
    : content.split(/\r?\n/).slice(0, finalNewline ? -1 : undefined);
  return { finalNewline, lines, newline };
}

function serializeTomlDocument(document: TomlDocument): string {
  if (document.lines.length === 0) return "";
  const body = document.lines.join(document.newline);
  return document.finalNewline ? `${body}${document.newline}` : body;
}

function setPluginEnabled(
  lines: readonly string[],
  pluginKey: string,
  enabled: boolean,
  options: { readonly onlyExisting?: boolean } = {},
): string[] {
  const mutable = [...lines];
  const range = findTable(mutable, ["plugins", pluginKey]);
  if (!range) {
    if (options.onlyExisting === true) return mutable;
    if (mutable.length > 0 && mutable[mutable.length - 1] !== "") mutable.push("");
    mutable.push(`[plugins."${escapeTomlKey(pluginKey)}"]`, `enabled = ${enabled ? "true" : "false"}`);
    return mutable;
  }
  const enabledLine = findEnabledLine(mutable, range);
  if (enabledLine === undefined) {
    mutable.splice(range.start + 1, 0, `enabled = ${enabled ? "true" : "false"}`);
    return mutable;
  }
  mutable[enabledLine] = mutable[enabledLine]!.replace(/^(\s*enabled\s*=\s*)(?:true|false)(.*)$/u, `$1${enabled ? "true" : "false"}$2`);
  return mutable;
}

function findTable(lines: readonly string[], name: readonly string[]): TableRange | undefined {
  const ranges = listTables(lines);
  return ranges.find((range) => sameTableName(range.name, name));
}

function listTables(lines: readonly string[]): TableRange[] {
  const ranges: TableRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const name = parseTableName(lines[index]!);
    if (!name) continue;
    if (ranges.length > 0) {
      const previous = ranges[ranges.length - 1]!;
      ranges[ranges.length - 1] = { ...previous, end: index };
    }
    ranges.push({ end: lines.length, name, start: index });
  }
  return ranges;
}

function parseTableName(line: string): readonly string[] | undefined {
  const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
  if (!match) return undefined;
  return splitTablePath(match[1]!);
}

function splitTablePath(value: string): readonly string[] | undefined {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " ") index += 1;
    if (value[index] === "\"") {
      const parsed = readQuotedKey(value, index);
      if (!parsed) return undefined;
      parts.push(parsed.value);
      index = parsed.nextIndex;
    } else if (value[index] === "'") {
      const parsed = readLiteralKey(value, index);
      if (!parsed) return undefined;
      parts.push(parsed.value);
      index = parsed.nextIndex;
    } else {
      const match = value.slice(index).match(/^([A-Za-z0-9_-]+)/u);
      if (!match) return undefined;
      parts.push(match[1]!);
      index += match[1]!.length;
    }
    while (value[index] === " ") index += 1;
    if (index === value.length) return parts;
    if (value[index] !== ".") return undefined;
    index += 1;
  }
  return parts;
}

function readQuotedKey(value: string, startIndex: number): { readonly nextIndex: number; readonly value: string } | undefined {
  let result = "";
  for (let index = startIndex + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\"") return { nextIndex: index + 1, value: result };
    if (character === "\\") {
      const next = value[index + 1];
      if (next === undefined) return undefined;
      result += next;
      index += 1;
      continue;
    }
    result += character;
  }
  return undefined;
}

function readLiteralKey(value: string, startIndex: number): { readonly nextIndex: number; readonly value: string } | undefined {
  // TOML literal string(작은따옴표) 키는 이스케이프가 없어 다음 작은따옴표가 곧 종료다.
  const end = value.indexOf("'", startIndex + 1);
  if (end === -1) return undefined;
  return { nextIndex: end + 1, value: value.slice(startIndex + 1, end) };
}

function findEnabledLine(lines: readonly string[], range: TableRange): number | undefined {
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^\s*enabled\s*=\s*(?:true|false)(?:\s*(?:#.*)?)$/u.test(lines[index]!)) return index;
  }
  return undefined;
}

function sameTableName(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function escapeTomlKey(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

function isRaceError(error: unknown): boolean {
  return error instanceof Error && error.message === "Codex config changed during Fleet plugin neutralization";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function unlinkBestEffort(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch {
    // 임시 파일 정리 실패는 원래 오류를 가리지 않는다.
  }
}
