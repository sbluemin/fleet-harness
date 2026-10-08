import { useRef, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationClusterRow, OperationClusterRowMark } from "@fleet-console/sdk/plugin";
import { StatusGlyph, type StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import { consoleUseWrapClassName, gestureCallerLabel, getClusterListWrap, getClusterWrap, getFirstClusterWrap, getOperationWrap, subscribeConsoleUseGestures, type ConsoleUseWrap } from "../../../console-use/client/gestures.js";
import { operationMarkLabel, type OperationMarkVisual } from "../../../execution/client/operation-activity.js";
import type { ClusterIndex, ClusterLayout } from "../operation-clusters.js";
import type { SideBarEntry } from "./operations-side-bar-chip.js";
import { setSideBarFreshFoldExpanded } from "./operations-side-bar-store.js";

/**
 * 묶음 줄 — 플러그인이 `row` 로 선언한 묶음(목표)이 사이드바 그룹 트리에 서는 한 줄.
 *
 * 뿌리·구성원 칩은 이 줄로 접히고, 줄의 글리프는 그중 가장 급한 상태다. 무엇이 오늘이고 무엇이 검토 대기인지는
 * 플러그인이 판정해 넘기고, 여기서는 자리(그룹·구역·순서)와 그리기만 진다.
 */

const NO_IDS: readonly string[] = [];

/**
 * 그룹 헤더가 묶음 머리로서 감싸일 자리 — 펼친 그룹은 칸에 선 목표 줄이 있을 때 목록 읽기에, 접은 그룹은 「시작 전」까지 포함한
 * 안의 줄 표식도 대신 두른다. 목표 줄이 없는 그룹은 묶음 머리가 아니다(undefined).
 */
export function groupClusterHead(theaterId: string, sectionItems: readonly SideBarSectionItem[], foldItems: readonly SideBarRowItem[], collapsed: boolean): { readonly theaterId: string; readonly hiddenClusterIds: readonly string[] } | undefined {
  const rowIds = sectionItems.flatMap((sectionItem) => (sectionItem.kind === "row" ? [sectionItem.item.layout.cluster.id] : []));
  if (!collapsed) return rowIds.length > 0 ? { theaterId, hiddenClusterIds: NO_IDS } : undefined;
  const hidden = [...rowIds, ...foldItems.map((item) => item.layout.cluster.id)];
  return hidden.length > 0 ? { theaterId, hiddenClusterIds: hidden } : undefined;
}

/**
 * Theater 머리가 묶음 머리로서 감싸일 자리 — 그룹 없이 Theater 바로 아래 선 목표 줄의 머리는 Theater 줄이다. Theater 가 접혔거나
 * 상태 축이라 줄이 하나도 안 보이면, 그룹으로 좁힌 목록 읽기와 안의 줄 표식도 Theater 머리가 대신 두른다.
 */
export function theaterClusterHead(plan: SideBarRowPlan, rowsHidden: boolean): { readonly hiddenClusterIds: readonly string[]; readonly anyList: boolean } | undefined {
  if (!rowsHidden) {
    const ungrouped = (plan.sections.get(null) ?? []).some((sectionItem) => sectionItem.kind === "row");
    return ungrouped ? { hiddenClusterIds: NO_IDS, anyList: false } : undefined;
  }
  const items = [...plan.decisions, ...plan.today, ...[...plan.sections.values()].flatMap((list) => list.flatMap((sectionItem) => (sectionItem.kind === "row" ? [sectionItem.item] : []))), ...[...plan.folds.values()].flat()];
  return items.length > 0 ? { hiddenClusterIds: items.map((item) => item.layout.cluster.id), anyList: true } : undefined;
}

/** 줄 하나가 감싸이는 표식 — 목표 자체, 그다음 접혀 든 뿌리·구성원 Operation. 목록 읽기는 줄이 아니라 머리가 받는다. 저장된 객체를 그대로 돌린다. */
function rowWrapOf(item: SideBarRowItem): ConsoleUseWrap | null {
  const { layout, anchor, fold } = item;
  const direct = getClusterWrap(layout.cluster.id) ?? (anchor ? getOperationWrap(anchor.operation.id) : null);
  if (direct) return direct;
  for (const entry of fold) {
    const wrap = getOperationWrap(entry.operation.id);
    if (wrap) return wrap;
  }
  return null;
}

/** 묶음 머리의 표식 — 목록 읽기, 그리고 접혀 줄이 안 보일 때는 그 안의 줄 하나를 대신한다. */
export function useClusterHeadWrap(theaterId: string, groupId: string | null | undefined, hiddenClusterIds: readonly string[]): ConsoleUseWrap | null {
  return useSyncExternalStore(
    subscribeConsoleUseGestures,
    () => getFirstClusterWrap(hiddenClusterIds) ?? getClusterListWrap(theaterId, groupId),
    () => null,
  );
}

export interface SideBarRowItem {
  readonly layout: ClusterLayout;
  readonly row: OperationClusterRow;
  /** 뿌리 Operation 이 이 Theater 목록에 서 있으면 그 엔트리 — 끌기·메뉴·포커스가 그 Operation 을 탄다. */
  readonly anchor: SideBarEntry | null;
  readonly fold: readonly SideBarEntry[];
}

export type SideBarSectionItem =
  | { readonly kind: "chip"; readonly entry: SideBarEntry }
  | { readonly kind: "row"; readonly item: SideBarRowItem };

export interface SideBarRowPlan {
  /** 그룹(또는 미분류) id → 칩과 줄이 섞인 순서. */
  readonly sections: ReadonlyMap<string | null, readonly SideBarSectionItem[]>;
  /** 「결정 요청」 구역 — 요청 시각순. */
  readonly decisions: readonly SideBarRowItem[];
  /** 「오늘」 구역 — 보드 순서. */
  readonly today: readonly SideBarRowItem[];
  /** 그룹(또는 미분류) id → 그 그룹 맨 아래 「시작 전 N」 접기에 드는 줄, 보드 순서. 비었으면 키가 없다. */
  readonly folds: ReadonlyMap<string | null, readonly SideBarRowItem[]>;
}

/** 「시작 전」 접기에 드는 줄 — Operation 이 아직 없는 시작 전 목표. 개시해 뿌리가 서면 첫 턴 전이라도 빠진다. */
const foldedFresh = (item: SideBarRowItem) => item.row.glyph === "fresh" && !item.anchor && item.fold.length === 0;

// 칩 칸과 같은 셈법: 사람을 기다리는 것이 먼저, 끝난 것이 마지막.
const MARK_URGENCY: Record<OperationMarkVisual, number> = { awaiting: 0, unseen: 1, running: 2, background: 3, idle: 4, ended: 5 };

export function rowGlyphState(item: SideBarRowItem): StatusGlyphState {
  if (item.row.glyph) return item.row.glyph;
  let best: OperationMarkVisual | null = null;
  for (const entry of item.fold) {
    const mark = entry.mark ?? entry.status ?? "idle";
    if (best === null || MARK_URGENCY[mark] < MARK_URGENCY[best]) best = mark;
  }
  return best ?? "ended";
}

/**
 * 그룹 섹션의 엔트리에 묶음 줄을 섞는다. 뿌리가 선 줄은 뿌리 칩 자리를 이어받고, 뿌리 없는 줄은 같은 그룹 안에서
 * 보드 순서가 가장 가까운 줄 곁에 선다. 뿌리 없는 시작 전 줄은 섹션이 아니라 그 그룹의 「시작 전」 접기로 간다.
 * 구역으로 올라간 줄은 그룹 자리에서도 접기에서도 빠진다.
 */
export function planSideBarRows(
  sections: readonly { readonly groupId: string | null; readonly entries: readonly SideBarEntry[] }[],
  clusterIndex: ClusterIndex,
  theaterId: string | null,
): SideBarRowPlan {
  const entryById = new Map(sections.flatMap((section) => section.entries.map((entry) => [entry.operation.id, entry] as const)));
  const sectionIds = new Set(sections.map((section) => section.groupId));
  const items: SideBarRowItem[] = clusterIndex.rows
    .filter((layout) => layout.cluster.theaterId === theaterId && layout.cluster.row)
    .map((layout) => {
      const row = layout.cluster.row!;
      const fold = row.fold.flatMap((id) => { const entry = entryById.get(id); return entry ? [entry] : []; });
      const root = layout.cluster.root;
      return { layout, row, anchor: (root !== undefined ? entryById.get(root) : undefined) ?? fold[0] ?? null, fold };
    });
  const promoted = (item: SideBarRowItem) => item.row.decisionRequestedAt !== undefined || item.row.today === true;
  const decisions = items.filter((item) => item.row.decisionRequestedAt !== undefined)
    .sort((a, b) => a.row.decisionRequestedAt! - b.row.decisionRequestedAt!);
  const today = items.filter((item) => item.row.decisionRequestedAt === undefined && item.row.today === true)
    .sort((a, b) => a.row.order - b.row.order);
  const folded = new Set(items.flatMap((item) => item.fold.map((entry) => entry.operation.id)));
  const byAnchor = new Map(items.flatMap((item) => (item.anchor ? [[item.anchor.operation.id, item] as const] : [])));

  const result = new Map<string | null, SideBarSectionItem[]>();
  const folds = new Map<string | null, SideBarRowItem[]>();
  for (const section of sections) {
    const list: SideBarSectionItem[] = [];
    for (const entry of section.entries) {
      const item = byAnchor.get(entry.operation.id);
      if (item) {
        if (!promoted(item)) list.push({ kind: "row", item });
        continue;
      }
      if (folded.has(entry.operation.id)) continue;
      list.push({ kind: "chip", entry });
    }
    result.set(section.groupId, list);
  }
  for (const item of [...items].sort((a, b) => a.row.order - b.row.order)) {
    if (item.anchor || promoted(item)) continue;
    const key = item.row.groupId !== null && sectionIds.has(item.row.groupId) ? item.row.groupId : null;
    if (foldedFresh(item)) {
      folds.set(key, [...(folds.get(key) ?? []), item]);
      continue;
    }
    const list = result.get(key) ?? [];
    const placed = list.flatMap((candidate, index) => (candidate.kind === "row" ? [{ index, order: candidate.item.row.order }] : []));
    const before = placed.filter((candidate) => candidate.order < item.row.order).pop();
    const after = placed.find((candidate) => candidate.order > item.row.order);
    const at = before ? before.index + 1 : after ? after.index : list.length;
    list.splice(at, 0, { kind: "row", item });
    result.set(key, list);
  }
  return { sections: result, decisions, today, folds };
}

// 포매터 생성은 비싸다 — 줄이 다시 그려질 때마다 만들지 않고 언어별로 하나를 쓴다.
const dueFormats = new Map<ConsoleLocale, Intl.DateTimeFormat>();

function formatDue(date: string, locale: ConsoleLocale): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  let format = dueFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" });
    dueFormats.set(locale, format);
  }
  return format.format(parsed);
}

interface SideBarClusterRowProps {
  readonly item: SideBarRowItem;
  /** 구역으로 올라간 줄 — 원래 그룹 색 점. */
  readonly groupDot?: { readonly name: string; readonly color: string } | null;
  readonly dragging?: boolean;
  readonly dragOffsetY?: number;
  readonly dropTarget?: boolean;
  /** 뿌리 Operation 의 사용자 accent — 칩처럼 제목 잉크만 소유한다. */
  readonly accentValue?: string | null;
  /** 칩과 같은 포커스 경로 — 뿌리가 선 줄을 누르면 그 Operation 패널로 간다(최소화 복원·휴면·Theater 전환 포함). */
  readonly onFocus: (operationId: string) => void;
  /**
   * 「더블클릭으로 열기」 — 있으면 뿌리가 선 줄의 한 번 클릭과 Space 는 열지 않고 고르기만 하고, 더블클릭과 Enter 가 연다.
   * 터치 탭은 늘 연다. 뿌리 없는 줄(시작 전 목표)은 열 패널이 없어 그대로 플러그인 표면을 연다.
   */
  readonly onSelect?: (operationId: string) => void;
  readonly onPointerDragStart?: (event: ReactPointerEvent<HTMLLIElement>, item: SideBarRowItem) => void;
  readonly onContextMenu?: (item: SideBarRowItem, anchor: DOMRect, returnFocus: HTMLElement | null) => void;
}

export function SideBarClusterRow({ item, groupDot = null, dragging = false, dragOffsetY = 0, dropTarget = false, accentValue = null, onFocus, onSelect, onPointerDragStart, onContextMenu }: SideBarClusterRowProps) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = usePluginRegistry();
  const { layout, row, anchor } = item;
  // Console Use — 에이전트가 이 목표를 읽거나 고치면 Operation 칩과 같은 펄스로 줄 전체가 감싸인다.
  const wrap = useSyncExternalStore(subscribeConsoleUseGestures, () => rowWrapOf(item), () => null);
  const state = rowGlyphState(item);
  const label = state === "fresh"
    ? t("sidebar.row.glyph.fresh")
    : state === "review"
      ? t("sidebar.row.glyph.review")
      : state === "done"
        ? t("sidebar.row.glyph.done")
        : operationMarkLabel(state);
  // 하이라이트는 칩과 같은 조건이다 — 뿌리가 선 줄은 그 묶음의 Operation 이 캔버스에서 활성일 때만 선다. 목표 화면의 선택만으로는
  // 서지 않는다(패널과 목표 화면이 서로 다른 줄을 가리키는 이중 하이라이트가 없게). 활성이 될 수 없는 뿌리 없는 줄만 화면의 선택을 따른다.
  const active = anchor ? anchor.active || item.fold.some((entry) => entry.active) : row.selected === true;
  // 사이드바에서 고른(열지 않은) 뿌리 — 열림(면+테두리)과 다른 문법(점선 테두리)이라 한 줄 하이라이트 규칙과 겹치지 않는다.
  const selected = !active && anchor?.selected === true;
  const selectMode = onSelect !== undefined && anchor !== null;
  const minimized = anchor?.minimized === true;
  const meta: { readonly key: string; readonly text: string; readonly tone?: "req" | "late" | "from" | "accent" | "warn"; readonly prov?: true }[] = [];
  if (row.decisionRequestedAt !== undefined) meta.push({ key: "req", text: t("sidebar.row.decisions", { n: row.decisionQuestions ?? 1 }), tone: "req" });
  if (row.progress && row.progress.total > 0) meta.push({ key: "progress", text: `✓ ${row.progress.done}/${row.progress.total}` });
  if (row.due) meta.push({ key: "due", text: formatDue(row.due.date, locale), ...(row.due.overdue ? { tone: "late" as const } : {}) });
  if (row.followup) meta.push({ key: "from", text: row.followup.originTitle ? t("sidebar.row.followupOf", { title: row.followup.originTitle }) : t("sidebar.row.followup"), tone: "from" });
  row.provenance?.forEach((part, index) => {
    const text = resolveLocalizedText(part.text, locale);
    if (text) meta.push({ key: `prov-${index}`, text, prov: true, ...(part.tone ? { tone: part.tone } : {}) });
  });
  row.notes?.forEach((note, index) => {
    const text = resolveLocalizedText(note.text, locale);
    if (text) meta.push({ key: `note-${index}`, text, ...(note.tone ? { tone: note.tone } : {}) });
  });
  // 끌어 놓은 줄은 포인터를 따라왔으니 놓는 순간의 클릭도 이 줄에 떨어진다 — 칩처럼 그 클릭은 여는 동작이 아니다.
  const suppressClickRef = useRef(false);
  const pointerTypeRef = useRef("mouse");
  // 뿌리가 선 줄은 칩과 똑같이 그 패널로 간다. 플러그인 표면은 열지 않고, 이미 열려 있으면 선택 알림으로 따라오게 한다.
  // 열 패널이 없는 줄(Operation 이 아직 없는 시작 전 목표)만 플러그인이 자기 표면을 연다.
  const open = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!anchor) {
      layout.cluster.open?.();
      return;
    }
    const operationId = anchor.operation.id;
    onFocus(operationId);
    for (const provider of registry.providers) provider.onMapOperationSelected?.(operationId);
  };
  const selectAnchor = () => {
    if (onSelect && anchor) onSelect(anchor.operation.id);
  };
  // 고르기 모드의 클릭 — 키보드·보조기술이 만든 클릭(detail 0)과 터치 탭은 연다. 더블클릭의 둘째 클릭은 dblclick 이 연다.
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    if (!selectMode || event.detail === 0 || pointerTypeRef.current === "touch") {
      open();
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (event.detail === 1) selectAnchor();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!selectMode) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open();
      return;
    }
    if (event.key === " ") {
      // 캔버스의 Space-pan 과 버튼의 기본 활성화(=열기)를 모두 막고 고르기만 한다.
      event.preventDefault();
      event.stopPropagation();
      selectAnchor();
    }
  };
  const style = dragging || accentValue
    ? ({ ...(accentValue ? { "--user-accent": accentValue } : {}), ...(dragging ? { transform: `translateY(${dragOffsetY}px)` } : {}) } as CSSProperties)
    : undefined;
  return (
    <li
      className={[
        "side-bar-cluster-row",
        consoleUseWrapClassName(wrap),
        active ? "side-bar-cluster-row--active" : "",
        selected ? "side-bar-cluster-row--selected" : "",
        minimized ? "side-bar-cluster-row--minimized" : "",
        dragging ? "is-dragging" : "",
        dropTarget ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-cluster-row-id={layout.cluster.id}
      {...(anchor ? { "data-side-bar-chip-id": anchor.operation.id } : {})}
      style={style}
      onPointerDown={(event) => {
        pointerTypeRef.current = event.pointerType;
        onPointerDragStart?.(event, item);
      }}
      onPointerUp={() => {
        if (dragging) suppressClickRef.current = true;
      }}
      onContextMenu={onContextMenu ? (event: MouseEvent<HTMLLIElement>) => {
        event.preventDefault();
        onContextMenu(item, event.currentTarget.getBoundingClientRect(), event.currentTarget.querySelector<HTMLElement>(".side-bar-cluster-row-main"));
      } : undefined}
    >
      <StatusGlyph
        state={state}
        label={label}
        className="side-bar-cluster-row-glyph"
        {...(state === "review" && row.review ? { onActivate: (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); row.review!(locale); } } : {})}
      />
      <button
        type="button"
        className="side-bar-cluster-row-main"
        aria-current={active ? "true" : undefined}
        aria-description={wrap ? t("sidebar.chip.gaze", { caller: gestureCallerLabel(wrap.gesture.caller), summary: wrap.gesture.summary }) : undefined}
        aria-label={[layout.cluster.title, label, ...meta.map((part) => part.text), row.mark && !row.mark.toggle ? resolveLocalizedText(row.mark.label, locale) : "", groupDot ? groupDot.name : "", selected ? t("sidebar.row.selected") : ""].filter(Boolean).join(", ")}
        onClick={activate}
        onDoubleClick={selectMode ? () => { if (pointerTypeRef.current !== "touch" && !dragging) open(); } : undefined}
        onKeyDown={selectMode ? handleKeyDown : undefined}
        onKeyUp={selectMode ? (event) => { if (event.key === " ") event.preventDefault(); } : undefined}
      >
        <span className="side-bar-cluster-row-title">{layout.cluster.title}</span>
        {meta.length > 0 ? (
          <span className="side-bar-cluster-row-meta" aria-hidden="true">
            {meta.map((part) => (
              <span key={part.key} className={[part.tone ? `is-${part.tone}` : "", part.prov ? "is-prov" : ""].filter(Boolean).join(" ") || undefined}>{part.text}</span>
            ))}
          </span>
        ) : null}
      </button>
      {/* 표식이 토글이면 칸 안에 버튼이 서므로 칸 전체를 숨기지 않는다 — 장식인 표식과 그룹 점만 숨긴다. */}
      <span className="side-bar-cluster-row-aside" {...(row.mark?.toggle ? {} : { "aria-hidden": true })}>
        {row.mark ? (row.mark.toggle ? <ClusterRowMarkToggle mark={row.mark} toggle={row.mark.toggle} /> : <ClusterRowMark mark={row.mark} />) : null}
        {groupDot ? <span className="side-bar-cluster-row-dot" style={{ "--grp-color": groupDot.color } as CSSProperties} title={groupDot.name} aria-hidden="true" /> : null}
      </span>
    </li>
  );
}

/**
 * 줄 오른쪽 끝의 표식 — 플러그인이 정한 맡은 이가 다루는 줄. 켬·끔은 맡은 이가 돌고 있는지(스위치)이고, 맡은 이의 줄에 머무는
 * 동안은 같은 표식들이 함께 밝아진다. 플러그인이 맡은 이의 글리프를 주면 그 모양을 같은 잉크 규칙으로 칠하고, 없으면 사각을
 * 그린다. 뜻은 줄의 접근 이름이 말하므로 여기서는 제목만 단다. 「확인 필요」 목록의 줄도 같은 표식을 쓴다.
 */
export function ClusterRowMark({ mark, decorative = true }: { readonly mark: OperationClusterRowMark; readonly decorative?: boolean }) {
  const locale = useConsoleLocale();
  const label = resolveLocalizedText(mark.label, locale);
  const glyph = mark.renderGlyph?.();
  const className = ["side-bar-cluster-row-mark", glyph ? "has-glyph" : "", `is-${mark.square}`, mark.emphasized ? "is-emphasized" : ""].filter(Boolean).join(" ");
  return <i className={className} title={label} {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}>{glyph}</i>;
}

/**
 * 누르는 표식 — 표식 자체가 맡김 스위치다(줄 본문 다음의 초점 자리). 켬·끔은 `aria-pressed` 가 말하고 접근 이름은 바뀌지 않는다.
 * 꺼진 표식은 줄에 올리거나 초점이 올 때만 보인다(터치는 흐리게 늘). 줄은 누르는 순간 끌기를 시작하므로 여기서 막고, 누르고 있는
 * Enter·Space 의 반복 입력과 더블클릭의 둘째 클릭은 받지 않는다 — 한 번 누름이 한 번 바꿈이다.
 */
function ClusterRowMarkToggle({ mark, toggle }: { readonly mark: OperationClusterRowMark; readonly toggle: NonNullable<OperationClusterRowMark["toggle"]> }) {
  const locale = useConsoleLocale();
  const glyph = mark.renderGlyph?.();
  const className = ["side-bar-cluster-row-mark", glyph ? "has-glyph" : "", toggle.pressed ? `is-${mark.square}` : "is-off", toggle.pressed && mark.emphasized ? "is-emphasized" : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={`side-bar-cluster-row-mark-toggle${toggle.pressed ? " is-pressed" : ""}`}
      aria-pressed={toggle.pressed}
      aria-label={resolveLocalizedText(toggle.label, locale)}
      title={resolveLocalizedText(mark.label, locale)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail > 1) return;
        toggle.onToggle(locale);
      }}
      onKeyDown={(event) => {
        // 캔버스의 Space-pan 이 버튼의 기본 활성화를 취소하지 않게 한다(시작 전 묶음 버튼과 같은 규칙).
        if (event.code === "Space") event.stopPropagation();
        if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
      }}
    >
      <i className={className} aria-hidden="true">{glyph}</i>
    </button>
  );
}

/** 구역의 줄들이 낸 구역 머리 말 — 처음 나온 말 하나만, 같은 말은 한 번. */
export function zoneNoteOf(items: readonly SideBarRowItem[]): LocalizedText | null {
  return items.find((item) => item.row.zoneNote !== undefined)?.row.zoneNote ?? null;
}

/** 구역 머리 — 「결정 요청 N」 「오늘 N」. 접지 않는다. 줄이 낸 말(`zoneNote`)이 있으면 개수 옆에 선다. */
export function SideBarRowZone({ theaterId, zone, count, note = null, children }: { readonly theaterId: string; readonly zone: "decisions" | "today"; readonly count: number; readonly note?: LocalizedText | null; readonly children: ReactNode }) {
  const t = useT();
  const locale = useConsoleLocale();
  const title = zone === "decisions" ? t("sidebar.zone.decisions") : t("sidebar.zone.today");
  const noteText = note === null ? "" : resolveLocalizedText(note, locale);
  // 구역은 여러 그룹의 줄을 모으므로 Theater 전체 목록 읽기에만 감싸인다. 접지 않는 머리라 줄 하나를 대신하지 않는다.
  const wrap = useClusterHeadWrap(theaterId, undefined, NO_IDS);
  return (
    <li className={`side-bar-row-zone is-${zone}`} data-row-zone={zone}>
      <div className={["side-bar-row-zone-pin pin", consoleUseWrapClassName(wrap)].filter(Boolean).join(" ")} title={wrap ? `${gestureCallerLabel(wrap.gesture.caller)}: ${wrap.gesture.summary}` : undefined}>
        <span>{title}</span>
        <span className="side-bar-row-zone-count">{count}</span>
        {noteText ? <span className="side-bar-row-zone-note">{noteText}</span> : null}
        <span className="side-bar-row-zone-rim" aria-hidden="true" />
      </div>
      <ol className="side-bar-group-chips side-bar-row-zone-list" aria-label={title}>{children}</ol>
    </li>
  );
}

/**
 * 그룹 맨 아래 「시작 전 N」 접기 — 활성·비활성 Theater 가 같은 줄을 세운다. 펼침은 Theater·그룹별로 이 탭의 메모리에만 둔다.
 */
export function SideBarFreshFold({ theaterId, groupId, items, expanded, renderRow }: {
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly items: readonly SideBarRowItem[];
  readonly expanded: boolean;
  readonly renderRow: (item: SideBarRowItem) => ReactNode;
}) {
  const t = useT();
  // 접혀 있으면 안의 목표 줄이 받은 표식을 머리가 대신 두른다. 목록 읽기는 펼침과 상관없이 머리가 감싸인다.
  const wrap = useClusterHeadWrap(theaterId, groupId, expanded ? NO_IDS : items.map((item) => item.layout.cluster.id));
  return (
    <li className="side-bar-fresh-fold" data-fresh-fold={groupId ?? "__ungrouped__"}>
      <button
        type="button"
        className={["side-bar-fresh-fold-toggle", consoleUseWrapClassName(wrap)].filter(Boolean).join(" ")}
        title={wrap ? `${gestureCallerLabel(wrap.gesture.caller)}: ${wrap.gesture.summary}` : undefined}
        aria-expanded={expanded}
        aria-label={t("sidebar.fold.freshAria", { n: items.length })}
        // 캔버스의 Space-pan이 버튼의 기본 활성화를 취소하지 않게 한다. 클릭은 브라우저가 만든다.
        onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); }}
        onClick={() => setSideBarFreshFoldExpanded(theaterId, groupId, !expanded)}
      >
        <span className="side-bar-fresh-fold-rings" aria-hidden="true"><i /><i /><i /></span>
        <span aria-hidden="true">{t("sidebar.fold.fresh")}</span>
        <span className="side-bar-fresh-fold-count" aria-hidden="true">{items.length}</span>
        <span className="side-bar-fresh-fold-chev" aria-hidden="true">›</span>
      </button>
      {expanded ? (
        <ol className="side-bar-fresh-fold-body" aria-label={t("sidebar.fold.fresh")}>
          {items.map(renderRow)}
        </ol>
      ) : null}
    </li>
  );
}
