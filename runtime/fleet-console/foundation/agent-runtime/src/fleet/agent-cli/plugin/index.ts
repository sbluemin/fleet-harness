import path from "node:path";

import { withDirectoryLock } from "@fleet-console/infra";

import { FLEET_HARNESS_VERSION } from "../assets.generated.js";
import { assetBundle, buildAssetPluginFiles } from "./fleet.js";
import { ensurePrivateDir } from "./fs.js";
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
 * 위치는 호스트가 넘긴 자리 아래 `harness/claude` 하나뿐이다 — Console 슬롯이라 그 인스턴스의
 * 세션들만 이 트리를 공유한다. hooks.json에는 그 설치의 절대 경로가 실리므로, 트리가 인스턴스
 * 바깥에 있으면 다른 설치의 런치가 서로의 훅 경로를 덮어쓴다. 런치마다 최신 훅·스킬·정체성으로 교체하고,
 * SessionStart additionalContext에는 이 렌더의 Fleet Harness 버전을 남긴다. 저장소 락은 이
 * 패키지가 직접 잡아 Console과 `fleet` 런처가 같은 트리를 동시에 반쯤 쓰지 못하게 한다.
 */
export async function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): Promise<AgentCliPlugin> {
  const slotRoot = options.dataDir;
  const pluginRoot = fleetClaudePluginRoot(slotRoot);
  const files = buildAssetPluginFiles(assetBundle, options, FLEET_HARNESS_VERSION);
  ensurePrivateDir(path.dirname(pluginRoot), slotRoot);
  withDirectoryLock(
    { lockDir: `${pluginRoot}${PLUGIN_LOCK_SUFFIX}` },
    () => publishSharedPlugin(slotRoot, pluginRoot, files),
  );
  return {
    pluginRoot,
    pluginRoots: [pluginRoot],
  };
}
