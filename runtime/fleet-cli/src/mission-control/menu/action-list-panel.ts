import { MISSION_CONTROL_THEME } from "../renderer.js";
import { renderChoiceBlock, type ChoiceBlockRow } from "../layout.js";
import { centerText } from "../welcome.js";
import { isDown, isEnter, isEscape, isUp, renderBreadcrumbs, type MenuPanel } from "./panel-stack.js";

export interface ActionListItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly marker?: string;
  readonly run: () => void;
}

export interface ActionListPanelOptions {
  readonly id: string;
  readonly title: string;
  readonly actions: readonly (ActionListItem | false | undefined)[] | (() => readonly (ActionListItem | false | undefined)[]);
  readonly breadcrumbs?: () => readonly string[];
  readonly footer?: string;
  readonly onBack?: () => void;
  readonly statusLines?: () => readonly string[];
}

export function createActionListPanel(options: ActionListPanelOptions): MenuPanel {
  let selected = 0;

  return {
    id: options.id,
    title: options.title,
    handleInput(data: string): boolean {
      const actions = resolveActions(options.actions);
      selected = clampSelected(selected, actions.length);
      if (isUp(data)) {
        selected = move(selected, actions.length, -1);
        return true;
      }
      if (isDown(data)) {
        selected = move(selected, actions.length, 1);
        return true;
      }
      if (isEnter(data)) {
        actions[selected]?.run();
        return true;
      }
      if (isEscape(data) && options.onBack !== undefined) {
        options.onBack();
        return true;
      }
      return false;
    },
    getFocusLine({ width }): number | undefined {
      const actions = resolveActions(options.actions);
      selected = clampSelected(selected, actions.length);
      if (actions.length === 0) return undefined;
      return getActionFocusLine(width, options, selected);
    },
    render({ width }): readonly string[] {
      const actions = resolveActions(options.actions);
      selected = clampSelected(selected, actions.length);
      const breadcrumbs = options.breadcrumbs?.() ?? [];
      const statusLines = options.statusLines?.() ?? [];
      const breadcrumbLines = breadcrumbs.length <= 1 ? [] : [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(breadcrumbs)), width),
      ];
      return [
        ...breadcrumbLines,
        centerText(MISSION_CONTROL_THEME.accent(options.title), width),
        "",
        ...renderActionRows(actions, selected, width),
        "",
        ...statusLines.map((line) => centerText(line, width)),
        ...(statusLines.length === 0 ? [] : [""]),
        centerText(MISSION_CONTROL_THEME.dim(options.footer ?? "Enter open  Esc back"), width),
      ];
    },
  };
}

function getActionFocusLine(width: number, options: ActionListPanelOptions, selected: number): number {
  const breadcrumbs = options.breadcrumbs?.() ?? [];
  const breadcrumbLines = breadcrumbs.length <= 1 ? [] : [
    "",
    centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(breadcrumbs)), width),
  ];
  return breadcrumbLines.length + 2 + selected;
}

function resolveActions(actions: ActionListPanelOptions["actions"]): ActionListItem[] {
  const items = typeof actions === "function" ? actions() : actions;
  return items.filter((item): item is ActionListItem => item !== false && item !== undefined);
}

function clampSelected(selected: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(selected, length - 1);
}

function renderActionRows(actions: readonly ActionListItem[], selected: number, width: number): string[] {
  const rows = actions.map((item, index) => formatActionRow(item, index === selected));
  return renderChoiceBlock({ innerWidth: width, rows });
}

function formatActionRow(item: ActionListItem, selected: boolean): ChoiceBlockRow {
  const marker = selected ? MISSION_CONTROL_THEME.accent(item.marker ?? "▸") : MISSION_CONTROL_THEME.dim(" ");
  const trailing = item.detail === undefined ? undefined : MISSION_CONTROL_THEME.dim(item.detail);
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(item.label)) : item.label;
  return { label, marker, trailing };
}

function move(index: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (index + delta + length) % length;
}
