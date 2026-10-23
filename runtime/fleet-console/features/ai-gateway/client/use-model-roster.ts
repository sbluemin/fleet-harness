import * as React from "react";
import type { ModelRoster, ModelRosterTarget } from "../shared/models.js";
import type { ClientModelsCapability } from "../shared/model-ports.js";
/**
 * 모델 로스터 구독 — 마운트(와 대상 변경)가 읽기를 시작하고, 로스터가 바뀌면 다시 그린다. 읽기 전에는 null이다.
 * 스냅샷은 캐시만 본다 — 읽기 시작은 렌더 밖(effect)에서 한다.
 */
export function useModelRoster(models: ClientModelsCapability | null | undefined, target: ModelRosterTarget): ModelRoster | null {
  React.useEffect(() => {
    void models?.load(target).catch(() => undefined);
  }, [models, target]);
  const subscribe = React.useCallback((listener: () => void) => models?.subscribe(listener) ?? (() => undefined), [models]);
  return React.useSyncExternalStore(subscribe, () => models?.read(target) ?? null, () => null);
}
