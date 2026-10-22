import path from "node:path";
import type { CommodoreBoardAdapter, CommodoreEvent, FleetPluginCommodoreHost } from "@fleet-console/sdk/commodore";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { PluginMcpServerTools } from "@fleet-console/sdk/mcp";
import { createConsoleResidentAgentHost, type ConsoleResidentAgentDeps } from "../../execution/host/agent/console-resident.js";
import { createCommodoreRoutes, commodoreActive } from "./routes.js";
import { createCommodoreStore } from "./store.js";
import { createCommodoreSupervisor } from "./supervisor.js";
import { createCommodoreEntities } from "./entities.js";
import { migrateCommodoreData } from "./migrate.js";
import { CommodoreStoreError } from "./errors.js";
import { COMMODORE_CHANNEL } from "./types.js";

export interface CommodoreFeatureDeps {
  readonly paths: FleetPluginHostCapabilities["paths"];
  readonly events: FleetPluginHostCapabilities["events"];
  readonly experiments: FleetPluginHostCapabilities["experiments"];
  readonly models: FleetPluginHostCapabilities["models"];
  readonly attachments: FleetPluginHostCapabilities["attachments"];
  readonly http: FleetPluginHostCapabilities["http"];
  readonly security: FleetPluginHostCapabilities["security"];
  readonly agent: ConsoleResidentAgentDeps;
  readonly knowledgeTools: (theaterId: string) => readonly PluginMcpServerTools[];
}

/** Console 조합이 소유하는 UUID 엔티티와 비영속 상주 실행. */
export function createCommodoreFeature(deps: CommodoreFeatureDeps) {
  let board: CommodoreBoardAdapter | null = null;
  let restored = false;
  let disposed = false;
  // 슬롯 lock을 획득한 조합이 부른다. 이동 → 색인 → 선제 발급 순서를 바꾸면 빈 UUID가 구 기록을 가린다.
  const migration = migrateCommodoreData(deps.paths.consoleDataDir);
  const entities = createCommodoreEntities(path.join(deps.paths.consoleDataDir, "commodore"), deps.paths.workspaceHash);
  const create = (theaterId: string) => {
    const root = deps.paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    const existing = entities.resolve(theaterId);
    if (existing) return existing;
    if (migration.blockedPaths.has(root)) throw new CommodoreStoreError("commodore_migration_pending");
    return entities.create(root);
  };
  const ensureRegistered = () => {
    for (const theaterId of deps.paths.listTheaterIds?.() ?? []) {
      try { create(theaterId); }
      catch { console.warn(`[commodore] registered theater ${theaterId}: entity unavailable`); }
    }
  };
  ensureRegistered();
  const releaseChannel = deps.events.registerSseChannel(COMMODORE_CHANNEL);
  const agent = createConsoleResidentAgentHost(deps.agent);
  const emit = (event: CommodoreEvent) => deps.events.publish(COMMODORE_CHANNEL, event);
  const store = createCommodoreStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, emit });
  const supervisor = createCommodoreSupervisor({
    store, agent, board: () => board, theaterIds: entities.theaterIds, cwd: entities.dirOf,
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
      const id = entities.resolve(theaterId);
      const state = id ? store.read(id) : null;
      return state?.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : null;
    },
  };
  const context = { host: { experiments: deps.experiments, attachments: deps.attachments, http: deps.http, security: deps.security } };
  const routes = createCommodoreRoutes(context, store, {
    resolve: entities.resolve, create, theaterIds: entities.theaterIds,
    run: (id) => supervisor.status(id), retry: (id) => supervisor.retry(id), clear: (id) => supervisor.clear(id),
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
    active: (theaterId: string) => { const id = entities.resolve(theaterId); return board !== null && id !== null && commodoreActive(context, store, id); },
    sync: () => { ensureRegistered(); restored = true; supervisor.sync("restart"); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { await agent.dispose(); releaseChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
