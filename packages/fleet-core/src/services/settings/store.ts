/**
 * core-settings/store.ts — settings.json CRUD
 *
 * 패키지-local settings.json 파일을 읽고 쓰는 저수준 함수.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;
const SECURE_DIR_MODE = 0o700;

/** 특정 섹션 로드 */
export function loadSection<T = Record<string, unknown>>(key: string): T {
  const global = readGlobalJson();
  const section = global[key];
  if (typeof section !== "object" || section === null) return {} as T;
  return section as T;
}

/** 특정 섹션 저장 (기존 데이터와 병합) */
export function saveSection(key: string, data: unknown): void {
  const global = readGlobalJson();
  global[key] = data;
  writeGlobalJson(global);
}

/** 전체 JSON 객체 읽기 */
function readGlobalJson(): Record<string, unknown> {
  const settingsPath = path.join(getFleetDataDir(), "settings.json");
  try {
    const stat = safeLstat(settingsPath);
    if (!stat) return {};
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 전체 JSON 객체 쓰기 */
function writeGlobalJson(data: Record<string, unknown>): void {
  const fleetDataDir = getFleetDataDir();
  // 디렉토리가 없으면 생성 (~/.fleet/ 첫 실행 시)
  ensureSafeDirectory(fleetDataDir);
  const settingsPath = path.join(fleetDataDir, "settings.json");
  const stat = safeLstat(settingsPath);
  if (stat?.isSymbolicLink()) return;

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    NOFOLLOW_FLAG |
    NONBLOCK_FLAG;
  const fd = fs.openSync(settingsPath, flags, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) return;
    fs.writeSync(fd, JSON.stringify(data, null, 2), undefined, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function ensureSafeDirectory(dirPath: string): void {
  const stat = safeLstat(dirPath);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe Fleet settings directory: ${dirPath}`);
    }
    fs.chmodSync(dirPath, SECURE_DIR_MODE);
    return;
  }
  fs.mkdirSync(dirPath, { mode: SECURE_DIR_MODE, recursive: true });
  const created = safeLstat(dirPath);
  if (!created?.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Unsafe Fleet settings directory: ${dirPath}`);
  }
  fs.chmodSync(dirPath, SECURE_DIR_MODE);
}

function safeLstat(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}
