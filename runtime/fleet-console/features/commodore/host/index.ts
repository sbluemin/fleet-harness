import fs from "node:fs";
import { createCommodoreDeletion, type CommodoreDeletionHost } from "./deletion.js";
export type { CommodoreDeletionHost } from "./deletion.js";
import type { ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import { EMPTY_RUN_TOTALS } from "../shared/contracts/types.js";
import { CommodoreStoreError } from "./errors.js";
import { createCommodoreOwnership } from "./ownership.js";
export { createCommodoreOwnership } from "./ownership.js";
export { migrateCommodoreAliases } from "./alias-migration.js";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { AttachmentHost } from "../../execution/shared/agent.js";
import type { ModelRosterHost } from "../../ai-gateway/host/model-ports.js";
import type { ExperimentsHost } from "../../settings/shared/experiment-ports.js";
import type { EventPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import path from "node:path";
import type { CommodoreBoardAdapter, CommodoreBoardHost } from "../../objectives/shared/commodore-board.js";
import type { CommodoreEvent } from "../shared/contracts/types.js";
import { DEFAULT_EXPERIMENT_SETTINGS } from "../../settings/shared/experiments.js";
import type { McpServerTools } from "../../execution/shared/admiral-mcp.js";
import { createConsoleResidentAgentHost, type ConsoleResidentAgentDeps } from "../../execution/host/agent/console-resident.js";
import { createCommodoreRoutes, commodoreActive } from "./routes.js";
import { createCommodoreStore } from "./store.js";
import { createCommodoreSupervisor } from "./supervisor.js";
import { COMMODORE_CHANNEL } from "../shared/contracts/types.js";

export interface CommodoreFeatureDeps {
  readonly deletion?: CommodoreDeletionHost;
  readonly ownership?: ReturnType<typeof createCommodoreOwnership>;
  readonly created?: (commodoreId: string) => void;
  readonly beforeTheatersChange?: (commodoreId: string) => void;
  /** Console 단위 설정 저장소의 주입 포트. 엔티티의 strict state에는 표시 순서를 쓰지 않는다. */
  readonly order?: { readonly read: () => readonly string[]; readonly write: (commodoreIds: readonly string[]) => void };
  readonly identityChanged?: (theaterIds: readonly string[]) => void;
  readonly paths: WorkspacePaths;
  readonly events: EventPort;
  readonly experiments: (ExperimentsHost | undefined);
  readonly models: (ModelRosterHost | undefined);
  readonly attachments: (AttachmentHost | undefined);
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  readonly agent: ConsoleResidentAgentDeps;
  /** 이 사령관에 묶은 지식 도구(`admiralMcp.bindCommodore`). */
  readonly knowledgeTools: (commodoreId: string) => readonly McpServerTools[];
}

/** Console 조합이 소유하는 UUID 엔티티와 비영속 상주 실행. */
export function createCommodoreFeature(deps: CommodoreFeatureDeps) {
  let board: CommodoreBoardAdapter | null = null;
  let restored = false;
  let disposed = false;
  const ownership = deps.ownership ?? createCommodoreOwnership(deps.paths);
  const { entities, resolve, resolveAll, theaterIds, knowledge } = ownership;
  const releaseChannel = deps.events.registerSseChannel(COMMODORE_CHANNEL);
  const agent = createConsoleResidentAgentHost(deps.agent);
  const emit = (event: CommodoreEvent) => {
    deps.events.publish(COMMODORE_CHANNEL, event);
    if (event.op === "state" && event.change === "alias") deps.identityChanged?.(event.theaterIds);
  };
  const store = createCommodoreStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: theaterIds, replaceTheatersInIndex: entities.replaceTheatersInIndex, emit });
  const supervisor = createCommodoreSupervisor({
    store, agent, board: () => board, theaterIds, cwd: entities.dirOf, isDeleting: ownership.isDeleting,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    experiments: () => deps.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS,
    ...(deps.experiments?.subscribe ? { subscribeExperiments: deps.experiments.subscribe } : {}),
    ...(deps.models ? { models: deps.models } : {}),
    theater: (theaterId) => { const root = deps.paths.resolveTheaterPath(theaterId); return root ? { label: path.basename(root) || root, root } : null; },
    knowledgeTools: deps.knowledgeTools,
    emit,
  });
  const host: CommodoreBoardHost = {
    registerBoard(adapter) {
      if (disposed) throw new Error("commodore_disposed");
      if (board) throw new Error("commodore_board_registered");
      board = adapter;
      if (restored) supervisor.sync("restart");
      return () => { if (board === adapter) { board = null; supervisor.sync(); } };
    },
    commander(id) {
      const state = id ? store.read(id) : null;
      return state?.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : null;
    },
  };
  const context = { host: { experiments: deps.experiments, attachments: deps.attachments, http: deps.http, security: deps.security } };
  const summary = (commodoreId: string): ConsoleCommodoreSummary => {
    const state = store.read(commodoreId);
    if (!state) throw new CommodoreStoreError("commodore_unavailable");
    const theaters = ownership.theaterSummaries(commodoreId);
    const active = board !== null && commodoreActive(context, store, commodoreId);
    const last = store.transcriptLast(commodoreId);
    return { commodoreId, ...(state.alias ? { alias: state.alias } : {}), label: state.alias ?? theaters[0]?.label ?? "Commodore", theaters, active, run: { ...(supervisor.status(commodoreId) ?? { phase: active ? "idle" : "off" }), totals: state.run ?? EMPTY_RUN_TOTALS }, ...(last ? { last } : {}) };
  };
  const orderedIds = (): readonly string[] => {
    const ids = entities.ids();
    const known = new Set(ids);
    return [...new Set([...(deps.order?.read() ?? []).filter((id) => known.has(id)), ...ids])];
  };
  const deletion = deps.deletion ? createCommodoreDeletion({ ownership, store, supervisor, host: deps.deletion, consoleDataDir: deps.paths.consoleDataDir, summary,
    protectedDirectories: () => [...entities.ids().flatMap((id) => entities.theatersOf(id).map((row) => row.path)), ...(deps.paths.listTheaterIds?.() ?? []).flatMap((id) => { const root = deps.paths.resolveTheaterPath(id); return root ? [root] : []; })],
    removing: (commodoreId, ids) => emit({ op: "removing", commodoreId, theaterIds: ids }),
    removed: (commodoreId, ids) => { emit({ op: "removed", commodoreId, theaterIds: ids }); deps.identityChanged?.(ids); },
  }) : undefined;
  const routes = createCommodoreRoutes(context, store, {
    deletion, assertWritable: ownership.assertWritable,
    resolve, resolveAll, theaterIds, summary, list: () => orderedIds().map(summary),
    setOrder: (requested) => {
      if (!deps.order) throw new CommodoreStoreError("commodore_unavailable");
      const known = new Set(entities.ids());
      const next = [...new Set(requested.filter((id) => known.has(id)))];
      const previous = deps.order.read();
      if (next.length === previous.length && next.every((id, index) => id === previous[index])) return;
      deps.order.write(next);
      // 순서는 Console 전체의 투영이다. 기존 state 사건 하나로 목록을 무효화하되 엔티티 파일은 쓰지 않는다.
      const first = orderedIds()[0];
      const state = first ? store.read(first) : null;
      if (first && state) emit({ op: "state", commodoreId: first, theaterIds: theaterIds(first), state, change: "order" });
    },
    create: (alias) => { const id = ownership.create(); deps.created?.(id); store.setAlias(id, alias); store.announceCreated(id); return id; },
    changeTheater: (id, theaterId, add) => {
      try { deps.beforeTheatersChange?.(id); } catch { throw new CommodoreStoreError("objective_owner_recovery_required"); }
      const before = theaterIds(id);
      const rows = entities.theatersOf(id);
      if (add) {
        const root = deps.paths.resolveTheaterPath(theaterId);
        if (!root) throw new CommodoreStoreError("theater_unavailable");
        const canonical = fs.realpathSync.native(root);
        if (!fs.statSync(canonical).isDirectory()) throw new CommodoreStoreError("theater_unavailable");
        if (!rows.some((row) => row.path === canonical)) store.setTheaters(id, [...rows, { path: canonical }]);
      } else {
        store.setTheaters(id, rows.filter((row, index) => before[index] !== theaterId && deps.paths.workspaceHash(row.path) !== theaterId));
      }
      deps.identityChanged?.([...new Set([...before, ...theaterIds(id)])]);
    },
    acceptsMessage: (id) => supervisor.acceptsMessage(id),
    run: (id) => supervisor.status(id), retry: (id) => supervisor.retry(id), clear: (id) => supervisor.clear(id),
    boardReady: () => board !== null,
    objective: (id) => {
      for (const commodoreId of entities.ids()) {
        const found = board?.objective(commodoreId, id);
        if (found) return found;
      }
      return null;
    },
  });
  return {
    host,
    identity(theaterId: string): { readonly id: string; readonly alias?: string } | null {
      const id = resolve(theaterId);
      if (!id) return null;
      const state = store.read(id);
      return state ? { id, ...(state.alias ? { alias: state.alias } : {}) } : null;
    },
    knowledge,
    routes,
    active: (theaterId: string) => { const id = resolve(theaterId); return board !== null && id !== null && commodoreActive(context, store, id); },
    sync: () => { ownership.recoverKnowledge(); restored = true; supervisor.sync("restart"); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { await agent.dispose(); releaseChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
