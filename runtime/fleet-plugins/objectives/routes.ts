import path from "node:path";

import { OPERATION_GROUPED_EVENT_CHANNEL, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createObjectiveConsoleTools } from "./server/console-tools.js";
import { createLaunchService } from "./server/launch.js";
import { createObjectiveMcpTools } from "./server/objective-tools.js";
import { createObjectiveRoutes } from "./server/routes.js";
import { createObjectiveStore } from "./server/store.js";
import { OBJECTIVE_CHANNEL } from "./server/types.js";

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
      try { dir = path.join(ctx.host.paths.ensureWorkspaceDirectory(theaterPath).path, "objectives"); }
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
    const store = createObjectiveStore({ dirOf, operations: ctx.host.operations, emit: (event) => ctx.host.events.publish(OBJECTIVE_CHANNEL, event) });

    // 기동·통지는 한 서비스여야 한다 — 라우트와 Console 도구가 각자 만들면 같은 목표의 기동이 겹친다.
    const launch = createLaunchService(ctx, store);
    ctx.host.lifecycle.registerCleanup(() => launch.dispose());
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
    // 원본이 복원되면 멈춰 있던 후속 생성을 같은 키로 이어 간다(지운 동안에는 만들지 않는다).
    on("operation:restored", (operationId) => { launch.operationChanged(operationId); launch.resumeFollowups(operationId); launch.followupTargetChanged(operationId); });
    on("operation:renamed", (operationId) => launch.operationChanged(operationId));
    // 목표의 그룹은 지휘관 Operation 의 그룹이다 — 옮겨지면(사이드바·Console Use·목표 화면) 담당이 따라가고 화면을 다시 방송한다.
    on(OPERATION_GROUPED_EVENT_CHANNEL, (_operationId, payload) => {
      const event = payload as Partial<OperationGroupedEvent>;
      if (typeof event.theaterId !== "string" || (event.groupId !== null && typeof event.groupId !== "string")) return;
      launch.operationGrouped(event as OperationGroupedEvent);
    });

    // 끝나지 않은 후속 생성 — 재시작 전에 creating 으로 남은 항목을 같은 키로 이어 간다(키 원장이 중복과 삭제 번복을 막는다).
    try { launch.resumeFollowups(); }
    catch (error) { console.warn(`[objectives] follow-up resume skipped: ${error instanceof Error ? error.message : String(error)}`); }

    const routes = createObjectiveRoutes(ctx, store, launch);
    for (const route of routes) {
      registerRouter(ctx, route.name, route.handler, { method: route.method, path: "", summary: route.summary, category: "Objectives Plugin", gate: "origin-write", transport: "http" });
    }

    // 두 표면 — Console Use 의 보드(`console_objectives`, 사람처럼 보고 더한다)와 목표 수행 세션의 작업 도구(`fleet-objectives`).
    const releaseConsoleTools = ctx.host.consoleUse.contribute?.(createObjectiveConsoleTools(ctx, store, launch));
    if (releaseConsoleTools) ctx.host.lifecycle.registerCleanup(releaseConsoleTools);
    ctx.host.lifecycle.registerCleanup(ctx.host.admiralMcp.register(createObjectiveMcpTools(ctx, store, launch)));
  },
});
