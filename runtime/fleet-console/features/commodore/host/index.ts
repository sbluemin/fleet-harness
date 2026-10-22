import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
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
import { hasLegacyKnowledge, legacyKnowledgeSources } from "./knowledge-sources.js";
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
  /** 이 사령관에 묶은 지식 도구(`admiralMcp.bindCommodore`). */
  readonly knowledgeTools: (commodoreId: string) => readonly PluginMcpServerTools[];
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
    // 옛 이름은 손실 변환이라 다른 경로와 겹칠 수 있다. 그때도 구 기록을 가리는 새 UUID보다 함께 보류하는 쪽이 안전하다.
    const unresolvedWorkspace = workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name));
    if (migration.blockedPaths.has(root) || unresolvedWorkspace) throw new CommodoreStoreError("commodore_migration_pending");
    return entities.create(root);
  };
  const ensureRegistered = () => {
    for (const theaterId of deps.paths.listTheaterIds?.() ?? []) {
      try { create(theaterId); }
      catch { console.warn(`[commodore] registered theater ${theaterId}: entity unavailable`); }
    }
  };
  ensureRegistered();
  /**
   * 지식 쪽 발급. 사령관 이주가 보류된 경로에도 새 UUID를 낸다 — 위키를 열기 위해 옛 사령관 기록의 자동 이주 길을 포기하는 것은
   * 사람이 고른 정책이다(다음 기동의 사령관 이주는 그 기록을 theater_conflict로 보존한다).
   */
  // `entities.create`는 이미 연결된 경로면 그 id를 돌려준다(보류 검사만 거치지 않는다).
  const issueForKnowledge = (root: string): string => entities.create(root);
  // 기동 이주는 사령관마다 돈다. 옮길 옛 위키가 있는데 사령관이 없는 경로에는 여기서 먼저 발급해 그 위키도 이번 기동에 옮긴다.
  for (const theaterId of deps.paths.listTheaterIds?.() ?? []) {
    const root = deps.paths.resolveTheaterPath(theaterId);
    if (!root || entities.resolve(theaterId) || !hasLegacyKnowledge(deps.paths.consoleDataDir, root)) continue;
    try { issueForKnowledge(root); console.warn(`[commodore] registered theater ${theaterId}: entity issued for knowledge; pending records preserved`); }
    catch { console.warn(`[commodore] registered theater ${theaterId}: knowledge entity unavailable`); }
  }
  const knowledge = {
    directory: (commodoreId: string) => entities.dirOf(commodoreId),
    root: (commodoreId: string) => { const dir = entities.dirOf(commodoreId); return dir ? path.join(dir, "knowledge") : null; },
    ids: () => entities.ids().filter((id) => entities.dirOf(id) !== null),
    /** 화면·세션 맥락(등록 Theater)의 사령관. 없으면 발급한다. 모르는 맥락은 거부한다. */
    forContext(theaterId: string): { readonly ok: true; readonly commodoreId: string } | { readonly ok: false; readonly reason: "unknown_context" | "unavailable" } {
      const root = deps.paths.resolveTheaterPath(theaterId);
      if (!root) return { ok: false, reason: "unknown_context" };
      try { return { ok: true, commodoreId: entities.resolve(theaterId) ?? issueForKnowledge(root) }; }
      catch { return { ok: false, reason: "unavailable" }; }
    },
    legacySources: (commodoreId: string) => legacyKnowledgeSources(deps.paths.consoleDataDir, entities.theatersOf(commodoreId).map((link) => link.path)),
  };
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
    knowledge,
    routes,
    active: (theaterId: string) => { const id = entities.resolve(theaterId); return board !== null && id !== null && commodoreActive(context, store, id); },
    reattach: () => supervisor.reattach(),
    sync: () => { ensureRegistered(); restored = true; supervisor.sync("restart"); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { if (deps.agent.hostedExecution?.isDetached) await supervisor.detach(); else await supervisor.dispose(); }
      finally { await agent.dispose(); releaseChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
