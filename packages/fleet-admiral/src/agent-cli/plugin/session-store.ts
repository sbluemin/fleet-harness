import path from "node:path";

import { ensurePrivateDir, removePrivatePath, writePrivateFile, writePrivateJson } from "./fs.js";
import type { AssetPluginFile } from "./fleet.js";

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

/** 이 트리가 무엇인지 사람이 알아볼 수 있게 남기는 기록. 코드는 읽지 않는다. */
const SESSION_MANIFEST_NAME = ".fleet-session.json";
/**
 * 디렉터리 이름으로 쓸 수 있는 세션 id.
 *
 * UUID보다 넓다. 새 세션과 갈래의 id는 Claude가 UUID를 요구하므로 그쪽에서 따로 좁히지만,
 * 이어 붙이는 세션의 id는 이미 존재하는 트랜스크립트가 주는 값이라 우리가 고를 수 없다 —
 * 여기서 요구할 수 있는 것은 그 값이 경로를 벗어나지 않는다는 것뿐이다.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PluginSessionLease {
  readonly pluginRoot: string;
  readonly sessionId: string;
  readonly release: () => void;
}

export function isPluginSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/**
 * 이 세션의 플러그인 트리를 확보한다. 호출자는 저장소 락을 이미 쥐고 있어야 한다.
 *
 * **한 세션의 트리는 언제나 런치 하나가 독점한다.** 같은 Claude 세션을 PTY와 SDK가 함께 여는
 * 상태는 Console이 상위에서 거부하고(전환은 유휴 세션만 허용하며 PTY를 먼저 접는다), 새 세션과
 * 갈래는 매번 새 id를 받는다. 그래서 여기서 만나는 기존 트리는 **반드시 끝난 런치의 잔해**다 —
 * 검증하거나 살릴 이유가 없으므로 그대로 걷고 다시 쓴다.
 *
 * 이 독점 전제가 점유 표식(홀더)과 회수 기계를 통째로 불필요하게 만든다. 잔해는 그 세션이 다시
 * 뜰 때 이 자리에서 정리되고, 정상 종료한 세션은 `release`가 자기 트리를 걷고 간다.
 */
export function acquirePluginSession(
  sessionsRoot: string,
  sessionId: string,
  files: readonly AssetPluginFile[],
): PluginSessionLease {
  if (!isPluginSessionId(sessionId)) {
    throw new Error(`Fleet plugin session id cannot name a directory: ${sessionId}`);
  }
  ensurePrivateDir(sessionsRoot, sessionsRoot);
  const pluginRoot = path.join(sessionsRoot, sessionId);
  removePrivatePath(pluginRoot, sessionsRoot);
  publishPluginSession(sessionsRoot, sessionId, files);
  return {
    pluginRoot,
    sessionId,
    release: () => {
      try {
        removePrivatePath(pluginRoot, sessionsRoot);
      } catch {
        // 반납 실패는 세션 종료를 막지 않는다. 남은 트리는 이 세션이 다시 뜰 때 걷힌다.
      }
    },
  };
}

/**
 * 세션 트리를 제자리에 쓴다. 스테이징도 rename도 없다.
 *
 * 이 트리를 읽을 자식은 발행이 끝난 뒤에야 서고, 발행은 저장소 락 안에서 돈다 — 반쯤 쓰인
 * 트리를 볼 프로세스가 없다. 중단된 발행이 남기는 잔해도 다음 런치가 무조건 걷어 내므로,
 * 중간 상태를 판정할 장치가 필요하지 않다.
 */
function publishPluginSession(
  sessionsRoot: string,
  sessionId: string,
  files: readonly AssetPluginFile[],
): void {
  const pluginRoot = path.join(sessionsRoot, sessionId);
  ensurePrivateDir(pluginRoot, sessionsRoot);
  // 빈 로스터에서도 agents/는 존재해야 한다 — 소비자는 디렉터리 부재와 정체성 0개를 구분하지 않는다.
  ensurePrivateDir(path.join(pluginRoot, "agents"), sessionsRoot);
  for (const file of files) {
    writePrivateFile(path.join(pluginRoot, ...file.relativePath.split("/")), file.content, sessionsRoot);
  }
  writePrivateJson(path.join(pluginRoot, SESSION_MANIFEST_NAME), {
    version: 1,
    sessionId,
    renderedAt: Date.now(),
  }, sessionsRoot);
}
