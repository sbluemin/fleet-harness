import path from "node:path";

import { ensureWorkspaceDirectory, resolveWorkspaceDirectory, withDirectoryLock } from "@dotobokuri/core-infra";
import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";

import { assetBundle, buildAssetPluginFiles } from "./fleet.js";
import { reclaimLegacyMarketplace } from "./legacy-marketplace.js";
import { acquirePluginSession, PLUGIN_SESSIONS_DIR_NAME, removePluginSessionTree } from "./session-store.js";
import type { AgentCliPlugin, CreateAgentCliPluginOptions } from "../types.js";

export type {
  AgentCliPlugin,
  CreateAgentCliPluginOptions,
} from "../types.js";

const SESSIONS_LOCK_SUFFIX = ".lock";

/**
 * 이 세션의 플러그인 트리가 앉을 자리. 저장 위치의 정의는 여기 한 곳에만 있다 —
 * 호스트가 각자 join하면 런타임마다 다른 자리를 계산하게 되고, 그 순간 두 표면은 서로의
 * 트리를 못 보게 된다.
 */
export function pluginSessionsRoot(dataDir: string, cwd: string): string {
  return path.join(ensureWorkspaceDirectory(dataDir, cwd).path, PLUGIN_SESSIONS_DIR_NAME);
}

/**
 * 이 세션의 플러그인 트리를 걷는다. Operation이 사라질 때 호스트가 부른다 — 트리는 세션의
 * 것이라 런치가 끝나도 남지만, 세션 자체가 없어지면 그것을 읽을 주체도 없다.
 *
 * 없는 워크스페이스를 만들지 않는다: 회수는 자리를 세우는 일이 아니다. 어떤 실패도 호출자의
 * 삭제 흐름을 막지 않는다.
 */
export function removePluginSession(options: {
  readonly cwd: string;
  readonly dataDir?: string;
  readonly sessionId: string;
}): void {
  try {
    const fleetRoot = options.dataDir ?? getFleetDataDir();
    const sessionsRoot = path.join(resolveWorkspaceDirectory(fleetRoot, options.cwd).path, PLUGIN_SESSIONS_DIR_NAME);
    withDirectoryLock(
      { lockDir: `${sessionsRoot}${SESSIONS_LOCK_SUFFIX}` },
      () => removePluginSessionTree(sessionsRoot, options.sessionId),
    );
  } catch {
    return;
  }
}

/**
 * 세션 하나가 평생 읽을 Fleet 플러그인 트리를 확보한다.
 *
 * 예전의 고정 경로(`marketplace/plugins/fleet-gateway`)는 런치마다 삭제 후 교체됐는데, 훅은
 * `${CLAUDE_PLUGIN_ROOT}`를 이벤트 시점마다 디스크에서 다시 해석하므로 나중 런치가 실행 중인
 * 모든 세션의 정책 훅·스킬·정체성 파일을 바꿔치기했다 — 강제 표면이 조용히 죽는 구조였다.
 * 지금은 세션 id가 곧 디렉터리 이름이고, 세션은 자기 트리만 읽는다.
 *
 * 저장소 락은 이 패키지가 직접 잡는다. 락은 발행·회수의 원자성을 지탱하는 유일한 장치인데,
 * 그 구현을 호스트에서 받으면 런타임마다 다른 락(또는 락 없음)이 같은 트리를 만지게 된다.
 */
export async function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): Promise<AgentCliPlugin> {
  const fleetRoot = options.dataDir ?? getFleetDataDir();
  const sessionsRoot = pluginSessionsRoot(fleetRoot, options.cwd);
  const files = buildAssetPluginFiles(assetBundle, options);
  const lease = withDirectoryLock(
    { lockDir: `${sessionsRoot}${SESSIONS_LOCK_SUFFIX}` },
    () => acquirePluginSession(sessionsRoot, options.sessionId, files),
  );
  // 레거시 트리는 이 코드가 읽지도 쓰지도 않지만, 남겨 두면 한 호스트에 Fleet 플러그인
  // 트리가 둘이 된다. 렌더 경로에 붙여 두어 구버전 런치가 끊긴 뒤 자연히 걷히게 한다.
  reclaimLegacyMarketplace(fleetRoot, options.legacyReclaimDeps ?? {});
  return {
    pluginRoot: lease.pluginRoot,
    pluginRoots: [lease.pluginRoot],
    sessionId: lease.sessionId,
  };
}
