import path from "node:path";

import { withDirectoryLock } from "@dotobokuri/core-infra";
import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";

import { FLEET_HARNESS_VERSION } from "../assets.generated.js";
import { assetBundle, buildAssetPluginFiles } from "./fleet.js";
import { ensurePrivateDir } from "./fs.js";
import { reclaimLegacyMarketplace } from "./legacy-marketplace.js";
import { publishSharedPlugin } from "./shared-store.js";
import type { AgentCliPlugin, CreateAgentCliPluginOptions } from "../types.js";

export type {
  AgentCliPlugin,
  CreateAgentCliPluginOptions,
} from "../types.js";

const PLUGIN_LOCK_SUFFIX = ".lock";
const FLEET_CLAUDE_PLUGIN_PATH = ["harness", "claude"] as const;

/** Fleet 데이터 디렉터리에서 모든 Claude 세션이 공유하는 플러그인 루트. */
export function fleetClaudePluginRoot(dataDir: string): string {
  return path.join(dataDir, ...FLEET_CLAUDE_PLUGIN_PATH);
}

/**
 * 모든 Claude 세션이 읽을 Fleet 플러그인 트리를 렌더한다.
 *
 * 위치는 `<dataDir>/harness/claude` 하나뿐이다. 런치마다 최신 훅·스킬·정체성으로 교체하고,
 * SessionStart additionalContext에는 이 렌더의 Fleet Harness 버전을 남긴다. 저장소 락은 이
 * 패키지가 직접 잡아 Console과 `fleet` 런처가 같은 트리를 동시에 반쯤 쓰지 못하게 한다.
 */
export async function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): Promise<AgentCliPlugin> {
  const fleetRoot = options.dataDir ?? getFleetDataDir();
  const pluginRoot = fleetClaudePluginRoot(fleetRoot);
  const files = buildAssetPluginFiles(assetBundle, options, FLEET_HARNESS_VERSION);
  ensurePrivateDir(path.dirname(pluginRoot), fleetRoot);
  withDirectoryLock(
    { lockDir: `${pluginRoot}${PLUGIN_LOCK_SUFFIX}` },
    () => publishSharedPlugin(fleetRoot, pluginRoot, files),
  );
  // 레거시 트리는 이 코드가 읽지도 쓰지도 않지만, 남겨 두면 한 호스트에 Fleet 플러그인
  // 트리가 둘이 된다. 렌더 경로에 붙여 두어 구버전 런치가 끊긴 뒤 자연히 걷히게 한다.
  reclaimLegacyMarketplace(fleetRoot, options.legacyReclaimDeps ?? {});
  return {
    pluginRoot,
    pluginRoots: [pluginRoot],
  };
}
