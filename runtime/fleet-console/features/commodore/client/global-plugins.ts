import { useEffect, useSyncExternalStore } from "react";
import type { ClientConsoleEventsCapability } from "../../workspace/shared/navigation-ports.js";
import type { GlobalPluginsView } from "../shared/contracts/plugins.js";
import type { CommodoreEvent } from "../shared/contracts/types.js";
import { COMMODORE_CHANNEL, postCommodorePlugins } from "./commodore-state.js";

interface GlobalPluginsState {
  readonly view: GlobalPluginsView | null;
  readonly error: string | null;
}
let state: GlobalPluginsState = { view: null, error: null };
let inflight: Promise<void> | null = null;
let revision = 0;
let active = false;
const listeners = new Set<() => void>();
function publish(next: GlobalPluginsState): void {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 사건이 읽기와 겹치면 낡은 응답을 적용하지 않고 한 번 더 읽는다. 목록 응답이 진실이다. */
export function loadGlobalPlugins(): Promise<void> {
  if (!active) return Promise.resolve();
  if (inflight) return inflight;
  const started = revision;
  inflight = postCommodorePlugins<GlobalPluginsView>("/commodore/plugins/global/list", {})
    .then((view) => { if (started === revision) publish({ view, error: null }); }, (error) => {
      if (started === revision) publish({ ...state, error: error instanceof Error ? error.message : "failed" });
    }).finally(() => {
      inflight = null;
      if (started !== revision) void loadGlobalPlugins();
    });
  return inflight;
}
export function useGlobalPlugins(): GlobalPluginsState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => { void loadGlobalPlugins(); }, []);
  return snapshot;
}
export async function setGlobalPlugin(pluginId: string, installed: boolean, trusted = false): Promise<void> {
  const view = await postCommodorePlugins<GlobalPluginsView>("/commodore/plugins/global/set", { pluginId, installed, ...(trusted ? { trusted: true } : {}) });
  revision += 1;
  publish({ view, error: null });
}
export function installGlobalPlugins(events: ClientConsoleEventsCapability): () => void {
  active = true;
  const refresh = () => { revision += 1; void loadGlobalPlugins(); };
  const off = events.subscribe(COMMODORE_CHANNEL, (payload) => {
    const event = payload as CommodoreEvent | null;
    if (event?.op === "global-plugins" || event?.op === "state" && event.change === "plugins" || event?.op === "removed") refresh();
  });
  const offReconnect = events.onReconnect?.(refresh);
  refresh();
  return () => { off(); offReconnect?.(); active = false; revision += 1; publish({ view: null, error: null }); };
}
