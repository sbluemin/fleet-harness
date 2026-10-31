import fs from "node:fs";
import { createCommodoreSidebar, type CommodoreSidebarPersistence } from "./sidebar-layout.js";
import { COMMODORE_SIDEBAR_CHANNEL } from "../shared/contracts/sidebar-layout.js";
import os from "node:os";
import { openClaudeMcpControl } from "@fleet-console/agent-runtime/claude";
import { createCommodorePluginAuth } from "./plugin-auth.js";
import { stripConsoleInternalEnv } from "../../execution/host/terminal/launch-env.js";
import { createKnowledgeFolderAction } from "./knowledge-folder.js";
import type { FolderGrantStore } from "../../workspace/host/theaters/theater-domain.js";
import { ClaudeTrustError, trustClaudeTheater } from "../../workspace/host/theaters/claude-trust.js";
import { createCommodoreDeletion, type CommodoreDeletionHost } from "./deletion.js";
export type { CommodoreDeletionHost } from "./deletion.js";
import type { ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import { EMPTY_RUN_TOTALS } from "../shared/contracts/types.js";
import { CommodoreStoreError } from "./errors.js";
import { createCommodoreOwnership } from "./ownership.js";
export { createCommodoreOwnership } from "./ownership.js";
export { prepareTheaterRegistryRetirement } from "./registry-retirement.js";
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
import { createConsoleResidentAgentHost, type ConsoleResidentAgentDeps } from "../../execution/host/agent/console-resident.js";
import { createCommodoreRoutes, commodoreActive } from "./routes.js";
import { createCommodoreStore } from "./store.js";
import { createCommodoreMessenger } from "./messaging.js";
import { createCommodoreCreator } from "./creation.js";
import { createCommodoreManagementTools } from "./console-tools.js";
import { createCommodorePlugins } from "./plugins.js";
import type { OwnedProcessPort } from "@fleet-console/process";
import { createCommodoreSupervisor } from "./supervisor.js";
import { COMMODORE_CHANNEL } from "../shared/contracts/types.js";

export interface CommodoreFeatureDeps {
  readonly folderGrants?: Pick<FolderGrantStore, "consume">;
  readonly deletion?: CommodoreDeletionHost;
  readonly ownership?: ReturnType<typeof createCommodoreOwnership>;
  readonly created?: (commodoreId: string) => void;
  readonly beforeTheatersChange?: (commodoreId: string) => void;
  /** Console 단위 설정 저장소의 주입 포트. 엔티티의 strict state에는 표시 순서를 쓰지 않는다. */
  readonly order?: { readonly read: () => readonly string[]; readonly write: (commodoreIds: readonly string[]) => void };
  readonly sidebar?: CommodoreSidebarPersistence;
  readonly paths: WorkspacePaths;
  readonly events: EventPort;
  readonly experiments: (ExperimentsHost | undefined);
  readonly models: (ModelRosterHost | undefined);
  readonly attachments: (AttachmentHost | undefined);
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  readonly agent: ConsoleResidentAgentDeps;
  /** 파일 탐색기 실행은 호스트가 주입한다. 클라이언트가 보낸 경로는 받지 않는다. */
  readonly openKnowledgeDirectory?: (directory: string) => Promise<void>;
  /** 마켓플레이스 받기·설치에 쓰는 `claude` CLI 를 Console 수명에 묶어 띄운다. */
  readonly processes?: OwnedProcessPort;
}

/** Console 조합이 소유하는 UUID 엔티티와 비영속 상주 실행. */
export function createCommodoreFeature(deps: CommodoreFeatureDeps) {
  let board: CommodoreBoardAdapter | null = null;
  let restored = false;
  let disposed = false;
  const ownership = deps.ownership ?? createCommodoreOwnership(deps.paths);
  const { entities, theaterIds, knowledge } = ownership;
  const releaseChannel = deps.events.registerSseChannel(COMMODORE_CHANNEL);
  const releaseSidebarChannel = deps.events.registerSseChannel(COMMODORE_SIDEBAR_CHANNEL);
  const agent = createConsoleResidentAgentHost(deps.agent);
  const emit = (event: CommodoreEvent) => {
    deps.events.publish(COMMODORE_CHANNEL, event);
  };
  // 목록을 읽기 전에 연결한다. 등록부가 기본 켜짐을 정할 때 어느 사령관의 state.json `plugins` 든 본다.
  let selectedPlugins = (): readonly string[] => [];
  const plugins = createCommodorePlugins({
    root: path.join(deps.paths.consoleDataDir, "commodore-plugins"),
    executable: deps.agent.resolveExecutablePath,
    selectedPlugins: () => selectedPlugins(),
    ...(deps.processes ? { processes: deps.processes } : {}),
  });
  const store = createCommodoreStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: theaterIds, replaceTheatersInIndex: entities.replaceTheatersInIndex, emit });
  selectedPlugins = () => entities.ids().flatMap((id) => store.read(id)?.plugins ?? []);
  const createFromCommodore = createCommodoreCreator({ ownership, store, ...(deps.created ? { created: deps.created } : {}) });
  const supervisor = createCommodoreSupervisor({
    store, agent, board: () => board, theaterIds, cwd: entities.dirOf, isDeleting: ownership.isDeleting,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    experiments: () => deps.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS,
    ...(deps.experiments?.subscribe ? { subscribeExperiments: deps.experiments.subscribe } : {}),
    ...(deps.models ? { models: deps.models } : {}),
    theater: (commodoreId, theaterId) => {
      const root = ownership.theaterPath(commodoreId, theaterId);
      try { return root && fs.realpathSync.native(root) === root && fs.statSync(root).isDirectory() ? { label: path.basename(root) || root, root } : null; }
      catch { return null; }
    },
    managementTools: (commodoreId, turn) => createCommodoreManagementTools({
      hasPersonMessage: turn.hasPersonMessage, stopping: turn.stopping,
      list: () => orderedIds().map((id) => ({ commodoreId: id, alias: store.read(id)?.alias, theaters: entities.theatersOf(id) })),
      create: (input) => createFromCommodore(commodoreId, input),
      message: (input) => messageFromCommodore(commodoreId, input),
    }),
    plugins: (ids) => plugins.resolve(ids),
    emit,
  });
  /**
   * 키·토큰이 바뀐 플러그인을 고른 사령관 — 고른 목록은 그대로라 저장소 사건이 없으므로 감독자에게 직접 알려 다음 턴을 새 세션
   * (새 환경·새 MCP 연결)으로 연다. 목표 세션은 다음 실행부터 받는다.
   */
  const pluginsChanged = (pluginIds: readonly string[]) => {
    for (const commodoreId of entities.ids()) {
      if ((store.read(commodoreId)?.plugins ?? []).some((id) => pluginIds.includes(id))) supervisor.replaceSessionNext(commodoreId);
    }
  };
  /**
   * 전역 설치 목록이 바뀌었다 — 모든 사령관의 다음 턴을 새 세션으로 열고, 사령관마다 `global-plugins` 사건을
   * 낸다(하단 알약·사령관 섹션이 목록을 다시 읽는다). 목표 세션은 다음 실행부터 받는다(기존과 같은 규칙).
   */
  const globalPluginsChanged = (next: readonly string[]) => {
    const list = [...next];
    for (const commodoreId of entities.ids()) {
      supervisor.replaceSessionNext(commodoreId);
      emit({ op: "global-plugins", commodoreId, theaterIds: theaterIds(commodoreId), plugins: list });
    }
  };
  const pluginAuth = createCommodorePluginAuth({
    servers: (ids) => plugins.authServers(ids),
    env: (ids) => plugins.pluginEnv(ids),
    changed: pluginsChanged,
    control: {
      // 모델 턴 없는 Claude 자식 — 세션들과 같은 기본 보안 저장소 항목에 토큰을 둔다. 홈은 그 자식만의 임시 폴더다.
      async open(servers, env) {
        const executablePath = await deps.agent.resolveExecutablePath();
        const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fleet-plugin-auth-"));
        try {
          const control = openClaudeMcpControl({ executablePath, env: { ...stripConsoleInternalEnv(process.env), ...env }, configDir: path.join(home, "claude"), cwd: home, credentials: "shared", servers });
          return { control, release: () => fs.promises.rm(home, { recursive: true, force: true }) };
        } catch (error) { await fs.promises.rm(home, { recursive: true, force: true }); throw error; }
      },
    },
  });
  const messageFromCommodore = createCommodoreMessenger({ store, assertWritable: ownership.assertWritable, acceptsMessage: (id) => supervisor.acceptsMessage(id) });
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
    const lastResponse = store.transcriptLast(commodoreId, "commodore");
    return { commodoreId, ...(state.alias ? { alias: state.alias } : {}), label: state.alias ?? theaters[0]?.label ?? "Commodore", theaters, active, run: { ...(supervisor.status(commodoreId) ?? { phase: active ? "idle" : "off" }), totals: state.run ?? EMPTY_RUN_TOTALS }, ...(last ? { last } : {}), ...(lastResponse ? { lastResponse } : {}) };
  };
  const orderedIds = (): readonly string[] => {
    const ids = entities.ids();
    const known = new Set(ids);
    return [...new Set([...(deps.order?.read() ?? []).filter((id) => known.has(id)), ...ids])];
  };
  const deletion = deps.deletion ? createCommodoreDeletion({ ownership, store, supervisor, host: deps.deletion, consoleDataDir: deps.paths.consoleDataDir, summary,
    protectedDirectories: () => entities.ids().flatMap((id) => entities.theatersOf(id).map((row) => row.path)),
    removing: (commodoreId, ids) => emit({ op: "removing", commodoreId, theaterIds: ids }),
    removed: (commodoreId, ids) => emit({ op: "removed", commodoreId, theaterIds: ids }),
  }) : undefined;
  const sidebar = createCommodoreSidebar({
    persistence: deps.sidebar, ids: entities.ids, order: orderedIds, assertWritable: ownership.assertWritable,
    changed: () => deps.events.publish(COMMODORE_SIDEBAR_CHANNEL, { op: "changed" }),
  });
  const routes = createCommodoreRoutes(context, store, {
    sidebar, plugins, pluginAuth, pluginsChanged, globalPluginsChanged, deletion, assertWritable: ownership.assertWritable,
    knowledgeFolder: createKnowledgeFolderAction({ root: knowledge.root, ...(deps.openKnowledgeDirectory ? { openDirectory: deps.openKnowledgeDirectory } : {}) }),
    theaterIds, summary, list: () => orderedIds().map(summary),
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
    addTheater: async (id, folderGrantId, consent) => {
      const root = deps.folderGrants?.consume(folderGrantId);
      if (!root) throw new CommodoreStoreError("invalid_folder_grant");
      let canonical: string;
      try {
        canonical = fs.realpathSync.native(root);
        if (!fs.statSync(canonical).isDirectory()) throw new Error();
      } catch { throw new CommodoreStoreError("theater_unavailable"); }
      if (consent) {
        try { await trustClaudeTheater(canonical); }
        catch (error) { throw new CommodoreStoreError(error instanceof ClaudeTrustError ? error.code : "claude_trust_write_failed"); }
      }
      // 신뢰 쓰기를 기다리는 동안 삭제·목록 변경이 끝났을 수 있다. 저장 직전 소유자와 실제 폴더를 다시 확인한다.
      ownership.assertWritable(id);
      try {
        if (fs.realpathSync.native(root) !== canonical || fs.realpathSync.native(canonical) !== canonical || !fs.statSync(canonical).isDirectory()) throw new Error();
      } catch { throw new CommodoreStoreError("theater_unavailable"); }
      try { deps.beforeTheatersChange?.(id); } catch { throw new CommodoreStoreError("objective_owner_recovery_required"); }
      const rows = entities.theatersOf(id);
      if (!rows.some((row) => row.path === canonical)) store.setTheaters(id, [...rows, { path: canonical }]);
      return deps.paths.workspaceHash(canonical);
    },
    removeTheater: (id, theaterId) => {
      try { deps.beforeTheatersChange?.(id); } catch { throw new CommodoreStoreError("objective_owner_recovery_required"); }
      const root = ownership.theaterPath(id, theaterId);
      store.setTheaters(id, entities.theatersOf(id).filter((row) => row.path !== root));
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
    knowledge,
    routes,
    sync: () => { restored = true; supervisor.sync("restart"); },
    /** 이 사령관이 고른 플러그인의 로컬 경로 — 그 사령관 목표의 지휘관·구성원 세션이 연다(MCP 는 그 세션들이 플러그인에서 직접 읽는다). */
    pluginDirs: (commodoreId: string): readonly string[] => plugins.resolve(store.read(commodoreId)?.plugins ?? []).map((plugin) => plugin.path),
    /** 그 플러그인 MCP 선언의 `${VAR}` 키 — 같은 목표 세션의 자식 환경에 얹는다(자식이 플러그인 MCP 를 읽으며 펼친다). */
    pluginEnv: (commodoreId: string): Readonly<Record<string, string>> => plugins.pluginEnv(store.read(commodoreId)?.plugins ?? []),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { await pluginAuth.dispose().catch(() => undefined); await agent.dispose(); releaseChannel(); releaseSidebarChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
