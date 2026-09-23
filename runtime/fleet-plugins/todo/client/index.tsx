import { definePlugin } from "@fleet-console/sdk/plugin/browser";
import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { todoClusterSource } from "./clusters.js";
import { getT } from "./i18n/index.js";
import { TodoPanel } from "./todo-panel.js";
import { activeTheaterId, installTodoState, loadTheater, revealItem, todoApi } from "./todo-state.js";
import "./todo.css";

export const TODO_SURFACE_ID = "todo";

const TodoIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5l1.2 1.2 2-2.4M2.5 8.5l1.2 1.2 2-2.4M2.5 12.5l1.2 1.2 2-2.4M8 4.5h5.5M8 8.5h5.5M8 12.5h3.5" />
  </svg>
);

/**
 * 할 일 — 레일 아이콘이 확대 표면을 여닫는다(Repository 문법). 표면 하나에 목록 · 항목 · 세부가 선다.
 */
export const todoSurface: ExpandedSurfaceDescriptor = {
  id: TODO_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("todo.panel.title"),
  minPaneWidth: 560,
  // 레일 아이콘이 여닫으므로 호스트의 부유 닫기는 중복이다.
  ownsClose: true,
  render: (ctx: ExpandedSurfaceContext) => <TodoPanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, paneWidth: ctx.paneWidth }} />,
};

export const todoEntry: RailEntryDescriptor = {
  id: "todo",
  title: (locale) => getT(locale)("todo.panel.title"),
  icon: () => <TodoIcon />,
  scope: "theater",
  surfaceId: TODO_SURFACE_ID,
  activate: (ctx) => {
    const surfaces = ctx.surfaces;
    if (!surfaces) return;
    if (surfaces.isOpen(TODO_SURFACE_ID)) surfaces.closeSurface(TODO_SURFACE_ID);
    else surfaces.open({ surfaceId: TODO_SURFACE_ID });
  },
  search: async ({ query, theaterId, limit, language }) => {
    const api = todoApi();
    if (!api) return [];
    await loadTheater(api, theaterId);
    const response = await api.fetch("todo", "/palette-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, query, limit }) });
    if (!response.ok) return [];
    const result = await response.json() as { items: { id: string; title: string }[] };
    const subtitle = getT(language)("todo.palette.subtitle");
    return result.items.map((item) => ({ id: `todo:${item.id}`, title: item.title, subtitle, activate: () => { revealItem({ itemId: item.id }); } }));
  },
};

const todoPlugin = definePlugin({
  id: "todo",
  install: (ctx) => {
    const dispose = installTodoState(ctx);
    const theaterId = activeTheaterId();
    if (theaterId) void loadTheater(ctx.api, theaterId);
    return dispose;
  },
  railEntries: [todoEntry],
  expandedSurfaces: [todoSurface],
  // 조율자와 담당 Operation 은 한 묶음이다 — 사이드바 들여쓰기·캔버스 대형·간선은 호스트가 이 서술자로 그린다.
  operationClusters: todoClusterSource,
});

export const plugins = [todoPlugin] as const;
