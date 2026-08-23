import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { removePrivatePath } from "./fs.js";
import type { LegacyMarketplaceReclaimDeps } from "../types.js";

/**
 * Fleet이 예전에 플러그인을 렌더하던 자리. 지금은 아무것도 읽거나 쓰지 않는다.
 *
 * 이 트리는 런치마다 삭제 후 재작성되는 **공유** 디렉터리였고, 훅이
 * `${CLAUDE_PLUGIN_ROOT}`를 이벤트 시점마다 다시 해석하는 탓에 나중 런치가 실행 중인 세션의
 * 정책 훅을 조용히 갈아치웠다. 세션 단위 트리로 옮긴 뒤 남은 잔해를 여기서 걷는다.
 */
const MARKETPLACE_DIR_NAME = "marketplace";
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
 * 최근에 렌더된 흔적이 있으면 손대지 않는 창.
 *
 * 이 트리를 쥔 구버전 세션이 살아 있는지 물어볼 방법이 없다 — 구버전은 홀더를 남기지 않는다.
 * 대신 그 세션이 남긴 유일한 신호를 읽는다: 렌더 시각. 구버전 CLI는 런치할 때마다 이 트리를
 * 다시 쓰므로, 오래 전 흔적만 남았다는 것은 그동안 구버전 런치가 없었다는 뜻이다.
 */
const LEGACY_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type { LegacyMarketplaceReclaimDeps } from "../types.js";

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
export function reclaimLegacyMarketplace(
  fleetRoot: string,
  deps: LegacyMarketplaceReclaimDeps = {},
): void {
  const now = deps.now ?? Date.now;
  const staleAfterMs = deps.staleAfterMs ?? LEGACY_STALE_AFTER_MS;
  try {
    const marketplaceRoot = path.join(fleetRoot, MARKETPLACE_DIR_NAME);
    if (!existsSync(marketplaceRoot)) return;
    if (now() - lastRenderedAt(marketplaceRoot) <= staleAfterMs) return;
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

/**
 * Fleet이 이 트리를 마지막으로 렌더한 시각.
 *
 * 없는 항목은 건너뛴다 — 하나도 없으면 0이 되어 "아주 오래됨"으로 읽히고, 실제로 걷을 것도
 * 남은 껍데기뿐이다. 반대로 **있는데 읽을 수 없는** 항목은 지금 렌더된 것으로 취급한다:
 * 불확실을 삭제로 해소하지 않는다.
 */
function lastRenderedAt(marketplaceRoot: string): number {
  const candidates = [
    ...FLEET_RENDERED_ENTRIES.map((entry) => path.join(marketplaceRoot, entry)),
    ...FLEET_RENDERED_PLUGIN_DIRS.map((entry) => path.join(marketplaceRoot, MARKETPLACE_PLUGINS_DIR_NAME, entry)),
  ];
  let newest = 0;
  for (const candidate of candidates) {
    try {
      newest = Math.max(newest, statSync(candidate).mtimeMs);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      return Number.POSITIVE_INFINITY;
    }
  }
  return newest;
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
