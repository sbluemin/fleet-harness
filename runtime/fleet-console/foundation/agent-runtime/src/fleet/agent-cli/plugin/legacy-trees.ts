import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { removePrivatePath } from "./fs.js";

/**
 * Fleet이 예전에 플러그인을 렌더하던 자리. 지금은 아무것도 읽거나 쓰지 않는다.
 *
 * 이 트리는 런치마다 삭제 후 재작성되는 **공유** 디렉터리였고, 훅이
 * `${CLAUDE_PLUGIN_ROOT}`를 이벤트 시점마다 다시 해석하는 탓에 나중 런치가 실행 중인 세션의
 * 정책 훅을 조용히 갈아치웠다. 세션 단위 트리로 옮긴 뒤 남은 잔해를 여기서 걷는다.
 */
const MARKETPLACE_DIR_NAME = "marketplace";
/**
 * 하네스 트리가 Console 슬롯으로 내려오기 전에 살던 자리(`<Fleet 루트>/harness`). 이 트리는
 * 통째로 Fleet이 렌더한 것이라 사용자 파일이 섞이지 않는다 — 조건을 만족하면 통째로 걷는다.
 */
const LEGACY_HARNESS_DIR_NAME = "harness";
const MARKETPLACE_PLUGINS_DIR_NAME = "plugins";
/** Fleet이 렌더했던 것만 지운다. 이 트리에는 사용자가 직접 둔 파일이 함께 살 수 있다. */
const FLEET_RENDERED_ENTRIES = [
  ".claude-plugin",
  ".cursor-plugin",
  "hooks",
  "skills",
  "agents",
  "mcp.json",
  "claude",
] as const;
const FLEET_RENDERED_PLUGIN_DIRS = ["fleet-gateway"] as const;
/**
 * 옛 자리는 지금 자리를 아는 버전이 뜨는 순간 잔해다. 렌더 시각을 보고 기다리던 유예는
 * 없앴다 — 그 유예는 같은 기계에서 구버전 Console이 계속 돌고 있다는 전제 위에 있었고,
 * Fleet Console을 직접 개발하지 않는 사용자에게는 구버전을 계속 쓸 동선이 없다. 기다리는
 * 동안 사용자는 자기 데이터 루트에서 아무도 읽지 않는 트리 두 벌을 본다.
 */


/**
 * 레거시 트리에서 Fleet이 쓴 것만 걷는다. best-effort이며 어떤 실패도 런치를 막지 않는다.
 *
 * 통째로 지우지 않는 이유는 두 가지다. 이 트리에는 사용자가 직접 둔 파일이 함께 살 수 있고,
 * 패치할 수 없는 구버전 CLI가 지금도 여기에 자기 것을 렌더한다 — 그래서 이 회수는 한 번으로
 * 끝나는 이주가 아니라 런치마다 다시 도는 정리다. 구버전이 다시 만들어 두면 다음 런치가
 * 다시 걷는다.
 *
 * 구버전 세션이 **살아 있는 동안** 걷으면 그 세션이 이 함수가 고치려는 바로 그 사고를
 * 겪는다. 그것을 직접 물을 수 없으므로 렌더 시각으로 대신 판단한다.
 */
/**
 * Fleet이 예전에 트리를 렌더하던 자리들을 걷는다. best-effort이며 어떤 실패도 런치를 막지 않는다.
 *
 * `legacyRoot`는 Fleet 데이터 루트다 — 지금 트리가 사는 Console 슬롯이 아니라, 그 이전 자리들의
 * 부모. 두 자리 모두 같은 staleness 창을 쓴다: 그 트리를 쥔 구버전 세션이 살아 있는지 물어볼
 * 방법이 없으므로 마지막 렌더 시각으로 대신 판단한다.
 */
export function reclaimLegacyTrees(legacyRoot: string): void {
  reclaimLegacyHarness(legacyRoot);
  reclaimLegacyMarketplace(legacyRoot);
}

/**
 * 하네스 트리가 루트에 남아 있던 자리를 걷는다. 통째로 Fleet 렌더라 항목을 가려 지우지 않지만,
 * 구버전 Console이 아직 여기에 렌더하고 있을 수 있으므로 같은 staleness 창을 지킨다.
 */
function reclaimLegacyHarness(legacyRoot: string): void {
  try {
    const harnessRoot = path.join(legacyRoot, LEGACY_HARNESS_DIR_NAME);
    if (!existsSync(harnessRoot)) return;
    removeBestEffort(harnessRoot, legacyRoot);
  } catch {
    return;
  }
}

function reclaimLegacyMarketplace(fleetRoot: string): void {
  try {
    const marketplaceRoot = path.join(fleetRoot, MARKETPLACE_DIR_NAME);
    if (!existsSync(marketplaceRoot)) return;
    for (const entry of FLEET_RENDERED_ENTRIES) {
      removeBestEffort(path.join(marketplaceRoot, entry), marketplaceRoot);
    }
    const pluginsRoot = path.join(marketplaceRoot, MARKETPLACE_PLUGINS_DIR_NAME);
    if (!existsSync(pluginsRoot)) return;
    for (const directoryName of FLEET_RENDERED_PLUGIN_DIRS) {
      removeBestEffort(path.join(pluginsRoot, directoryName), marketplaceRoot);
    }
    // 비워진 껍데기만 남으면 함께 걷는다. 사용자 파일이 하나라도 남아 있으면 그대로 둔다.
    removeIfEmpty(pluginsRoot, marketplaceRoot);
    removeIfEmpty(marketplaceRoot, fleetRoot);
  } catch {
    return;
  }
}

function removeBestEffort(targetPath: string, rootBase: string): void {
  try {
    removePrivatePath(targetPath, rootBase);
  } catch {
    return;
  }
}

function removeIfEmpty(targetPath: string, rootBase: string): void {
  try {
    if (readdirSync(targetPath).length > 0) return;
    removePrivatePath(targetPath, rootBase);
  } catch {
    return;
  }
}
