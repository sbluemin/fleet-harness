import path from "node:path";

import { OPERATION_GROUPED_EVENT_CHANNEL, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createObjectiveConsoleTools } from "./server/console-tools.js";
import { createLaunchService } from "./server/launch.js";
import { createObjectiveMcpTools } from "./server/objective-tools.js";
import { createObjectiveRoutes } from "./server/routes.js";
import { createObjectiveStore } from "./server/store.js";
import { OBJECTIVE_ITEM_CHANNEL } from "./server/types.js";

/**
 * 목표 — Theater 의 에이전트 Operation 하나하나가 목표다.
 *
 * 목표 고유값은 프로젝트의 워크스페이스 디렉터리(`workspaces/<프로젝트>/objectives/state.json`)에, 제목·그룹·세션은
 * Operation 에 산다. 목록의 그룹은 Operation 그룹 그 자체이고, 변경은 전부 `objectives:item` 사건으로 브라우저에 닿는다.
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
    const dirOf = (theaterId: string): string | null => {
      const cached = dirs.get(theaterId);
      if (cached) return cached;
      const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
      if (!theaterPath) return null;
      const dir = path.join(ctx.host.paths.ensureWorkspaceDirectory(theaterPath).path, "objectives");
      dirs.set(theaterId, dir);
      return dir;
    };
    const releaseChannel = ctx.host.events.registerSseChannel(OBJECTIVE_ITEM_CHANNEL);
    ctx.host.lifecycle.registerCleanup(releaseChannel);
    const store = createObjectiveStore({ dirOf, operations: ctx.host.operations, emit: (event) => ctx.host.events.publish(OBJECTIVE_ITEM_CHANNEL, event) });

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
    on("operation:deleted", (operationId) => launch.operationDeleted(operationId));
    on("operation:purged", (operationId) => launch.operationPurged(operationId));
    on("operation:restored", (operationId) => launch.operationChanged(operationId));
    on("operation:renamed", (operationId) => launch.operationChanged(operationId));
    // 목표의 그룹은 지휘관 Operation 의 그룹이다 — 옮겨지면(사이드바·Console Use·목표 화면) 담당이 따라가고 화면을 다시 방송한다.
    on(OPERATION_GROUPED_EVENT_CHANNEL, (_operationId, payload) => {
      const event = payload as Partial<OperationGroupedEvent>;
      if (typeof event.theaterId !== "string" || (event.groupId !== null && typeof event.groupId !== "string")) return;
      launch.operationGrouped(event as OperationGroupedEvent);
    });

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
