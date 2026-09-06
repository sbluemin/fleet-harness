import type { ExperimentModelOption } from "@fleet-console/sdk/settings";
import { CLAUDE_EXPERIMENT_MODEL_OPTIONS } from "@fleet-console/sdk/settings/browser";

import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

/**
 * 레지스트리는 React 컨텍스트라 훅 밖에서 읽을 수 없다. app 셸이 레지스트리를 실을 때 이 스냅샷을
 * 함께 갱신한다(설정 검색의 syncSettingsSearchPlugins와 같은 관례). 호스트 번들 안의 모듈 상태다.
 */
let pluginsSnapshot: readonly Pick<FleetClientPlugin, "experimentModelOptions">[] = [];

export function syncExperimentModelOptionPlugins(plugins: typeof pluginsSnapshot): void {
  pluginsSnapshot = plugins;
}

/**
 * 실험 기능의 모델 선택지 — Claude 별칭 + 등록된 플러그인이 내놓는 Gateway 모델. 코어 카드와
 * 플러그인 카드가 같은 목록을 보도록 한 함수가 만든다. 플러그인 응답이 늦거나 실패해도 별칭은 항상 선다.
 */
export async function collectExperimentModelOptions(): Promise<readonly ExperimentModelOption[]> {
  const providers = pluginsSnapshot.flatMap((plugin) => plugin.experimentModelOptions ? [plugin.experimentModelOptions] : []);
  const lists = await Promise.all(providers.map((provider) => provider().catch(() => [] as readonly ExperimentModelOption[])));
  const seen = new Set<string>();
  const merged: ExperimentModelOption[] = [];
  for (const option of [...CLAUDE_EXPERIMENT_MODEL_OPTIONS, ...lists.flat()]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }
  return merged;
}
