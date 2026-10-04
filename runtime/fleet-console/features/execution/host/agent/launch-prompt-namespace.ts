import crypto from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LaunchPromptDirectoryAllocator } from "@fleet-console/agent-runtime/fleet";

/**
 * launch 프롬프트 파일(Theater 시스템 프롬프트, Windows Quick Launch 지시)이 놓이는 OS temp의 자리와,
 * 정리 없이 끝난(SIGKILL·crash·전원 차단) 이전 Console이 남긴 것의 회수.
 *
 * 무엇을 지워도 되는지가 이 모듈의 전부다. 지우는 항목은 세 조건을 **모두** 만족해야 한다.
 *
 * 1. 이 Console이 runtime lock을 쥐었다 — 회수는 호출자가 lock을 쓴 **뒤에만** 부른다. lock 전에 지우면
 *    lock 경쟁에서 질 프로세스가 이미 서비스 중인 Console의 파일을 지운다(첨부 namespace가 그렇다).
 * 2. 이 프로세스가 만들지 않았다 — lock은 기동 끝에 쓰이므로 그 전의 launch가 이미 여기 파일을 둘 수 있다.
 * 3. 그 항목을 만든 프로세스가 죽었다 — 이름에 생성자 pid가 들어 있다. lock 독점은 회수의 충분조건이
 *    아니다: 신뢰 검증에 실패한 lock은 생존 확인 없이 지워질 수 있고, 그러면 살아 있는 Console 옆에서
 *    다른 Console이 같은 lock을 쓴다. Quick Launch 지시 파일은 모델이 나중에 읽으므로 "CLI가 기동 때
 *    이미 읽었다"는 이유로 지울 수도 없다. pid가 재사용되면 남기는 쪽으로만 틀린다(다음 기동이 다시 본다).
 *
 * 자리는 lock 도메인마다 하나다(`fleet-launch-<lock 경로 해시>`). 다른 채널·checkout·override의 Console,
 * 그리고 lock을 쥐지 않는 독립 `fleet` launcher(이 포트를 받지 않는다)의 파일은 이 자리에 오지 않는다.
 * 이 자리 밖, 이전 버전이 OS temp에 바로 만든 디렉터리는 만든 주체를 알 수 없어 건드리지 않는다.
 *
 * root는 지우지 않는다. lock에서 진 프로세스의 정리 경로도 같은 root를 보므로, 비었다고 지우면 서비스 중인
 * Console의 다음 launch가 사라진 root를 만난다 — 매 할당이 root를 다시 만들고 다시 검증한다.
 */
export interface LaunchPromptNamespace extends LaunchPromptDirectoryAllocator {
  /**
   * runtime lock을 쓴 직후 한 번 부른다. 지운 항목 수를 돌려준다. 두 번째 호출부터는 아무것도 하지 않는다.
   */
  reclaimLeftovers(): number;
}

const NAMESPACE_PREFIX = "fleet-launch-";
/** `<prefix><pid>-<mkdtemp 6자>`. 이 모양이 아닌 항목은 만든 주체를 읽을 수 없으므로 건드리지 않는다. */
const ENTRY_OWNER_PATTERN = /-(\d+)-[A-Za-z0-9]{6}$/;

export function createLaunchPromptNamespace(options: {
  /** 이 Console의 runtime lock 파일. 회수 도메인의 키다. */
  readonly lockFile: string;
  readonly tmpDir?: string;
  readonly log?: (message: string) => void;
}): LaunchPromptNamespace {
  const log = options.log ?? ((message: string) => { process.stderr.write(`[fleet-console] launch prompts: ${message}\n`); });
  // 같은 경로의 다른 표기(/tmp ↔ /private/tmp, 심볼릭 링크)는 같은 lock이므로 같은 자리여야 한다.
  // 다르게 해시하면 서로 지우지는 않지만, 다른 표기로 기동한 Console의 잔재를 영영 회수하지 못한다.
  const tempRoot = resolveRealPath(options.tmpDir ?? os.tmpdir());
  const key = crypto.createHash("sha256").update(resolveRealPath(options.lockFile)).digest("hex").slice(0, 12);
  const root = path.join(tempRoot, `${NAMESPACE_PREFIX}${key}`);
  const owned = new Set<string>();
  let reclaimed = false;

  /** 다른 사용자가 같은 이름을 먼저 만든 디렉터리(공유 /tmp)나 링크에는 쓰지도 지우지도 않는다. */
  function rootIsOwned(): boolean {
    let stat;
    try {
      stat = lstatSync(root);
    } catch {
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    return (stat.mode & 0o077) === 0;
  }

  return {
    allocateDir(prefix) {
      try {
        mkdirSync(tempRoot, { recursive: true });
        mkdirSync(root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return createFallbackDir(tempRoot, prefix);
      }
      if (!rootIsOwned()) return createFallbackDir(tempRoot, prefix);
      const dir = mkdtempSync(path.join(root, `${prefix}${process.pid}-`));
      // mkdtemp와 같은 동기 구간에서 올린다 — 회수도 동기라 둘 사이에 끼어들 수 없다.
      if (!reclaimed) owned.add(path.basename(dir));
      return dir;
    },
    reclaimLeftovers() {
      if (reclaimed) return 0;
      reclaimed = true;
      let removed = 0;
      try {
        if (!rootIsOwned()) return 0;
        for (const name of readdirSync(root)) {
          if (owned.has(name)) continue;
          const match = ENTRY_OWNER_PATTERN.exec(name);
          const creator = match ? Number(match[1]) : NaN;
          if (!Number.isSafeInteger(creator) || creator <= 0 || isProcessAlive(creator)) continue;
          try {
            rmSync(path.join(root, name), { force: true, recursive: true });
            removed += 1;
          } catch {
            // 열린 파일(Windows) 등으로 못 지운 것은 다음 기동이 다시 본다.
          }
        }
      } catch {
        // 회수는 best-effort다 — 잔재가 남아도 기동을 막지 않는다.
      } finally {
        owned.clear();
      }
      if (removed > 0) log(`cleared ${removed} leftover launch prompt file(s) from a previous run`);
      return removed;
    },
  };
}

/** 살아 있다고 볼 수 없을 때(ESRCH)만 false다. 권한 부족(EPERM)이나 모르는 오류는 살아 있는 쪽으로 둔다. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 소유를 증명하지 못한 root 대신 쓰는 자리 — 회수 대상이 아닌, 포트가 없을 때와 같은 위치다. */
function createFallbackDir(tempRoot: string, prefix: string): string {
  mkdirSync(tempRoot, { recursive: true });
  return mkdtempSync(path.join(tempRoot, prefix));
}

/** 아직 없는 경로(첫 기동의 lock 파일)는 존재하는 가장 가까운 상위를 해석하고 나머지를 붙인다. */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
