import { definePlugin } from "@fleet-console/sdk/plugin/browser";
import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { objectivesClusterSource } from "./clusters.js";
import { getT } from "./i18n/index.js";
import { ObjectivePanel } from "./objectives-panel.js";
import { activeTheaterId, handleMapOperationSelected, installObjectiveState, loadTheater, onObjectiveSurfaceClose, revealItem, objectivesApi, toggleObjectivePlace } from "./objectives-state.js";
import "./objectives.css";

export const OBJECTIVE_SURFACE_ID = "objectives";

const ObjectiveIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5l1.2 1.2 2-2.4M2.5 8.5l1.2 1.2 2-2.4M2.5 12.5l1.2 1.2 2-2.4M8 4.5h5.5M8 8.5h5.5M8 12.5h3.5" />
  </svg>
);

/** 같은 본문을 레일 primary와 기존 전용 확장 표면에 각각 세운다. */
export const objectivesPane: PaneDescriptor = {
  id: OBJECTIVE_SURFACE_ID,
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language)("objectives.panel.title"),
  widthClass: "standard",
  render: (ctx) => <ObjectivePanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, place: "rail" }} />,
};

export const objectivesSurface: ExpandedSurfaceDescriptor = {
  id: OBJECTIVE_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("objectives.panel.title"),
  minPaneWidth: 560,
  // 레일 아이콘이 여닫으므로 호스트의 부유 닫기는 중복이다.
  ownsClose: true,
  onClose: onObjectiveSurfaceClose,
  render: (ctx: ExpandedSurfaceContext) => <ObjectivePanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, place: "expanded" }} />,
};

export const objectivesEntry: RailEntryDescriptor = {
  id: "objectives",
  title: (locale) => getT(locale)("objectives.panel.title"),
  icon: () => <ObjectiveIcon />,
  scope: "theater",
  panes: [OBJECTIVE_SURFACE_ID],
  surfaceId: OBJECTIVE_SURFACE_ID,
  activate: (ctx) => toggleObjectivePlace(ctx.rail, ctx.surfaces),
  search: async ({ query, theaterId, limit, language }) => {
    const api = objectivesApi();
    if (!api) return [];
    await loadTheater(api, theaterId);
    const response = await api.fetch("objectives", "/palette-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, query, limit }) });
    if (!response.ok) return [];
    const result = await response.json() as { items: { id: string; title: string }[] };
    const subtitle = getT(language)("objectives.palette.subtitle");
    return result.items.map((item) => ({ id: `objectives:${item.id}`, title: item.title, subtitle, activate: () => { revealItem({ itemId: item.id }); } }));
  },
};

const objectivesPlugin = definePlugin({
  id: "objectives",
  install: (ctx) => {
    const dispose = installObjectiveState(ctx);
    const theaterId = activeTheaterId();
    if (theaterId) void loadTheater(ctx.api, theaterId);
    return dispose;
  },
  onMapOperationSelected: handleMapOperationSelected,
  railEntries: [objectivesEntry],
  panes: [objectivesPane],
  expandedSurfaces: [objectivesSurface],
  // 지휘관과 담당 Operation은 한 묶음이다 — 호스트는 이 서술자로 지휘관 패널의 구성원·임무 줄을 그린다.
  operationClusters: objectivesClusterSource,
});

export const plugins = [objectivesPlugin] as const;
