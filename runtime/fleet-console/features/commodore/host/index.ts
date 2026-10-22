import path from "node:path";
import type { CommodoreBoardAdapter, CommodoreEvent, FleetPluginCommodoreHost } from "@fleet-console/sdk/commodore";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { PluginMcpServerTools } from "@fleet-console/sdk/mcp";
import { createPluginAgentHost, type PluginAgentDeps } from "../../execution/host/agent/plugin-agent.js";
import { createCommodoreRoutes, commodoreActive } from "./routes.js";
import { createCommodoreStore } from "./store.js";
import { createCommodoreSupervisor } from "./supervisor.js";
import { COMMODORE_CHANNEL } from "./types.js";

export interface CommodoreFeatureDeps {
  readonly paths: FleetPluginHostCapabilities["paths"];
  readonly events: FleetPluginHostCapabilities["events"];
  readonly experiments: FleetPluginHostCapabilities["experiments"];
  readonly models: FleetPluginHostCapabilities["models"];
  readonly attachments: FleetPluginHostCapabilities["attachments"];
  readonly http: FleetPluginHostCapabilities["http"];
  readonly security: FleetPluginHostCapabilities["security"];
  readonly agent: Omit<PluginAgentDeps, "persistRoot">;
  readonly knowledgeTools: (theaterId: string) => readonly PluginMcpServerTools[];
}

/** Console 조합이 소유하는 사령관. PR-A에서는 기존 데이터·대화 자리를 그대로 이어 읽는다. */
export function createCommodoreFeature(deps: CommodoreFeatureDeps) {
  let board: CommodoreBoardAdapter | null = null;
  let restored = false;
  let disposed = false;
  const dirs = new Map<string, string>();
  const unreadable = new Set<string>();
  const dirOf = (theaterId: string): string | null => {
    const cached = dirs.get(theaterId);
    if (cached) return cached;
    const root = deps.paths.resolveTheaterPath(theaterId);
    if (!root) return null;
    try {
      const dir = path.join(deps.paths.ensureWorkspaceDirectory(root).path, "objectives");
      unreadable.delete(theaterId);
      dirs.set(theaterId, dir);
      return dir;
    } catch (error) {
      if (!unreadable.has(theaterId)) console.warn(`[commodore] theater ${theaterId} unreadable: ${error instanceof Error ? error.message : String(error)}`);
      unreadable.add(theaterId);
      return null;
    }
  };
  const releaseChannel = deps.events.registerSseChannel(COMMODORE_CHANNEL);
  const agent = createPluginAgentHost({
    ...deps.agent,
    // 소유 feature가 바뀌어도 기존 key 해시의 홈·cwd·session.json을 재개한다.
    persistRoot: () => path.join(deps.paths.consoleDataDir, "plugins", "objectives", "agent-sessions"),
  });
  const emit = (event: CommodoreEvent) => deps.events.publish(COMMODORE_CHANNEL, event);
  const store = createCommodoreStore({ dirOf, theaterIds: () => deps.paths.listTheaterIds?.() ?? [], emit });
  const supervisor = createCommodoreSupervisor({
    store, agent, board: () => board,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    experiments: () => deps.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS,
    ...(deps.experiments?.subscribe ? { subscribeExperiments: deps.experiments.subscribe } : {}),
    ...(deps.models ? { models: deps.models } : {}),
    theater: (theaterId) => { const root = deps.paths.resolveTheaterPath(theaterId); return root ? { label: path.basename(root) || root, root } : null; },
    knowledgeTools: deps.knowledgeTools,
    emit,
  });
  const host: FleetPluginCommodoreHost = {
    registerBoard(adapter) {
      if (disposed) throw new Error("commodore_disposed");
      if (board) throw new Error("commodore_board_registered");
      board = adapter;
      if (restored) supervisor.sync("restart");
      return () => { if (board === adapter) { board = null; supervisor.sync(); } };
    },
    commander(theaterId) {
      const state = store.read(theaterId);
      return state?.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : null;
    },
  };
  const context = { host: { experiments: deps.experiments, attachments: deps.attachments, http: deps.http, security: deps.security } };
  const routes = createCommodoreRoutes(context, store, {
    run: (theaterId) => supervisor.status(theaterId),
    retry: (theaterId) => supervisor.retry(theaterId),
    clear: (theaterId) => supervisor.clear(theaterId),
    boardReady: () => board !== null,
    objective: (id) => {
      for (const theaterId of deps.paths.listTheaterIds?.() ?? []) {
        const found = board?.objective(theaterId, id);
        if (found) return found;
      }
      return null;
    },
  });
  return {
    host,
    routes,
    active: (theaterId: string) => board !== null && commodoreActive(context, store, theaterId),
    sync: () => { restored = true; supervisor.sync("restart"); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { await agent.dispose(); releaseChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
