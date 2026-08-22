import path from "node:path";

import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";

import { assetBundle, buildAssetPluginFiles } from "./fleet.js";
import { acquirePluginSnapshot, PLUGIN_SNAPSHOTS_DIR_NAME } from "./snapshot.js";
import type { AgentCliPlugin, CreateAgentCliPluginOptions } from "../types.js";

export type {
  AgentCliPlugin,
  AgentCliPluginStoreLock,
  CreateAgentCliPluginOptions,
} from "../types.js";

/**
 * 세션이 실을 Fleet 플러그인을 불변 스냅숏으로 확보한다.
 *
 * 예전의 고정 경로(`marketplace/plugins/fleet-gateway`)는 런치마다 삭제 후 교체됐는데,
 * 훅은 `${CLAUDE_PLUGIN_ROOT}`를 이벤트 시점마다 디스크에서 다시 해석하므로 나중 런치가
 * 실행 중인 모든 세션의 정책 훅·스킬·정체성 파일을 바꿔치기했다 — 강제 표면이 조용히
 * 죽는 구조였다. 지금은 내용 해시가 디렉터리 이름인 스냅숏을 발행하고, 세션은 자기가
 * 런치한 스냅숏만 평생 읽는다. 버전·로스터가 다르면 해시가 다르므로 새 세션은 항상 자기
 * 내용을 받고, 옛 스냅숏은 리스가 전부 죽은 뒤에야 회수된다. `marketplace/` 트리는 패치할
 * 수 없는 구버전 CLI가 계속 쓰는 레거시 레인으로 남겨 두고 새 코드는 읽지도 쓰지도 않는다.
 */
export async function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): Promise<AgentCliPlugin> {
  const fleetRoot = options.rootDir ?? options.dataDir ?? getFleetDataDir();
  const snapshotsRoot = path.join(fleetRoot, PLUGIN_SNAPSHOTS_DIR_NAME);
  const files = buildAssetPluginFiles(assetBundle, options);
  const lease = await options.withPluginStoreLock(
    snapshotsRoot,
    () => acquirePluginSnapshot(snapshotsRoot, assetBundle.directoryName, files),
  );
  const cleanup = createOnceCleanup(() => lease.release());
  options.onCleanup?.(cleanup);
  return {
    cleanup,
    pluginRoot: lease.snapshotRoot,
    pluginRoots: [lease.snapshotRoot],
  };
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
