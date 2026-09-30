import { useRef, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OperationClusterRow } from "@fleet-console/sdk/plugin";
import { StatusGlyph, type StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
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

function formatDue(date: string, locale: ConsoleLocale): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" }).format(parsed);
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
  readonly onPointerDragStart?: (event: ReactPointerEvent<HTMLLIElement>, item: SideBarRowItem) => void;
  readonly onContextMenu?: (item: SideBarRowItem, anchor: DOMRect, returnFocus: HTMLElement | null) => void;
}

export function SideBarClusterRow({ item, groupDot = null, dragging = false, dragOffsetY = 0, dropTarget = false, accentValue = null, onFocus, onPointerDragStart, onContextMenu }: SideBarClusterRowProps) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = usePluginRegistry();
  const { layout, row, anchor } = item;
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
  const minimized = anchor?.minimized === true;
  const meta: { readonly key: string; readonly text: string; readonly tone?: "req" | "late" | "from" }[] = [];
  if (row.decisionRequestedAt !== undefined) meta.push({ key: "req", text: t("sidebar.row.decisions", { n: row.decisionQuestions ?? 1 }), tone: "req" });
  if (row.progress && row.progress.total > 0) meta.push({ key: "progress", text: `✓ ${row.progress.done}/${row.progress.total}` });
  if (row.due) meta.push({ key: "due", text: formatDue(row.due.date, locale), ...(row.due.overdue ? { tone: "late" as const } : {}) });
  if (row.followup) meta.push({ key: "from", text: row.followup.originTitle ? t("sidebar.row.followupOf", { title: row.followup.originTitle }) : t("sidebar.row.followup"), tone: "from" });
  // 끌어 놓은 줄은 포인터를 따라왔으니 놓는 순간의 클릭도 이 줄에 떨어진다 — 칩처럼 그 클릭은 여는 동작이 아니다.
  const suppressClickRef = useRef(false);
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
  const style = dragging || accentValue
    ? ({ ...(accentValue ? { "--user-accent": accentValue } : {}), ...(dragging ? { transform: `translateY(${dragOffsetY}px)` } : {}) } as CSSProperties)
    : undefined;
  return (
    <li
      className={[
        "side-bar-cluster-row",
        active ? "side-bar-cluster-row--active" : "",
        minimized ? "side-bar-cluster-row--minimized" : "",
        dragging ? "is-dragging" : "",
        dropTarget ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-cluster-row-id={layout.cluster.id}
      {...(anchor ? { "data-side-bar-chip-id": anchor.operation.id } : {})}
      style={style}
      onPointerDown={onPointerDragStart ? (event) => onPointerDragStart(event, item) : undefined}
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
        aria-label={[layout.cluster.title, label, ...meta.map((part) => part.text), groupDot ? groupDot.name : ""].filter(Boolean).join(", ")}
        onClick={open}
      >
        <span className="side-bar-cluster-row-title">{layout.cluster.title}</span>
        {meta.length > 0 ? (
          <span className="side-bar-cluster-row-meta" aria-hidden="true">
            {meta.map((part) => (
              <span key={part.key} className={part.tone ? `is-${part.tone}` : undefined}>{part.text}</span>
            ))}
          </span>
        ) : null}
      </button>
      {groupDot ? <span className="side-bar-cluster-row-dot" style={{ "--grp-color": groupDot.color } as CSSProperties} title={groupDot.name} aria-hidden="true" /> : <span aria-hidden="true" />}
    </li>
  );
}

/** 구역 머리 — 「결정 요청 N」 「오늘 N」. 접지 않는다. */
export function SideBarRowZone({ zone, count, children }: { readonly zone: "decisions" | "today"; readonly count: number; readonly children: ReactNode }) {
  const t = useT();
  const title = zone === "decisions" ? t("sidebar.zone.decisions") : t("sidebar.zone.today");
  return (
    <li className={`side-bar-row-zone is-${zone}`} data-row-zone={zone}>
      <div className="side-bar-row-zone-pin pin">
        <span>{title}</span>
        <span className="side-bar-row-zone-count">{count}</span>
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
  return (
    <li className="side-bar-fresh-fold" data-fresh-fold={groupId ?? "__ungrouped__"}>
      <button
        type="button"
        className="side-bar-fresh-fold-toggle"
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
