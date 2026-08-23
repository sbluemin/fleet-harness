import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { isProcessAlive } from "@dotobokuri/core-infra";

import { cleanupPrivateRoot, ensurePrivateDir, removePrivatePath, writePrivateFile, writePrivateJson } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";
import type { PluginSessionReclaimDeps } from "../types.js";

/**
 * 세션 플러그인 트리가 앉는 자리는 그 세션의 워크스페이스 안이다:
 * `<dataDir>/workspaces/<name>/sessions/<sessionId>`.
 *
 * 세션 하나가 디렉터리 하나를 통째로 갖는 것이 이 저장소의 전부다. 공유가 없으므로 다른 런치가
 * 실행 중인 세션의 훅·스킬·정체성을 바꿔칠 방법 자체가 없다 — 훅은 `${CLAUDE_PLUGIN_ROOT}`를
 * 이벤트 시점마다 디스크에서 다시 읽으므로, 공유 트리를 재렌더하는 것은 조용한 정책 교체였다.
 *
 * 옛 `marketplace/` 트리 아래에 두지 않는 이유는 따로 있다: 패치할 수 없는 구버전 CLI가 지금도
 * 그 트리를 통째로 재렌더하면서 자기가 모르는 형제 디렉터리를 전부 지운다.
 */
export const PLUGIN_SESSIONS_DIR_NAME = "sessions";

const SESSION_MANIFEST_NAME = ".fleet-session.json";
const HOLDERS_DIR_NAME = ".holders";
const STAGING_PREFIX = ".stage-";
/**
 * 홀더 pid가 죽어 보여도 이 유예 안에서는 트리를 지우지 않는다.
 *
 * 유예가 필요한 창은 하나다 — 트리를 발행하고 홀더를 세운 뒤, 호스트가 실제 자식 pid를
 * 붙이기(`attach`)까지의 사이. 그동안 홀더는 런처의 pid를 들고 있으므로, 런처가 먼저 죽으면
 * 아직 살아날 자식이 죽은 것처럼 보인다. `attach`가 끝난 뒤에는 홀더가 그 트리를 실제로 읽는
 * 프로세스를 직접 가리키므로 pid 생사 판정이 정확해지고, 유예는 더 이상 필요하지 않다.
 */
const RECLAIM_GRACE_MS = 10 * 60 * 1000;
const STAGING_GRACE_MS = 60 * 60 * 1000;
/**
 * 디렉터리 이름으로 쓸 수 있는 세션 id.
 *
 * UUID보다 넓다. 새 세션과 갈래의 id는 Claude가 UUID를 요구하므로 그쪽에서 따로 좁히지만,
 * 이어 붙이는 세션의 id는 이미 존재하는 트랜스크립트가 주는 값이라 우리가 고를 수 없다 —
 * 여기서 요구할 수 있는 것은 그 값이 경로를 벗어나지 않는다는 것뿐이다. 점으로 시작하는
 * 이름을 막아 두면 운영용 항목(`.holders`·`.stage-`)과도 섞이지 않는다.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let stagingCounter = 0;

export interface PluginSessionLease {
  readonly contentHash: string;
  readonly pluginRoot: string;
  readonly sessionId: string;
  /**
   * 이 트리를 실제로 읽는 자식의 pid를 홀더에 옮겨 적는다. 호스트가 spawn 직후 부른다 —
   * 자식 pid는 프로세스를 세운 호스트만 알고, 그것을 알기 전까지 홀더는 런처를 가리킨다.
   * 자식 pid를 모르는 표면(SDK 경로)은 부르지 않아도 되며, 그때 홀더는 런처를 계속 가리킨다.
   */
  readonly attach: (childPid: number) => void;
  readonly release: () => void;
}

export type { PluginSessionReclaimDeps } from "../types.js";

export function isPluginSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** 파일 집합의 내용 해시. 재렌더가 필요한지 판정하는 유일한 근거다. 매니페스트 자신은 입력이 아니다(순환). */
export function hashPluginFiles(files: readonly AssetPluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * 이 세션의 플러그인 트리를 확보한다. 호출자는 저장소 락을 이미 쥐고 있어야 한다.
 *
 * 새 세션과 fork 재개는 매번 새 id를 받으므로 여기서 기존 트리를 만날 일이 없다. 만나는 경우는
 * 하나뿐이다 — 같은 세션을 다시 재개하는 런치. 그때 내용이 같으면 그대로 쓰고, 갈렸는데 아직
 * 그 트리를 쥔 런치가 살아 있으면 고쳐 쓰지 않고 이 런치를 시끄럽게 실패시킨다.
 */
export function acquirePluginSession(
  sessionsRoot: string,
  sessionId: string,
  files: readonly AssetPluginFile[],
  deps: PluginSessionReclaimDeps = {},
): PluginSessionLease {
  if (!isPluginSessionId(sessionId)) {
    throw new Error(`Fleet plugin session id cannot name a directory: ${sessionId}`);
  }
  ensurePrivateDir(sessionsRoot, sessionsRoot);
  const contentHash = hashPluginFiles(files);
  const pluginRoot = path.join(sessionsRoot, sessionId);
  if (existsSync(pluginRoot)) {
    if (!verifyPluginSession(pluginRoot, contentHash, files)) {
      if (hasLiveHolder(sessionsRoot, sessionId, deps.isPidAlive) || hasRecentHolderTrace(sessionsRoot, sessionId, deps.now)) {
        throw new Error(
          `Fleet plugin session tree is in use by another launch and its content differs: ${pluginRoot}`,
        );
      }
      removePrivatePath(pluginRoot, sessionsRoot);
      publishPluginSession(sessionsRoot, sessionId, contentHash, files);
    }
  } else {
    publishPluginSession(sessionsRoot, sessionId, contentHash, files);
  }
  const holder = holdPluginSession(sessionsRoot, sessionId);
  reclaimPluginSessions(sessionsRoot, sessionId, deps);
  return { contentHash, pluginRoot, sessionId, attach: holder.attach, release: holder.release };
}

function publishPluginSession(
  sessionsRoot: string,
  sessionId: string,
  contentHash: string,
  files: readonly AssetPluginFile[],
): void {
  // 스테이징 이름은 짧아야 한다 — Windows MAX_PATH(260) 안에서 최종 경로보다 길어지면
  // 발행만 실패하는 트리가 생긴다(실측: 짧은 이름 157자 / 최종 179자).
  const stageParent = path.join(sessionsRoot, `${STAGING_PREFIX}${process.pid}-${stagingCounter += 1}`);
  const stagedRoot = path.join(stageParent, "t");
  try {
    ensurePrivateDir(stagedRoot, stageParent);
    // 빈 로스터에서도 agents/는 존재해야 한다 — 소비자는 디렉터리 부재와 정체성 0개를 구분하지 않는다.
    ensurePrivateDir(path.join(stagedRoot, "agents"), stageParent);
    for (const file of files) {
      writePrivateFile(path.join(stagedRoot, ...file.relativePath.split("/")), file.content, stageParent);
    }
    writePrivateJson(path.join(stagedRoot, SESSION_MANIFEST_NAME), {
      version: 1,
      sessionId,
      contentHash,
      renderedAt: Date.now(),
    }, stageParent);
    const pluginRoot = path.join(sessionsRoot, sessionId);
    try {
      renameSync(stagedRoot, pluginRoot);
    } catch (error) {
      // 락 아래라 정상 경합은 없다. 남아 있던 잔해와 부딪히면: 그것이 온전한 같은 내용이면
      // 그대로 쓰고, 아니면 조용히 덮지 않고 런치를 실패시킨다.
      if (!verifyPluginSession(pluginRoot, contentHash, files)) throw error;
    }
  } finally {
    cleanupPrivateRoot(stageParent, sessionsRoot);
  }
}

/**
 * 기대 파일 전량을 바이트 비교로 검증한다. 여분 파일은 실패 사유가 아니다 — 실패는
 * 매니페스트 해시 불일치, 기대 파일의 부재·변조, 또는 필수 디렉터리의 부재다.
 */
function verifyPluginSession(
  pluginRoot: string,
  contentHash: string,
  files: readonly AssetPluginFile[],
): boolean {
  try {
    const manifestRaw = readFileSync(path.join(pluginRoot, SESSION_MANIFEST_NAME), "utf8");
    const manifest = JSON.parse(manifestRaw) as { readonly contentHash?: unknown };
    if (manifest.contentHash !== contentHash) return false;
    // agents/는 빈 로스터에서도 소비자가 요구하는 필수 디렉터리인데 파일 목록에는 빈 디렉터리가
    // 실리지 않으므로, 존재를 명시적으로 검증해야 복구 경로가 발동한다. lstat(no-follow)이어야
    // 한다 — 심링크로 바꿔치기된 디렉터리는 이 패키지 fs 규약대로 손상으로 판정한다.
    if (!lstatSync(path.join(pluginRoot, "agents")).isDirectory()) return false;
    for (const file of files) {
      const onDisk = readFileSync(path.join(pluginRoot, ...file.relativePath.split("/")), "utf8");
      if (onDisk !== file.content) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function holdersRootFor(sessionsRoot: string, sessionId: string): string {
  return path.join(sessionsRoot, HOLDERS_DIR_NAME, sessionId);
}

/**
 * 이 런치가 트리를 쥐고 있다는 표식. 홀더는 플러그인 루트 **바깥**에 앉는다 — 자식이 읽는
 * 트리에 Fleet의 운영 파일을 섞으면 플러그인 내용이 런치마다 달라진다.
 */
function holdPluginSession(
  sessionsRoot: string,
  sessionId: string,
): { readonly attach: (childPid: number) => void; readonly release: () => void } {
  // Console 데몬은 여러 세션이 한 pid를 공유하므로 홀더 정체성은 pid가 아니라 pid+nonce다.
  const holderPath = path.join(holdersRootFor(sessionsRoot, sessionId), `${process.pid}-${randomUUID()}.json`);
  const startedAt = Date.now();
  writePrivateJson(holderPath, { pid: process.pid, startedAt }, sessionsRoot);
  let released = false;
  return {
    attach: (childPid: number) => {
      if (released || !Number.isInteger(childPid) || childPid <= 0) return;
      try {
        writePrivateJson(holderPath, { pid: childPid, launcherPid: process.pid, startedAt }, sessionsRoot);
      } catch {
        // 옮겨 적지 못해도 런처 pid를 가리키는 홀더가 남는다 — 유예가 그 부정확을 흡수한다.
      }
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        removePrivatePath(holderPath, sessionsRoot);
        // 마지막 홀더가 나가면 트리도 함께 걷는다. 세션이 다시 재개되면 그때 다시 렌더한다 —
        // 정상 종료한 세션의 트리를 남겨 둘 이유가 없다.
        if (!hasAnyHolderTrace(sessionsRoot, sessionId)) {
          removePrivatePath(path.join(sessionsRoot, sessionId), sessionsRoot);
          removePrivatePath(holdersRootFor(sessionsRoot, sessionId), sessionsRoot);
        }
      } catch {
        // 홀더 해제 실패는 세션 종료를 막지 않는다. 남은 트리는 pid 사망 후 회수가 걷는다.
      }
    },
  };
}

function hasLiveHolder(
  sessionsRoot: string,
  sessionId: string,
  isPidAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  const holdersRoot = holdersRootFor(sessionsRoot, sessionId);
  if (!existsSync(holdersRoot)) return false;
  for (const entry of readdirSync(holdersRoot)) {
    try {
      const holder = JSON.parse(readFileSync(path.join(holdersRoot, entry), "utf8")) as { readonly pid?: unknown };
      if (typeof holder.pid !== "number") return true;
      if (isPidAlive(holder.pid)) return true;
    } catch {
      // 읽을 수 없는 홀더는 살아 있는 것으로 취급한다 — 불확실을 삭제로 해소하지 않는다.
      return true;
    }
  }
  return false;
}

/** 홀더 파일이 하나라도 남아 있는가 — pid 생사와 무관한 흔적 판정. 정상 반납한 런치는 파일을 지우고 간다. */
function hasAnyHolderTrace(sessionsRoot: string, sessionId: string): boolean {
  const holdersRoot = holdersRootFor(sessionsRoot, sessionId);
  if (!existsSync(holdersRoot)) return false;
  return readdirSync(holdersRoot).length > 0;
}

/** 유예 안의 홀더 흔적이 있는가 — 죽은 pid라도 재시작 고아 자식의 가능성으로 취급한다. */
function hasRecentHolderTrace(sessionsRoot: string, sessionId: string, now: () => number = Date.now): boolean {
  const holdersRoot = holdersRootFor(sessionsRoot, sessionId);
  if (!existsSync(holdersRoot)) return false;
  for (const entry of readdirSync(holdersRoot)) {
    try {
      if (now() - statSync(path.join(holdersRoot, entry)).mtimeMs <= RECLAIM_GRACE_MS) return true;
    } catch {
      // 확인할 수 없는 흔적은 최근 것으로 취급한다 — 불확실을 삭제로 해소하지 않는다.
      return true;
    }
  }
  return false;
}

/**
 * best-effort 회수. 정상 종료한 세션은 이미 자기 트리를 걷고 갔으므로, 여기 남는 것은
 * 홀더를 반납하지 못하고 죽은 런치의 잔해뿐이다. 살아 있는 홀더가 있거나 유예 안의 흔적이
 * 남은 트리는 건드리지 않는다. 어떤 실패도 런치를 막지 않는다.
 */
export function reclaimPluginSessions(
  sessionsRoot: string,
  keepSessionId: string,
  deps: PluginSessionReclaimDeps = {},
): void {
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? isProcessAlive;
  try {
    for (const entry of readdirSync(sessionsRoot)) {
      try {
        if (entry.startsWith(STAGING_PREFIX)) {
          if (now() - entryMtimeMs(sessionsRoot, entry) > STAGING_GRACE_MS) {
            removePrivatePath(path.join(sessionsRoot, entry), sessionsRoot);
          }
          continue;
        }
        if (entry === keepSessionId || !isPluginSessionId(entry)) continue;
        if (hasLiveHolder(sessionsRoot, entry, isPidAlive)) continue;
        if (hasRecentHolderTrace(sessionsRoot, entry, now)) continue;
        removePrivatePath(path.join(sessionsRoot, entry), sessionsRoot);
        removePrivatePath(holdersRootFor(sessionsRoot, entry), sessionsRoot);
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

function entryMtimeMs(parent: string, entry: string): number {
  try {
    return statSync(path.join(parent, entry)).mtimeMs;
  } catch {
    return 0;
  }
}
