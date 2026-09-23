import path from "node:path";

import { OPERATION_GROUPED_EVENT_CHANNEL, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createTodoConsoleTools } from "./server/console-tools.js";
import { createGroupSync } from "./server/group-sync.js";
import { createLaunchService } from "./server/launch.js";
import { createTodoRoutes } from "./server/routes.js";
import { createTodoStore } from "./server/store.js";
import { TODO_ITEM_CHANNEL } from "./server/types.js";

/**
 * 할 일 — Operation 관리를 위한 의도 목록.
 *
 * 저장은 플러그인 데이터 디렉터리의 Theater 별 JSON, 목록은 Operation 그룹 그 자체, 변경은 전부 `todo:item`
 * 사건으로 브라우저와 Console Use 에 닿는다. Operation 스키마는 건드리지 않는다.
 */
export default definePlugin({
  id: "todo",
  register(ctx) {
    const dir = path.join(ctx.host.paths.pluginDataDir("todo"), "theaters");
    const releaseChannel = ctx.host.events.registerSseChannel(TODO_ITEM_CHANNEL);
    ctx.host.lifecycle.registerCleanup(releaseChannel);
    const store = createTodoStore({ dir, emit: (event) => ctx.host.events.publish(TODO_ITEM_CHANNEL, event) });

    // 시작·통지·담당 감시는 한 서비스여야 한다 — 라우트와 Console 도구가 각자 만들면 감시자가 둘이 되어 통지가 겹친다.
    const launch = createLaunchService(ctx, store);
    ctx.host.lifecycle.registerCleanup(() => launch.dispose());
    // Operation 이 닫히면 슬롯도 정리한다 — 셰프가 닫히면 담당까지 함께.
    const offDeleted = ctx.host.events.subscribe("operation:deleted", (payload) => {
      const operationId = (payload as { operationId?: unknown } | null)?.operationId;
      if (typeof operationId === "string") launch.operationDeleted(operationId);
    });
    ctx.host.lifecycle.registerCleanup(offDeleted);
    // 항목은 셰프 Operation 의 그룹에 선다 — 셰프가 옮겨지면(사이드바·Console Use·그룹 삭제) 따라가고, 기동 때 갈라진 것을 맞춘다.
    const groupSync = createGroupSync(ctx, store);
    const offGrouped = ctx.host.events.subscribe(OPERATION_GROUPED_EVENT_CHANNEL, (payload) => {
      const event = payload as Partial<OperationGroupedEvent> | null;
      if (!event || typeof event.operationId !== "string" || typeof event.theaterId !== "string" || (event.groupId !== null && typeof event.groupId !== "string")) return;
      try { groupSync.operationGrouped(event as OperationGroupedEvent); } catch (error) { console.warn(`[todo] group follow failed: ${error instanceof Error ? error.message : String(error)}`); }
    });
    ctx.host.lifecycle.registerCleanup(offGrouped);
    try { groupSync.reconcile(); } catch (error) { console.warn(`[todo] group reconcile failed: ${error instanceof Error ? error.message : String(error)}`); }
    const routes = createTodoRoutes(ctx, store, launch, groupSync);
    for (const route of routes) {
      registerRouter(ctx, route.name, route.handler, { method: route.method, path: "", summary: route.summary, category: "To-do Plugin", gate: "origin-write", transport: "http" });
    }

    const releaseConsoleTools = ctx.host.consoleUse.contribute?.(createTodoConsoleTools(ctx, store, launch));
    if (releaseConsoleTools) ctx.host.lifecycle.registerCleanup(releaseConsoleTools);
  },
});
