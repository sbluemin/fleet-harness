import fs from "node:fs";
import os from "node:os";

import { getFleetDataDir } from "@dotobokuri/core-infra";

import { resolveCanonicalLocalConsolePaths, resolveCanonicalStableConsolePaths } from "./desktop-protocol.js";
import { readFleetConsoleRelease } from "./release.js";

/**
 * 이 기계에서 지금 돌고 있는 다른 콘솔들. 링크도 인증서도 필요 없는 지름길이라, 저장된 호스트
 * 목록과는 성격이 다르다 — 저장하지 않고 매번 다시 본다.
 *
 * 표준 락 경로는 둘뿐이다(uid별 stable 슬롯, 체크아웃별 local 슬롯). `FLEET_CONSOLE_DIR`로 띄운
 * 콘솔은 설계상 발견되지 않는다 — 격리해 달라고 한 것을 목록에 올리면 격리가 아니다.
 *
 * 이 목록은 **루프백 리스너에만** 의미가 있다. 원격에서 이 목록을 받으면 거기 적힌 127.0.0.1은
 * 보는 사람의 기계를 가리키므로, 같은 포트를 쓰는 전혀 다른 콘솔로 데려간다.
 */
export interface LocalConsoleEntry {
  readonly origin: string;
  readonly version: string;
  readonly owner: "cli" | "desktop" | null;
}

export interface LocalConsoleScanDeps {
  readonly fileSystem?: Pick<typeof fs, "readFileSync">;
  readonly isAlive?: (pid: number) => boolean;
  readonly lockFiles?: readonly string[];
}

interface LockFileShape {
  readonly pid?: unknown;
  readonly endpoint?: unknown;
  readonly version?: unknown;
  readonly owner?: { readonly kind?: unknown };
}

export function listLocalConsoles(deps: LocalConsoleScanDeps = {}): readonly LocalConsoleEntry[] {
  const fileSystem = deps.fileSystem ?? fs;
  const isAlive = deps.isAlive ?? processIsAlive;
  const entries: LocalConsoleEntry[] = [];
  const seen = new Set<string>();
  for (const file of deps.lockFiles ?? canonicalLockFiles()) {
    const entry = readLock(fileSystem, isAlive, file);
    if (entry === null || seen.has(entry.origin)) continue;
    seen.add(entry.origin);
    entries.push(entry);
  }
  return entries.sort((left, right) => left.origin.localeCompare(right.origin));
}

/** 스캔할 수 있는 곳은 이 둘뿐이다. 목록을 늘리려면 락을 쓰는 쪽 계약부터 늘어나야 한다. */
export function canonicalLockFiles(): readonly string[] {
  const files: string[] = [];
  try {
    files.push(resolveCanonicalStableConsolePaths({
      tmpDir: os.tmpdir(),
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      fleetDataDir: getFleetDataDir(),
    }).lockFile);
  } catch {
    // 데이터 루트를 못 읽는 환경에서도 나머지 한 곳은 계속 본다.
  }
  try {
    files.push(resolveCanonicalLocalConsolePaths({ packageRoot: readFleetConsoleRelease().packageRoot }).lockFile);
  } catch {
    // 게시본에서는 local 슬롯이 없을 수 있다.
  }
  return files;
}

function readLock(fileSystem: Pick<typeof fs, "readFileSync">, isAlive: (pid: number) => boolean, file: string): LocalConsoleEntry | null {
  let parsed: LockFileShape;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(file, "utf8")) as LockFileShape;
  } catch {
    return null;
  }
  if (typeof parsed?.pid !== "number" || typeof parsed.endpoint !== "string") return null;
  // 락 파일이 남아 있다고 콘솔이 살아 있는 것은 아니다. 죽은 줄을 목록에 올리면 누르는 사람만 손해다.
  if (!isAlive(parsed.pid)) return null;
  let origin: string;
  try {
    const url = new URL(parsed.endpoint);
    if (url.protocol !== "http:") return null;
    origin = url.origin;
  } catch {
    return null;
  }
  const owner = parsed.owner?.kind;
  return {
    origin,
    version: typeof parsed.version === "string" ? parsed.version : "",
    owner: owner === "cli" || owner === "desktop" ? owner : null,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM은 "남의 프로세스지만 살아 있다"는 뜻이다.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
