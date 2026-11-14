import fs from "node:fs";
import type { ConsoleRosterCommodore, ConsoleRosterCommander } from "../../../protocol/desktop/console-section.js";
import { consoleRosterPreview } from "./roster.js";
import { createCommodoreSidebar, type CommodoreSidebarPersistence } from "./sidebar-layout.js";
import { COMMODORE_SIDEBAR_CHANNEL } from "../shared/contracts/sidebar-layout.js";
import os from "node:os";
import { openClaudeMcpControl } from "@fleet-console/agent-runtime/claude";
import { createCommodorePluginAuth } from "./plugin-auth.js";
import { stripConsoleInternalEnv } from "../../execution/host/terminal/launch-env.js";
import type { FolderGrantStore } from "../../workspace/host/theaters/theater-domain.js";
import { ClaudeTrustError, trustClaudeTheater } from "../../workspace/host/theaters/claude-trust.js";
import { createCommodoreDeletion, type CommodoreDeletionHost } from "./deletion.js";
export type { CommodoreDeletionHost } from "./deletion.js";
import type { ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import { effectiveCommodorePlugins, objectiveSessionPlugins } from "../shared/contracts/plugins.js";
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
import type { TaskforceEvent } from "../shared/contracts/taskforce.js";
import { DEFAULT_EXPERIMENT_SETTINGS } from "../../settings/shared/experiments.js";
import { createConsoleResidentAgentHost, type ConsoleResidentAgentDeps } from "../../execution/host/agent/console-resident.js";
import { createCommodoreRoutes, commodoreActive } from "./routes.js";
import { createCommodoreStore } from "./store.js";
import { createTaskforceFeature } from "./taskforce/index.js";
import { createCommodoreMessenger } from "./messaging.js";
import { createCommodoreCreator } from "./creation.js";
import { createCommodoreManagementTools } from "./console-tools.js";
import { createCommodorePlugins } from "./plugins.js";
import type { ClaudeHomeLocation } from "./home-overlay.js";
export { userClaudeHome, type ClaudeHomeLocation } from "./home-overlay.js";
import type { OwnedProcessPort } from "@fleet-console/process";
import { createCommodoreSupervisor } from "./supervisor.js";
import { COMMODORE_CHANNEL } from "../shared/contracts/types.js";
import type { ApprovalCore } from "@fleet-console/approval";
import { bindDescriptionProposals, type DescriptionProposalBinding } from "./description-proposals.js";
import { bindIntelProposals, type IntelProposalBinding } from "./intel-proposals.js";

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
  /** 마켓플레이스 받기·설치에 쓰는 `claude` CLI 를 Console 수명에 묶어 띄운다. */
  readonly processes?: OwnedProcessPort;
  /**
   * 사람의 실제 Claude 홈. 있으면 사령관 세션만 그 MCP 서버·스킬·켜 둔 플러그인을 Fleet 것 뒤에 더한다(읽기만 한다).
   * 없으면 홈을 읽지 않는다 — 테스트·다른 호스트가 실제 홈에 닿지 않는다.
   */
  readonly claudeHome?: ClaudeHomeLocation;
  /** 콘솔 승인 코어. 있으면 설명 변경 제안을 등록한다. 실험 스위치가 아니다. */
  readonly approvals?: ApprovalCore;
  /** 사령관 세션에만 싣는 Gateway 도구 묶음(`fleet-ai-gateway`). Console 조립부가 정한다. */
  readonly gatewayTools?: import("../../execution/shared/agent.js").AgentToolGroup;
  /** 사령관의 응답 말투 — 조립이 아바타 책을 읽어 주입한다. 사령관 호스트는 아바타 책을 직접 읽지 않는다. */
  readonly voiceOf?: (commodoreId: string) => import("./prompt.js").CommodoreVoice | null;
  /** 명부는 아바타 책의 표시용 모습만 받는다 — 처음 배정한 모습·저장 경로는 건네지 않는다. */
  readonly rosterLookOf?: (commodoreId: string) => ConsoleRosterCommodore["look"];
  /**
   * 그 사령관의 진행 중 지휘관 — 사이드바와 같은 순서·진행·한 낱말. 없으면 이름만 내보낸다.
   * 목표 저장은 조립부가 읽고, 여기에는 이미 계약 모양으로 접은 목록만 온다.
   */
  readonly rosterCommandersOf?: (commodoreId: string) => { readonly commanders: readonly ConsoleRosterCommander[]; readonly moreCommanders: number };
  /**
   * 진행 중 목표 하나의 표시 전용 스냅샷. 목표 저장은 조립부가 읽고, 계약 모양으로 접은 것만 온다.
   * 명부에 없는 목표(완료·보관·없음)는 null — 경로는 구분 없이 404로 답한다.
   */
  readonly objectivePeekOf?: (objectiveId: string) => import("../../../protocol/desktop/console-section.js").ConsoleObjectivePeek | null;
}

/** Console 조합이 소유하는 UUID 엔티티와 비영속 상주 실행. */
export function createCommodoreFeature(deps: CommodoreFeatureDeps) {
  let board: CommodoreBoardAdapter | null = null;
  let restored = false;
  let disposed = false;
  const ownership = deps.ownership ?? createCommodoreOwnership(deps.paths);
  const { entities, theaterIds } = ownership;
  const releaseChannel = deps.events.registerSseChannel(COMMODORE_CHANNEL);
  const releaseSidebarChannel = deps.events.registerSseChannel(COMMODORE_SIDEBAR_CHANNEL);
  const agent = createConsoleResidentAgentHost(deps.agent);
  const emit = (event: CommodoreEvent | TaskforceEvent) => {
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
  // 승인 채널은 조립이 이미 열었다. 여기서는 타입만 등록한다.
  let proposals: DescriptionProposalBinding | null = null;
  let intelProposals: IntelProposalBinding | null = null;
  let noteProposal = (_commodoreId: string, _kind: "description-proposal" | "intel-proposal", _outcome: string) => {};
  if (deps.approvals) {
    const known = (id: string) => entities.dirOf(id) !== null;
    proposals = bindDescriptionProposals({
      core: deps.approvals, store, known,
      onSettled: (proposerId, status, reason) => noteProposal(proposerId, "description-proposal", reason ?? status),
      onReplaced: (proposerId) => noteProposal(proposerId, "description-proposal", "replaced"),
    });
    intelProposals = bindIntelProposals({
      core: deps.approvals, store, known,
      onSettled: (proposerId, status, reason) => noteProposal(proposerId, "intel-proposal", reason ?? status),
      onReplaced: (proposerId) => noteProposal(proposerId, "intel-proposal", "replaced"),
    });
  }
  /**
   * 목표 세션에 실을 id — 전역 우선 대체를 유지한 뒤, 전역 토글과 이 사령관 토글의 OR 로 거른다.
   * 뺀 목록이 없으면 지금과 같이 전부 싣는다. 사령관 세션(`plugins` 아래)과 인증은 이 함수를 쓰지 않는다.
   */
  const objectiveIds = (commodoreId: string): readonly string[] => {
    const state = store.read(commodoreId);
    return objectiveSessionPlugins(plugins.listGlobal(), state?.plugins ?? [], plugins.listGlobalExcluded(), state?.objectiveExcluded);
  };
  /**
   * TF 삭제는 사이드바 한 줄도 함께 걷는다 — 순서와 섹션 소속에서 id를 뺀다.
   * 사령관 삭제 경로(서버 cleanup)가 같은 일을 하므로 두 삭제는 같은 뒷정리를 공유한다.
   */
  const forgetTaskforceRow = (taskforceId: string) => {
    try {
      if (deps.order) {
        const order = deps.order.read();
        if (order.includes(taskforceId)) deps.order.write(order.filter((id) => id !== taskforceId));
      }
    } catch (error) { console.warn(`[objectives] taskforce sidebar order cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    try {
      const persistence = deps.sidebar;
      const layout = persistence?.read();
      if (persistence && layout && layout.membership[taskforceId] !== undefined) {
        const { [taskforceId]: _dropped, ...membership } = layout.membership;
        persistence.write({ ...layout, membership });
      }
    } catch (error) { console.warn(`[objectives] taskforce sidebar membership cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const taskforce = createTaskforceFeature({
    consoleDataDir: deps.paths.consoleDataDir, events: deps.events, http: deps.http, security: deps.security,
    isKnownCommodore: (id) => entities.ids().includes(id),
    onDeleted: forgetTaskforceRow,
    // TF는 옵트인 실험이다 — 꺼져 있으면 경로가 거절되고 깨움·판단·도구가 쉰다(데이터는 보존).
    isEnabled: () => { try { return deps.experiments?.read().taskforce === true; } catch { return false; } },
  });
  selectedPlugins = () => entities.ids().flatMap((id) => store.read(id)?.plugins ?? []);
  const createFromCommodore = createCommodoreCreator({ ownership, store, ...(deps.models ? { models: deps.models } : {}), ...(deps.created ? { created: deps.created } : {}) });
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
      list: () => orderedIds().filter((id) => entities.dirOf(id) !== null).map((id) => ({ commodoreId: id, alias: store.read(id)?.alias, theaters: entities.theatersOf(id) })),
      create: (input) => createFromCommodore(commodoreId, input),
      message: (input) => messageFromCommodore(commodoreId, input, turn),
    }),
    plugins: (ids) => plugins.resolve(effectiveCommodorePlugins(plugins.listGlobal(), ids).effective),
    ...(deps.claudeHome ? { claudeHome: deps.claudeHome } : {}),
    ...(deps.gatewayTools ? { gatewayTools: deps.gatewayTools } : {}),
    ...(deps.voiceOf ? { voiceOf: deps.voiceOf } : {}),
    emit,
    taskforce: taskforce.store,
    onTaskforceEvent: (event) => emit(event),
    ...(proposals ? { proposals: (commodoreId: string) => proposals!.forCommodore(commodoreId) } : {}),
    ...(intelProposals ? { intelProposals: (commodoreId: string) => intelProposals!.forCommodore(commodoreId) } : {}),
  });
  noteProposal = (commodoreId, kind, status) => supervisor.noteProposal(commodoreId, kind, status);
  /**
   * 키·토큰이 바뀐 플러그인을 고른 사령관 — 고른 목록은 그대로라 저장소 사건이 없으므로 감독자에게 직접 알려 다음 턴을 새 세션
   * (새 환경·새 MCP 연결)으로 연다. 전역 플러그인이면 모든 사령관이다. 목표 세션은 다음 실행부터 받는다.
   */
  const pluginsChanged = (pluginIds: readonly string[]) => {
    const global = new Set(plugins.listGlobal());
    const touchesGlobal = pluginIds.some((id) => global.has(id));
    for (const commodoreId of entities.ids()) {
      if (touchesGlobal || (store.read(commodoreId)?.plugins ?? []).some((id) => pluginIds.includes(id))) supervisor.replaceSessionNext(commodoreId);
    }
  };
  /**
   * 전역 플러그인 알림. 목록이 바뀌면 모든 사령관의 다음 턴을 새 세션으로 연다. 토글만 바뀌면 세션은 그대로 두고
   * 사건만 낸다(하단 알약이 목록을 다시 읽는다). 목표 세션은 어느 쪽이든 다음 실행부터 받는다.
   */
  const announceGlobalPlugins = (next: readonly string[], rotate: boolean) => {
    const list = [...next];
    for (const commodoreId of entities.ids()) {
      if (rotate) supervisor.replaceSessionNext(commodoreId);
      emit({ op: "global-plugins", commodoreId, theaterIds: theaterIds(commodoreId), plugins: list });
    }
  };
  const globalPluginsChanged = (next: readonly string[]) => announceGlobalPlugins(next, true);
  const globalPluginReachChanged = () => announceGlobalPlugins(plugins.listGlobal(), false);
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
      return state?.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}), ...(typeof state.commanderFast === "boolean" ? { fast: state.commanderFast } : {}) } : null;
    },
    session(id) {
      const running = id ? supervisor.status(id)?.session : undefined;
      return running?.model ? { model: running.model, ...(running.effort ? { effort: running.effort } : {}) } : null;
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
  /**
   * 좌측 목록 한 줄의 순서 — 사령관과 TF가 한 모델에 산다. 저장된 순서는 두 종류의 id를
   * 함께 들고, 저장에 없는 행(새로 생긴·복원된)은 사령관 먼저·TF 나중으로 뒤에 붙는다.
   * 기존 저장(사령관만)은 그대로 읽히고, 알 수 없는 id는 읽을 때 버린다.
   */
  const taskforceIds = (): readonly string[] => {
    try { return taskforce.store.availableTaskforces(); }
    catch { return []; }
  };
  const knownRowIds = (): Set<string> => new Set([...entities.ids(), ...taskforceIds()]);
  const orderedIds = (): readonly string[] => {
    const known = knownRowIds();
    const stored = (deps.order?.read() ?? []).filter((id) => known.has(id));
    const missingCommodores = entities.ids().filter((id) => !stored.includes(id));
    const missingTaskforces = [...taskforceIds()]
      .filter((id) => !stored.includes(id) && !missingCommodores.includes(id))
      .sort((a, b) => {
        let at = 0; let bt = 0;
        try { at = taskforce.store.read(a)?.createdAt ?? 0; } catch { /* 읽을 수 없는 TF는 맨 앞으로 */ }
        try { bt = taskforce.store.read(b)?.createdAt ?? 0; } catch { /* 읽을 수 없는 TF는 맨 앞으로 */ }
        return at - bt || (a < b ? -1 : a > b ? 1 : 0);
      });
    return [...new Set([...stored, ...missingCommodores, ...missingTaskforces])];
  };
  /** 사이드바 행 이동의 쓰기 판정 — 사령관은 소유 판정, TF는 존재 판정을 쓴다. 둘 다 아니면 404다. */
  const assertRowWritable = (id: string) => {
    if (entities.dirOf(id)) { ownership.assertWritable(id); return; }
    if (!taskforce.store.read(id)) throw new CommodoreStoreError("unknown_commodore");
  };
  const commodoreDeletion = deps.deletion ? createCommodoreDeletion({ ownership, store, supervisor, host: deps.deletion, consoleDataDir: deps.paths.consoleDataDir, summary,
    protectedDirectories: () => entities.ids().flatMap((id) => entities.theatersOf(id).map((row) => row.path)),
    removing: (commodoreId, ids) => emit({ op: "removing", commodoreId, theaterIds: ids }),
    removed: (commodoreId, ids) => emit({ op: "removed", commodoreId, theaterIds: ids }),
  }) : undefined;
  /**
   * 사령관 삭제는 TF 성원에서도 뺀다 — 속한 TF마다 `member-removed` system 항목을 남긴다.
   * 정리가 실패해도 삭제 자체를 막지 않는다(다음 TF 읽기가 다시 볼 수 있게 id만 남는다).
   */
  const deletion = commodoreDeletion ? {
    preview: (id: string, language?: "en" | "ko") => commodoreDeletion.preview(id, language),
    remove: async (id: string, alias: string, language?: "en" | "ko") => {
      const result = await commodoreDeletion.remove(id, alias, language);
      try { taskforce.store.removeCommodoreFromAll(id); }
      catch (error) { console.warn(`[objectives] taskforce member cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
      return result;
    },
  } : undefined;
  const sidebar = createCommodoreSidebar({
    persistence: deps.sidebar, ids: () => [...knownRowIds()], order: orderedIds, assertWritable: assertRowWritable,
    changed: () => deps.events.publish(COMMODORE_SIDEBAR_CHANNEL, { op: "changed" }),
  });
  const commodoreRoutes = createCommodoreRoutes(context, store, {
    sidebar, plugins, pluginAuth, pluginsChanged, globalPluginsChanged, globalPluginReachChanged, deletion, assertWritable: ownership.assertWritable,
    theaterIds, summary, list: () => orderedIds().filter((id) => entities.dirOf(id) !== null).map(summary),
    order: orderedIds,
    objectivePeekOf: deps.objectivePeekOf,
    roster: () => {
      const layout = sidebar.read();
      const ids = orderedIds().filter((id) => entities.dirOf(id) !== null);
      // 접힘은 빼고 섹션을 펼친 순서다. 섹션 없는 행은 사이드바처럼 맨 뒤에 둔다.
      const ordered = [...layout.sections.flatMap((section) => ids.filter((id) => layout.membership[id] === section.id)), ...ids.filter((id) => !layout.membership[id])];
      return ordered.map((id): ConsoleRosterCommodore => {
        const state = store.read(id);
        const name = state?.alias || ownership.theaterSummaries(id).find((theater) => theater.label)?.label || "Commodore";
        // 사이드바 행과 같은 출처 — 사령관의 마지막 응답 한 줄. 사람 말·운영 줄은 그 함수가 이미 걸러 둔다.
        const preview = consoleRosterPreview(store.transcriptLast(id, "commodore")?.text);
        const listed = deps.rosterCommandersOf?.(id);
        const commanders = listed?.commanders ?? [];
        const moreCommanders = listed?.moreCommanders ?? 0;
        const memberOf = layout.sections.length > 0 ? layout.membership[id] : undefined;
        const section = memberOf && layout.sections.some((item) => item.id === memberOf) ? memberOf : undefined;
        return { id, name: name.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 120), look: deps.rosterLookOf?.(id) ?? null,
          run: supervisor.status(id)?.phase === "turn" ? "working" : state?.asks?.some((ask) => !ask.settled) ? "waiting" : "quiet",
          ...(section ? { section } : {}),
          ...(preview ? { preview } : {}),
          ...(commanders.length > 0 ? { commanders } : {}),
          ...(moreCommanders > 0 ? { moreCommanders } : {}) };
      });
    },
    setOrder: (requested) => {
      if (!deps.order) throw new CommodoreStoreError("commodore_unavailable");
      const known = knownRowIds();
      const next = [...new Set(requested.filter((id) => known.has(id)))];
      const previous = deps.order.read();
      if (next.length === previous.length && next.every((id, index) => id === previous[index])) return;
      deps.order.write(next);
      // 순서는 Console 전체의 투영이다. 첫 사령관 행의 state 사건으로 목록을 무효화하되,
      // 사령관이 하나도 없으면 사이드바 changed로 무효화한다. 엔티티 파일은 쓰지 않는다.
      const first = orderedIds().find((id) => entities.dirOf(id) !== null);
      const state = first ? store.read(first) : null;
      if (first && state) emit({ op: "state", commodoreId: first, theaterIds: theaterIds(first), state, change: "order" });
      else deps.events.publish(COMMODORE_SIDEBAR_CHANNEL, { op: "changed" });
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
    run: (id) => supervisor.status(id), retry: (id) => supervisor.retry(id), stopTurn: (id) => supervisor.stopTurn(id), clear: (id) => supervisor.clear(id),
    boardReady: () => board !== null,
    objective: (id) => {
      for (const commodoreId of entities.ids()) {
        const found = board?.objective(commodoreId, id);
        if (found) return found;
      }
      return null;
    },
  });
  const routes = [...commodoreRoutes, ...taskforce.routes];
  return {
    host,
    /** 사이드바 순서대로의 사령관 id — 전역 브라우저가 사령관 스페이스를 같은 순서로 늘어놓는다. TaskForce 는 빠진다. */
    commodoreIds: (): readonly string[] => { const commodores = new Set(entities.ids()); return orderedIds().filter((id) => commodores.has(id)); },
    /** 전역 브라우저 등 공유 화면이 사령관 스페이스를 구별할 표시 이름. */
    label: (id: string): string => { const state = store.read(id); return state ? state.alias ?? ownership.theaterSummaries(id)[0]?.label ?? "Commodore" : ""; },
    /** 새 지휘관이 생성 시 고정할 자동 메모리 정책. 사령관 자신의 SDK 설정과는 별개다. */
    commanderAutoMemoryEnabled: (commodoreId: string): boolean => store.read(commodoreId)?.autoMemoryEnabled !== false,
    routes,
    /** TaskForce 저장소 — 판단·깨움 런타임과 TF 화면이 쓰는 TF 원장의 주인이다. */
    taskforce: taskforce.store,
    sync: () => { restored = true; supervisor.sync("restart"); },
    /** 응답 말투가 바뀌었다 — 진행 중인 턴은 끊지 않고 다음 턴을 새 세션으로 연다(모델 변경과 같은 경로). */
    replaceSessionNext: (commodoreId: string) => supervisor.replaceSessionNext(commodoreId),
    /** 이 사령관 목표의 지휘관·구성원 세션이 여는 플러그인 경로 — 전역 우선 대체 뒤, 토글 OR 로 거른다. 사령관 세션은 거르지 않는다. */
    pluginDirs: (commodoreId: string): readonly string[] => plugins.resolve(objectiveIds(commodoreId)).map((plugin) => plugin.path),
    /** 그 플러그인 MCP 선언의 `${VAR}` 키 — 목표 세션에 실리는 id만. 같은 세션의 자식 환경에 얹는다. */
    pluginEnv: (commodoreId: string): Readonly<Record<string, string>> => plugins.pluginEnv(objectiveIds(commodoreId)),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await supervisor.dispose(); } finally { proposals?.dispose(); intelProposals?.dispose(); await pluginAuth.dispose().catch(() => undefined); await agent.dispose(); releaseChannel(); releaseSidebarChannel(); }
    },
  };
}
export type CommodoreFeature = ReturnType<typeof createCommodoreFeature>;
