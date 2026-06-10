import { renderChoiceBlock, type ChoiceBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../theme.js";
import { centerText } from "../welcome.js";
import { isDown, isEnter, isUp, renderBreadcrumbs, type MenuPanel } from "./panel-stack.js";

export type SectionedListRow = SectionHeaderRow | SectionLaunchRow | SectionToggleRow | SectionNavigateRow;

export interface SectionedListPanelOptions {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly SectionedListRow[] | (() => readonly SectionedListRow[]);
  readonly breadcrumbs?: () => readonly string[];
  readonly footer?: string;
  readonly statusLines?: () => readonly string[];
}

export interface SectionHeaderRow {
  readonly kind: "header";
  readonly label: string;
}

export interface SectionLaunchRow {
  readonly kind: "launch";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly trailing?: string;
  readonly launch: () => void;
  readonly openModelOverride?: () => void;
}

export interface SectionToggleRow {
  readonly kind: "toggle";
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly toggle: () => void;
}

export interface SectionNavigateRow {
  readonly kind: "navigate";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly navigate: () => void;
}

type SelectableRow = SectionLaunchRow | SectionToggleRow | SectionNavigateRow;
type DisplayRow = DisplayBlankRow | DisplayChoiceRow;

interface DisplayBlankRow {
  readonly kind: "blank";
}

interface DisplayChoiceRow {
  readonly kind: "choice";
  readonly choice: ChoiceBlockRow;
  readonly sourceIndex: number;
}

export function createSectionedListPanel(options: SectionedListPanelOptions): MenuPanel {
  let selected = firstSelectableIndex(resolveRows(options.rows));

  return {
    id: options.id,
    title: options.title,
    handleInput(data: string): boolean {
      const rows = resolveRows(options.rows);
      selected = clampSelectable(rows, selected);
      if (isUp(data)) {
        selected = move(rows, selected, -1);
        return true;
      }
      if (isDown(data)) {
        selected = move(rows, selected, 1);
        return true;
      }
      const row = rows[selected];
      if (isEnter(data) && isSelectable(row)) {
        runSelected(row);
        return true;
      }
      if (isRight(data) && row?.kind === "launch" && row.openModelOverride !== undefined) {
        row.openModelOverride();
        return true;
      }
      return false;
    },
    getFocusLine({ width }): number | undefined {
      const rows = resolveRows(options.rows);
      selected = clampSelectable(rows, selected);
      if (!isSelectable(rows[selected])) return undefined;
      return getRowFocusLine(width, options, selected);
    },
    render({ width }): readonly string[] {
      const rows = resolveRows(options.rows);
      selected = clampSelectable(rows, selected);
      const breadcrumbs = options.breadcrumbs?.() ?? [];
      const statusLines = options.statusLines?.() ?? [];
      // 단축키 힌트는 항상 표시하고, 상태 줄(카운트/Update Available/저장 오류)은 각자 별도 줄로 둔다.
      // 힌트 앞에는 항상 한 줄 여백을 둔다(상태 줄이 있으면 그 뒤에, 없으면 본문 뒤 여백이 그 역할).
      const footerHint = MISSION_CONTROL_THEME.dim(options.footer ?? "↑↓ select  Enter open");
      const breadcrumbLines = breadcrumbs.length <= 1 ? [] : [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(breadcrumbs)), width),
      ];
      return [
        ...breadcrumbLines,
        centerText(MISSION_CONTROL_THEME.accent(options.title), width),
        "",
        ...renderRows(rows, selected, width),
        "",
        ...statusLines.map((line) => centerText(line, width)),
        ...(statusLines.length === 0 ? [] : [""]),
        centerText(footerHint, width),
      ];
    },
  };
}

function clampSelectable(rows: readonly SectionedListRow[], selected: number): number {
  if (isSelectable(rows[selected])) {
    return selected;
  }
  return firstSelectableIndex(rows);
}

function firstSelectableIndex(rows: readonly SectionedListRow[]): number {
  const index = rows.findIndex(isSelectable);
  return index === -1 ? 0 : index;
}

function getRowFocusLine(width: number, options: SectionedListPanelOptions, selected: number): number {
  const breadcrumbs = options.breadcrumbs?.() ?? [];
  const breadcrumbLines = breadcrumbs.length <= 1 ? [] : [
    "",
    centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(breadcrumbs)), width),
  ];
  const displayIndex = buildDisplayRows(resolveRows(options.rows), selected)
    .findIndex((row) => row.kind === "choice" && row.sourceIndex === selected);
  // 렌더 구조: [...breadcrumbs, title, "", ...rows, "", footer] — title과 그 다음 빈 줄(=2)을 오프셋에 더한다.
  return breadcrumbLines.length + 2 + Math.max(0, displayIndex);
}

function isRight(data: string): boolean {
  return data === "\x1b[C" || data === "\x1bOC";
}

function isSelectable(row: SectionedListRow | undefined): row is SelectableRow {
  return row !== undefined && row.kind !== "header";
}

function move(rows: readonly SectionedListRow[], index: number, delta: -1 | 1): number {
  const selectableCount = rows.filter(isSelectable).length;
  if (selectableCount === 0) return 0;
  let next = index;
  do {
    next = (next + delta + rows.length) % rows.length;
  } while (!isSelectable(rows[next]));
  return next;
}

function renderRows(rows: readonly SectionedListRow[], selected: number, width: number): string[] {
  const displayRows = buildDisplayRows(rows, selected);
  const choiceRows = displayRows.filter((row): row is DisplayChoiceRow => row.kind === "choice");
  const renderedChoiceRows = renderChoiceBlock({
    innerWidth: width,
    rows: choiceRows.map((row) => row.choice),
  });
  let choiceIndex = 0;
  return displayRows.map((row) => {
    if (row.kind === "blank") return "";
    return renderedChoiceRows[choiceIndex++] ?? "";
  });
}

function resolveRows(rows: SectionedListPanelOptions["rows"]): readonly SectionedListRow[] {
  return typeof rows === "function" ? rows() : rows;
}

function runSelected(row: SelectableRow): void {
  if (row.kind === "launch") {
    row.launch();
    return;
  }
  if (row.kind === "toggle") {
    row.toggle();
    return;
  }
  row.navigate();
}

function formatRow(row: SectionedListRow, selected: boolean): ChoiceBlockRow {
  if (row.kind === "header") {
    return {
      label: MISSION_CONTROL_THEME.section(row.label),
      marker: MISSION_CONTROL_THEME.dim(" "),
    };
  }
  const marker = selected ? `    ${MISSION_CONTROL_THEME.accent("▸")}` : MISSION_CONTROL_THEME.dim("     ");
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(row.label)) : row.label;
  const trailing = getTrailing(row);
  return { label, marker, trailing };
}

function buildDisplayRows(rows: readonly SectionedListRow[], selected: number): DisplayRow[] {
  const displayRows: DisplayRow[] = [];
  let seenHeader = false;
  for (const [index, row] of rows.entries()) {
    if (row.kind === "header" && seenHeader) {
      displayRows.push({ kind: "blank" });
    }
    if (row.kind === "header") {
      seenHeader = true;
    }
    displayRows.push({
      choice: formatRow(row, index === selected),
      kind: "choice",
      sourceIndex: index,
    });
  }
  return displayRows;
}

function getTrailing(row: SelectableRow): string | undefined {
  if (row.kind === "launch") {
    const parts = [row.detail, row.trailing].filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : MISSION_CONTROL_THEME.dim(parts.join("  "));
  }
  if (row.kind === "toggle") {
    return MISSION_CONTROL_THEME.dim(row.value);
  }
  return row.detail === undefined ? undefined : MISSION_CONTROL_THEME.dim(row.detail);
}
