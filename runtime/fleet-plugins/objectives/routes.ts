import path from "node:path";

import { OPERATION_GROUP_REMOVED_EVENT_CHANNEL, OPERATION_GROUPED_EVENT_CHANNEL, OPERATION_LAUNCH_CHANGED_EVENT_CHANNEL, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";

import { COMMODORE_ACTIVE_FLAG, commodoreActive, createCommodoreRoutes } from "./server/commodore/routes.js";
import { createCommodoreStore } from "./server/commodore/store.js";
import { createCommodoreSupervisor } from "./server/commodore/supervisor.js";
import { COMMODORE_CHANNEL } from "./server/commodore/types.js";
import { createCommodoreBoardTools, createObjectiveConsoleTools } from "./server/console-tools.js";
import { createLaunchService } from "./server/launch.js";
import { createObjectiveMcpTools } from "./server/objective-tools.js";
import { createGhPrLookup, createPrStatusService, type PrStatusService } from "./server/pr-status.js";
import { agentCallRedirect } from "./server/prompts.js";
import { createObjectiveRoutes } from "./server/routes.js";
import { createObjectiveStore } from "./server/store.js";
import { OBJECTIVE_CHANNEL, type ObjectiveEvent } from "./server/types.js";
import { RESULT_LIMITS } from "./server/results.js";

/**
 * 목표 — Theater 의 에이전트 Operation 하나하나가 목표다.
 *
 * 목표 고유값은 프로젝트의 워크스페이스 디렉터리(`workspaces/<프로젝트>/objectives/<목표>/objective.json`)에, 제목·그룹·세션은
 * Operation 에 산다. 목록의 그룹은 Operation 그룹 그 자체이고, 변경은 전부 `objectives:objective` 사건으로 브라우저에 닿는다.
 * 목표를 수행하는 세션은 `fleet-objectives` 로, Console Use 는 `console_objectives` 로 보드를 쓴다.
 */
const operationIdOf = (payload: unknown): string | null => {
  const operationId = (payload as { operationId?: unknown } | null)?.operationId;
  return typeof operationId === "string" ? operationId : null;
};

export default definePlugin({
  id: "objectives",
  register(ctx) {
    const dirs = new Map<string, string>();
    const unreadable = new Set<string>();
    // 등록된 Theater 폴더가 지금 없을 수 있다(옮김·지움·외장 디스크 분리). 그 Theater 는 읽을 수 없는 것으로 두고
    // 던지지 않는다 — 던지면 플러그인 등록이 깨져 Console 전체가 뜨지 않는다. 실패는 캐시하지 않아
    // 폴더가 돌아오면 다음 읽기가 다시 푼다.
    const dirOf = (theaterId: string): string | null => {
      const cached = dirs.get(theaterId);
      if (cached) return cached;
      const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
      if (!theaterPath) return null;
      let dir: string;
      try { dir = path.join(ctx.host.paths.ensureWorkspaceDirectory(theaterPath).path, ctx.pluginId); }
      catch (error) {
        // 폴더가 없을 때 말고도(예: 워크스페이스 식별 충돌) 여기로 온다 — 원인을 가릴 수 있게 Theater 마다 한 번 남긴다.
        if (!unreadable.has(theaterId)) console.warn(`[objectives] theater ${theaterId} unreadable: ${error instanceof Error ? error.message : String(error)}`);
        unreadable.add(theaterId);
        return null;
      }
      unreadable.delete(theaterId);
      dirs.set(theaterId, dir);
      return dir;
    };
    const releaseChannel = ctx.host.events.registerSseChannel(OBJECTIVE_CHANNEL);
    ctx.host.lifecycle.registerCleanup(releaseChannel);
    let prStatus: PrStatusService | undefined;
    let watchQuiet: () => void = () => {};
    const store = createObjectiveStore({ dirOf, theaterIds: () => ctx.host.paths.listTheaterIds?.() ?? [], operations: ctx.host.operations, coordinates: (operationId) => ctx.host.consoleControl?.coordinates?.(operationId) ?? null, liveSwitch: !!ctx.host.consoleControl?.sleep, observe: (operationId) => ctx.host.consoleControl?.observe(operationId) ?? null, onAssignment: () => watchQuiet(), emit: (event) => {
      ctx.host.events.publish(OBJECTIVE_CHANNEL, event);
      prStatus?.refresh(event.objectiveId);
    } });
    prStatus = createPrStatusService(store, { lookup: createGhPrLookup({ cwd: ctx.host.paths.consoleDataDir }), onError: (code) => console.warn(`[objectives] ${code}`) });
    ctx.host.lifecycle.registerCleanup(() => prStatus!.dispose());
    const collectEvidence = () => { try { store.evidenceCollect(); } catch { console.warn("[objectives] evidence_cleanup_failed"); } };
    collectEvidence();

    // 기동·통지는 한 서비스여야 한다 — 라우트와 Console 도구가 각자 만들면 같은 목표의 기동이 겹친다.
    // 사령관 저장소는 보드보다 먼저 선다 — 사령관이 만드는 목표의 지휘관 설정을 기동 서비스가 읽는다.
    const commodore = createCommodoreStore({ dirOf, theaterIds: () => ctx.host.paths.listTheaterIds?.() ?? [], emit: (event) => ctx.host.events.publish(COMMODORE_CHANNEL, event) });
    const launch = createLaunchService(ctx, store, {
      commodoreCommander: (theaterId) => { const state = commodore.read(theaterId); return state?.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : null; },
    });
    watchQuiet = () => launch.watchReportQuiet();
    ctx.host.lifecycle.registerCleanup(() => launch.dispose());
    // 보관 기간이 지난 지운 목표 — 증거 정리와 같은 주기로 영구 삭제하고, 후속 원본의 배치 표시도 다시 방송한다.
    const purgeRemoved = () => { try { for (const id of store.purgeRemoved()) launch.followupTargetChanged(id); } catch { console.warn("[objectives] removed_purge_failed"); } };
    purgeRemoved();
    const evidenceGc = setInterval(() => { collectEvidence(); purgeRemoved(); }, RESULT_LIMITS.evidenceGcMs);
    evidenceGc.unref?.();
    ctx.host.lifecycle.registerCleanup(() => clearInterval(evidenceGc));
    const on = (channel: string, run: (operationId: string, payload: unknown) => void) => {
      const off = ctx.host.events.subscribe(channel, (payload) => {
        const operationId = operationIdOf(payload);
        if (!operationId) return;
        try { run(operationId, payload); } catch (error) { console.warn(`[objectives] ${channel} failed: ${error instanceof Error ? error.message : String(error)}`); }
      });
      ctx.host.lifecycle.registerCleanup(off);
    };
    // 지휘관이 닫히면 담당도 함께 닫는다. 레코드는 복원 불가로 확정될 때(purged) 거둔다 — 유예 동안 복원하면 목표도 돌아온다.
    // 후속으로 만든 Operation 이 지워지거나 돌아오면 그 원본의 배치 표시(생성됨·삭제됨)도 다시 방송한다.
    on("operation:deleted", (operationId) => { launch.operationDeleted(operationId); launch.followupTargetChanged(operationId); });
    on("operation:purged", (operationId) => { launch.operationPurged(operationId); launch.followupTargetChanged(operationId); });
    // 원본이 복원되면 멈춰 있던 후속 생성을 같은 키로 이어 간다(지운 동안에는 만들지 않는다). 사라진 동안 놓았던 구성원의 이번 턴 뒤
    // 예약도 다시 건다 — 삭제 유예에서 되돌렸든 보관에서 되살렸든(완료 해제 포함) 같은 사건이다.
    on("operation:restored", (operationId) => { launch.operationChanged(operationId); launch.resumeFollowups(operationId); launch.followupTargetChanged(operationId); launch.resumeReservations(operationId); });
    on("operation:archived", (operationId) => { launch.operationChanged(operationId); launch.followupTargetChanged(operationId); });
    on("operation:renamed", (operationId) => launch.operationChanged(operationId));
    // 사람이 채팅 화면에서 모델을 바꾸거나 채팅↔터미널을 전환해도 명단은 지금 세션 좌표를 말해야 한다 — 지휘관이든 구성원이든 그 목표를 다시 방송한다.
    on(OPERATION_LAUNCH_CHANGED_EVENT_CHANNEL, (operationId) => launch.operationChanged(operationId));
    // 목표의 그룹은 지휘관 Operation 의 그룹이다 — 옮겨지면(사이드바·Console Use·목표 화면) 담당이 따라가고 화면을 다시 방송한다.
    on(OPERATION_GROUPED_EVENT_CHANNEL, (_operationId, payload) => {
      const event = payload as Partial<OperationGroupedEvent>;
      if (typeof event.theaterId !== "string" || (event.groupId !== null && typeof event.groupId !== "string")) return;
      launch.operationGrouped(event as OperationGroupedEvent);
    });
    // 개시 전 목표와 후속 배치의 그룹은 저장 레코드에만 있다 — 그룹이 지워지면 미분류로 비우고, 기동 때는 이미 지워진 그룹을 가리키는 옛 레코드를 고쳐 쓴다.
    ctx.host.lifecycle.registerCleanup(ctx.host.events.subscribe(OPERATION_GROUP_REMOVED_EVENT_CHANNEL, (payload) => {
      const event = payload as { groupId?: unknown; theaterId?: unknown };
      if (typeof event.groupId !== "string" || typeof event.theaterId !== "string") return;
      try { store.releaseGroups({ theaterId: event.theaterId, groupId: event.groupId }); }
      catch (error) { console.warn(`[objectives] group release failed: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    try { store.releaseGroups(); }
    catch (error) { console.warn(`[objectives] group heal skipped: ${error instanceof Error ? error.message : String(error)}`); }

    // 완료 여부가 아니라 미완료 Core 요청만 재접수한다. 과거 완료 목표의 자동 보관은 하지 않는다.
    void launch.resumeOperationIntents().catch((error) => console.warn(`[objectives] Operation request recovery failed: ${error instanceof Error ? error.message : "unexpected_failure"}`));
    // 끝나지 않은 후속 생성 — 재시작 전에 creating 으로 남은 항목을 같은 키로 이어 간다(키 원장이 중복과 삭제 번복을 막는다).
    try { launch.resumeFollowups(); }
    catch (error) { console.warn(`[objectives] follow-up resume skipped: ${error instanceof Error ? error.message : String(error)}`); }
    // 구성원의 모델 예약 — 「다음 재개」 시절의 옛 기록은 적용으로 거두고, 이번 턴 뒤를 기다리던 예약은 감시를 다시 건다.
    try { launch.resumeReservations(); }
    catch (error) { console.warn(`[objectives] member reservation resume skipped: ${error instanceof Error ? error.message : String(error)}`); }
    // 이미 live 인 지휘관·구성원 — 이 다음에 실패 판정이 바뀌면 열린 보드가 upsert 로 받는다. 활동 사건 채널은 없다.
    try { launch.watchLiveOutcomes(); }
    catch (error) { console.warn(`[objectives] outcome watch skipped: ${error instanceof Error ? error.message : String(error)}`); }
    // 배정된 준비 임무의 무보고 — 대상이 없으면 타이머를 걸지 않는다. 이후 배정이 다시 건다.
    try { launch.watchReportQuiet(); }
    catch (error) { console.warn(`[objectives] report quiet watch skipped: ${error instanceof Error ? error.message : String(error)}`); }

    const routes = createObjectiveRoutes(ctx, store, launch, prStatus);
    for (const route of routes) {
      registerRouter(ctx, route.name, route.handler, { method: route.method, path: "", summary: route.summary, category: "Objectives Plugin", gate: "origin-write", transport: "http" });
    }

    // 사령관(자율 운영) — Theater 마다 하나. 상태는 보드 곁 `commodore/` 에 살고, 사건은 자기 채널로 나간다.
    ctx.host.lifecycle.registerCleanup(ctx.host.events.registerSseChannel(COMMODORE_CHANNEL));
    // 감독자 — 자율 운영이 켜진 Theater 의 사령관을 깨우고, 되살리고, 멈춘다. 보드 도구는 Theater 에 묶인 사령관 전용 사본이다.
    const supervisor = createCommodoreSupervisor({
      store: commodore, agent: ctx.host.agent,
      experiments: () => ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS,
      ...(ctx.host.experiments?.subscribe ? { subscribeExperiments: (listener) => ctx.host.experiments!.subscribe!(listener) } : {}),
      // 사령관 좌표는 Console의 모델 로스터에 대조해 연다 — 꺼진 모델은 폴백하고 기록에 남긴다.
      ...(ctx.host.models ? { models: ctx.host.models } : {}),
      theater: (theaterId) => { const root = ctx.host.paths.resolveTheaterPath(theaterId); return root ? { label: path.basename(root) || root, root } : null; },
      objectives: (theaterId) => store.list(theaterId),
      // 사령관 언어의 폴백 — 목표 라우트가 지휘관 Operation 에 남긴 언어(가장 최근 것).
      language: (theaterId) => {
        const latest = ctx.host.operations.list().filter((node) => node.theaterId === theaterId && (node.payload.objectiveLanguage === "ko" || node.payload.objectiveLanguage === "en")).sort((a, b) => b.ts.updatedAt - a.ts.updatedAt)[0];
        return latest?.payload.objectiveLanguage === "ko" ? "ko" : "en";
      },
      subscribeObjectives: (listener) => ctx.host.events.subscribe(OBJECTIVE_CHANNEL, (payload) => listener(payload as ObjectiveEvent)),
      boardTools: (theaterId) => createCommodoreBoardTools(ctx, store, launch, theaterId),
      ...(ctx.host.consoleControl ? { observe: (operationId) => ctx.host.consoleControl!.observe(operationId) } : {}),
      emit: (event) => ctx.host.events.publish(COMMODORE_CHANNEL, event),
    });
    ctx.host.lifecycle.registerCleanup(() => supervisor.dispose());
    for (const route of createCommodoreRoutes(ctx, commodore, { run: (theaterId) => supervisor.status(theaterId), retry: (theaterId) => supervisor.retry(theaterId), clear: (theaterId) => supervisor.clear(theaterId) })) {
      registerRouter(ctx, route.name, route.handler, { method: route.method, path: "", summary: route.summary, category: "Objectives Plugin", gate: "origin-write", transport: "http" });
    }
    // 재시작 복원 — 실험 기능과 자율 운영이 켜진 Theater 의 사령관을 다시 열고 「Console 재시작」 턴을 보낸다.
    try { supervisor.sync("restart"); } catch (error) { console.warn(`[objectives] commodore restore failed: ${error instanceof Error ? error.message : String(error)}`); }
    // 사이드바 Theater DTO 의 「사령관 활동 중」 — 호스트 스텁(테스트)에는 이 능력이 없을 수 있다.
    const releaseFlag = (ctx.host.theaterFlags as typeof ctx.host.theaterFlags | undefined)?.register(COMMODORE_ACTIVE_FLAG, (theaterId) => commodoreActive(ctx, commodore, theaterId));
    if (releaseFlag) ctx.host.lifecycle.registerCleanup(releaseFlag);

    // Console 세션의 서브에이전트 호출 — 띄우지 않고, 그 자리를 이 목표의 구성원이 맡는다는 사실로 답한다.
    const releaseAgentCalls = ctx.host.consoleControl?.redirectAgentCalls?.((operationId) => agentCallRedirect(store.find(operationId), store.findMember(operationId) !== null));
    if (releaseAgentCalls) ctx.host.lifecycle.registerCleanup(releaseAgentCalls);

    // 두 표면 — Console Use 의 보드(`console_objectives`, 사람처럼 보고 더한다)와 목표 수행 세션의 작업 도구(`fleet-objectives`).
    const releaseConsoleTools = ctx.host.consoleUse.contribute?.(createObjectiveConsoleTools(ctx, store, launch));
    if (releaseConsoleTools) ctx.host.lifecycle.registerCleanup(releaseConsoleTools);
    ctx.host.lifecycle.registerCleanup(ctx.host.admiralMcp.register(createObjectiveMcpTools(ctx, store, launch, prStatus)));
  },
});
