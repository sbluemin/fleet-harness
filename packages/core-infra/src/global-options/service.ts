import { createGlobalOptionsStore } from "./store.js";
import type { GlobalOptionsData, GlobalOptionsService, GlobalOptionsStore } from "./types.js";

interface CreateGlobalOptionsServiceDeps {
  readonly store?: GlobalOptionsStore;
  readonly dataDir?: string;
}

export function createGlobalOptionsService(deps: CreateGlobalOptionsServiceDeps = {}): GlobalOptionsService {
  const store = deps.store ?? createGlobalOptionsStore({ dataDir: deps.dataDir });

  return {
    load: () => store.load(),
    save: (data) => {
      store.save(data);
      return store.load();
    },
    update: (mutate) => updateGlobalOptions(store, mutate),
  };
}

function updateGlobalOptions(
  store: GlobalOptionsStore,
  mutate: (current: GlobalOptionsData) => GlobalOptionsData,
): GlobalOptionsData {
  return store.update(mutate);
}
