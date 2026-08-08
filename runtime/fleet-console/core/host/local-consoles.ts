import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
  /** WSL 배포판 안에서 돌고 있다면 그 이름. Windows에서만 채워진다. */
  readonly distro: string | null;
}

export interface LocalConsoleScanDeps {
  readonly fileSystem?: Pick<typeof fs, "readFileSync" | "readdirSync">;
  readonly isAlive?: (pid: number) => boolean;
  readonly lockFiles?: readonly string[];
  readonly platform?: NodeJS.Platform;
  /** 지금 돌고 있는 WSL 배포판 이름들. */
  readonly listWslDistros?: () => readonly string[];
  /** WSL 콘솔의 생존 판정. pid는 쓸 수 없으므로 포트로 확인한다. */
  readonly reachable?: (origin: string) => Promise<boolean>;
}

interface LockFileShape {
  readonly pid?: unknown;
  readonly endpoint?: unknown;
  readonly version?: unknown;
  readonly owner?: { readonly kind?: unknown };
}

const WSL_ROOT = "\\\\wsl.localhost";
const WSL_TMP = "tmp";
const LOCK_FILE = "console.lock";
const STABLE_SLOT = /^fleet-console-\d{1,10}-stable$/u;
/**
 * 배포판 이름은 UNC 경로에 그대로 이어 붙으므로, 경로가 될 수 있는 글자는 받지 않는다.
 * 점만으로 이루어진 이름(`.`·`..`)도 막는다 — 글자 집합만 보면 통과하지만 상위 디렉터리를 뜻한다.
 */
const DISTRO_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
const DOTS_ONLY = /^\.+$/u;

function isUsableDistroName(name: string): boolean {
  return DISTRO_NAME.test(name) && !DOTS_ONLY.test(name);
}
const WSL_LIST_TIMEOUT_MS = 3_000;
const REACHABLE_TIMEOUT_MS = 700;

export async function listLocalConsoles(deps: LocalConsoleScanDeps = {}): Promise<readonly LocalConsoleEntry[]> {
  const fileSystem = deps.fileSystem ?? fs;
  const isAlive = deps.isAlive ?? processIsAlive;
  const entries: LocalConsoleEntry[] = [];
  const seen = new Set<string>();

  for (const file of deps.lockFiles ?? canonicalLockFiles()) {
    const entry = readLock(fileSystem, file, null);
    // 같은 기계의 콘솔이므로 pid로 판정한다.
    if (entry === null || !isAlive(entry.pid) || seen.has(entry.console.origin)) continue;
    seen.add(entry.console.origin);
    entries.push(entry.console);
  }

  for (const candidate of wslLockFiles(deps, fileSystem)) {
    const entry = readLock(fileSystem, candidate.file, candidate.distro);
    if (entry === null || seen.has(entry.console.origin)) continue;
    // 배포판 안의 pid는 그쪽 네임스페이스의 것이라 여기서 물으면 남의 프로세스를 가리킨다.
    // 살아 있는지는 포트가 답하는지로만 판정한다.
    const reachable = deps.reachable ?? portAnswers;
    if (!(await reachable(entry.console.origin))) continue;
    seen.add(entry.console.origin);
    entries.push(entry.console);
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

/**
 * WSL 안에서 돌고 있는 콘솔의 락 파일들.
 *
 * WSL2는 배포판이 루프백에 연 포트를 Windows의 localhost로 넘겨 주므로(localhostForwarding 기본값),
 * 여기서 읽은 `http://127.0.0.1:PORT`는 Windows 쪽에서도 그대로 열린다. 그 전달이 꺼져 있으면
 * 주소는 읽히지만 응답이 없고, 그때는 생존 판정에서 걸러진다.
 *
 * 배포판 안의 uid를 알 수 없어 stable 슬롯 이름을 계산할 수 없으므로 `/tmp`를 훑어 고른다.
 * local 슬롯은 체크아웃 위치에 달려 있어 바깥에서는 추측할 수 없다 — stable만 보인다.
 */
function wslLockFiles(deps: LocalConsoleScanDeps, fileSystem: Pick<typeof fs, "readdirSync">): readonly { readonly file: string; readonly distro: string }[] {
  if ((deps.platform ?? process.platform) !== "win32") return [];
  const distros = (deps.listWslDistros ?? runningWslDistros)().filter(isUsableDistroName);
  const files: { file: string; distro: string }[] = [];
  for (const distro of distros) {
    const tmp = `${WSL_ROOT}\\${distro}\\${WSL_TMP}`;
    let slots: readonly string[];
    try {
      slots = fileSystem.readdirSync(tmp) as unknown as readonly string[];
    } catch {
      // 배포판이 막 멈췄거나 공유가 준비되지 않았을 수 있다 — 나머지 배포판은 계속 본다.
      continue;
    }
    for (const slot of slots) {
      if (STABLE_SLOT.test(slot)) files.push({ file: `${tmp}\\${slot}\\${LOCK_FILE}`, distro });
    }
  }
  return files;
}

/** `wsl.exe`는 UTF-16LE로 답한다 — utf8로 읽으면 이름 사이에 NUL이 끼어 전부 걸러진다. */
function runningWslDistros(): readonly string[] {
  try {
    const output = execFileSync("wsl.exe", ["--list", "--quiet", "--running"], {
      encoding: "utf16le",
      timeout: WSL_LIST_TIMEOUT_MS,
      windowsHide: true,
    });
    return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function readLock(
  fileSystem: Pick<typeof fs, "readFileSync">,
  file: string,
  distro: string | null,
): { readonly console: LocalConsoleEntry; readonly pid: number } | null {
  let parsed: LockFileShape;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(file, "utf8")) as LockFileShape;
  } catch {
    return null;
  }
  if (typeof parsed?.pid !== "number" || typeof parsed.endpoint !== "string") return null;
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
    pid: parsed.pid,
    console: {
      origin,
      version: typeof parsed.version === "string" ? parsed.version : "",
      owner: owner === "cli" || owner === "desktop" ? owner : null,
      distro,
    },
  };
}

/** 락 파일이 남아 있다고 콘솔이 살아 있는 것은 아니다. 죽은 줄을 목록에 올리면 누르는 사람만 손해다. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM은 "남의 프로세스지만 살아 있다"는 뜻이다.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portAnswers(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.destroy();
      resolve(true);
    });
    const fail = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(REACHABLE_TIMEOUT_MS, fail);
    socket.on("error", fail);
  });
}
