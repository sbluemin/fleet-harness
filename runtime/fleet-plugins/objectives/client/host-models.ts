import type { HostSurfaceContext } from "@fleet-console/sdk/host-context";
import type { ClientModelsCapability } from "@fleet-console/sdk/plugin";
import { MODEL_ROSTER_PATH, parseModelRoster, type ModelRoster, type ModelRosterTarget } from "@fleet-console/sdk/models";

/** 선택한 host의 고정 scope만 읽는다. 로컬 설치 로스터를 대체하거나 공유하지 않는다. */
export function createHostModels(context: HostSurfaceContext): ClientModelsCapability {
  const signal = context.transport.scope.signal;
  const values = new Map<ModelRosterTarget, ModelRoster>();
  const flights = new Map<ModelRosterTarget, Promise<ModelRoster>>();
  const listeners = new Set<() => void>();
  const load = (target: ModelRosterTarget): Promise<ModelRoster> => {
    signal.throwIfAborted();
    const pending = flights.get(target);
    if (pending) return pending;
    const work = (async () => {
      const response = await context.transport.request(`${MODEL_ROSTER_PATH}?target=${target}`, { signal });
      if (!response.ok) throw new Error(`model_roster_http_${response.status}`);
      const body = await response.json() as { readonly roster?: unknown };
      signal.throwIfAborted();
      const roster = parseModelRoster(body.roster);
      values.set(target, roster);
      for (const listener of listeners) listener();
      return roster;
    })();
    flights.set(target, work);
    void work.finally(() => { if (flights.get(target) === work) flights.delete(target); }).catch(() => undefined);
    return work;
  };
  signal.addEventListener("abort", () => { values.clear(); listeners.clear(); flights.clear(); }, { once: true });
  return {
    read: (target) => values.get(target) ?? null,
    load,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => { for (const target of values.keys()) void load(target).catch(() => undefined); },
  };
}
