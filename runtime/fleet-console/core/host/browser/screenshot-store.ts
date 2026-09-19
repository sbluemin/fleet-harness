import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";

/**
 * 인라인으로 싣기엔 큰 스크린샷이 놓이는 자리. 에이전트는 경로를 받아 제 손으로 읽는다.
 *
 * 여기가 **Console 호스트의 파일시스템**인 것이 이 저장소의 요점이다. 뷰를 그리는 Desktop 은 원격일 수
 * 있지만 캡처 바이트는 CDP 응답으로 이 프로세스까지 오고, 도구를 부르는 에이전트는 언제나 이 기계에서
 * 돈다. 그러므로 파일은 Desktop 이 아니라 여기에 두어야 경로가 에이전트에게 열린다.
 */

const SCREENSHOT_NAMESPACE_PREFIX = "fleet-browser-shots-";
const SCREENSHOT_FILE_MODE = 0o600;
/** Operation 마다 남기는 장수 — 에이전트가 직전 화면들을 되짚을 만큼만 두고 그 앞은 버린다. */
const KEEP_PER_OPERATION = 12;

export interface BrowserScreenshotStore {
  /** 바이트를 파일로 놓고 절대 경로를 돌려준다. */
  save(operationId: string, bytes: Buffer, ext: "jpg" | "png"): string;
  /** 이 Operation 의 스크린샷을 모두 거둔다. */
  release(operationId: string): void;
  /** 서버 종료 — 이 프로세스가 남긴 스크린샷을 거둔다. */
  cleanup(): void;
}

/** 데이터 루트별 스크린샷 네임스페이스 루트. os.tmpdir() 이 상대값일 수 있어 여기서 절대 경로로 고정한다. */
export function resolveBrowserScreenshotNamespaceRoot(dataDir: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 12);
  return path.join(path.resolve(os.tmpdir()), `${SCREENSHOT_NAMESPACE_PREFIX}${hash}`);
}

export function createBrowserScreenshotStore(options: { readonly dataDir: string; readonly log?: (message: string) => void }): BrowserScreenshotStore {
  const namespaceRoot = resolveBrowserScreenshotNamespaceRoot(options.dataDir);
  const counters = new Map<string, number>();
  /** 이 프로세스가 만든 Operation 디렉터리. 회수는 여기 있는 것만 건드린다. */
  const owned = new Set<string>();
  let reclaimed = false;

  /**
   * 지난 프로세스가 남긴 스크린샷은 사람이 본 페이지의 사본이므로 오래 두지 않는다. 다만 **첫 저장까지 미룬다** —
   * 서버는 생성 시점이 아니라 기동 끝에서 runtime lock 을 잡으므로, 생성하며 비우면 잠금 경쟁에서 지게 될
   * 프로세스가 이미 돌고 있는 쪽의 살아 있는 네임스페이스를 지워 건네준 경로를 무효로 만든다. 저장이 일어나는
   * 시점이면 이 프로세스가 서비스 중이고, 남아 있는 것은 죽은 프로세스의 잔재다.
   */
  const reclaimLeftovers = (): void => {
    if (reclaimed) return;
    reclaimed = true;
    try {
      let hadLeftovers = true;
      try { lstatSync(namespaceRoot); } catch { hadLeftovers = false; }
      rmSync(namespaceRoot, { force: true, recursive: true });
      if (hadLeftovers) options.log?.("cleared leftover screenshots from a previous run");
    } catch {
      // 청소는 best-effort — 잔재가 저장을 막지 않는다.
    }
  };

  // Operation id 는 경로 조각으로 쓰기에 안전하지 않다 — 해시로 고정 길이 이름을 만든다.
  const operationDir = (operationId: string) =>
    path.join(namespaceRoot, `op-${crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 12)}`);

  const prune = (dir: string): void => {
    try {
      // 나이는 이름의 사전순이 아니라 일련번호가 정한다 — 자리수를 넘긴 번호(shot-10000)가 사전순으로 앞서면
      // 방금 쓴 장을 지우고 없는 경로를 돌려주게 된다.
      const files = readdirSync(dir)
        .filter((name) => /^shot-\d+\./.test(name))
        .sort((a, b) => Number.parseInt(a.slice(5), 10) - Number.parseInt(b.slice(5), 10));
      for (const name of files.slice(0, Math.max(0, files.length - KEEP_PER_OPERATION))) {
        try { rmSync(path.join(dir, name), { force: true }); } catch { /* best-effort */ }
      }
    } catch {
      // 목록을 못 읽어도 저장은 계속된다.
    }
  };

  return {
    save(operationId, bytes, ext) {
      reclaimLeftovers();
      const dir = operationDir(operationId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      owned.add(dir);
      const serial = (counters.get(operationId) ?? 0) + 1;
      counters.set(operationId, serial);
      const filePath = path.join(dir, `shot-${String(serial).padStart(4, "0")}.${ext}`);
      writeFileSync(filePath, bytes, { mode: SCREENSHOT_FILE_MODE });
      try { chmodSync(filePath, SCREENSHOT_FILE_MODE); } catch { /* POSIX 권한이 없는 파일시스템 */ }
      prune(dir);
      return filePath;
    },
    release(operationId) {
      counters.delete(operationId);
      const dir = operationDir(operationId);
      owned.delete(dir);
      try { rmSync(dir, { force: true, recursive: true }); } catch { /* best-effort */ }
    },
    cleanup() {
      counters.clear();
      // 이 프로세스가 만든 것만 거둔다 — 기동에 실패한 쪽의 정리가 이미 서비스 중인 쪽의 장을 지우면 안 된다.
      for (const dir of owned) {
        try { rmSync(dir, { force: true, recursive: true }); } catch { /* best-effort */ }
      }
      owned.clear();
      // 마지막 하나가 나가면 네임스페이스도 접는다. 남의 디렉터리가 있으면 비어 있지 않아 그대로 남는다.
      try { rmdirSync(namespaceRoot); } catch { /* 비어 있지 않거나 이미 없다 */ }
    },
  };
}
