import { createCommodoreOwnership } from "./ownership.js";
export { createCommodoreOwnership } from "./ownership.js";
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
  readonly ownership?: ReturnType<typeof createCommodoreOwnership>;
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
  const { entities, create, ensureRegistered, knowledge } = deps.ownership ?? createCommodoreOwnership(deps.paths);
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
  const host: CommodoreBoardHost = {
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
    acceptsMessage: (id) => supervisor.acceptsMessage(id),
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
    sync: () => { ensureRegistered(); restored = true; supervisor.sync("restart"); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { await agent.dispose(); releaseChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
