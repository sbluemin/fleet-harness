import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronGlyph, ConfirmDialog, MenuCheckGlyph } from "@fleet-console/ui/react";
import {
  consoleSectionManageable,
  consoleSwitchBlocked,
  type ConsoleSections,
} from "../../../remote-access/client/console-sections.js";
import type { ConsoleSectionEntry } from "@fleet-console/protocol/desktop/console-section";
import type {
  UnifiedSidebarCommand,
  UnifiedSidebarMachine,
  UnifiedSidebarRef,
  UnifiedSidebarRow,
} from "@fleet-console/protocol/desktop/console-section";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { IDENTITY_TONES, isIdentityTone } from "../../shared/identity-tones.js";
import { commodoreAvatarKey, fallbackMongleBase } from "../../shared/avatars.js";
import { MongleAvatar } from "../components/mongle-avatar.js";
import { openCommanderConversation } from "../commander-tab/commander-navigation.js";
import { openCommanderRowGlyphTab } from "../commander-tab/commander-popups.js";
import { useSideBarState } from "./objective-records-side-bar-store.js";
import { useLongPress } from "../long-press.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { CommanderRosterRow, currentRightPanel } from "./console-roster.js";
import { MenuItem, SectionMenu, SectionNameInput } from "./commodore-sidebar-sections.js";
import { PlusIcon, SectionMoveIcon, TrashIcon, PencilIcon } from "./sidebar-menu-icons.js";
import { commodoreSectionDropFromPoint, theaterDropIndexFromPoint, type CommodoreSectionDrop } from "./objective-records-side-bar-hit-test.js";
import type { UnifiedSidebarController } from "./unified-sidebar.js";
import type { SidebarCommodore } from "../../../commodore/client/commodore-list.js";
import "./commodore-sidebar-sections.css";
import "../../../remote-access/client/console-sections.css";

const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

/** 드래그 중에 목록 끝자리에 다가가면 목록을 밀어 준다 — 로컬 끌기와 같은 간격·폭이다. */
function autoScrollUnifiedSideBar(clientY: number, chipsElement: HTMLElement | null): void {
  if (!chipsElement) return;
  const rect = chipsElement.getBoundingClientRect();
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop -= AUTO_SCROLL_STEP_PX;
  } else if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop += AUTO_SCROLL_STEP_PX;
  }
}

/** 통합 배치 행 키 — 셸 명령의 ref와 같은 두 id를 잇는다. data-theater-id에도 이 값을 둔다. */
export function unifiedRowKey(ref: UnifiedSidebarRef): string {
  return `${ref.consoleId}\n${ref.commodoreId}`;
}

function parseUnifiedRowKey(key: string): UnifiedSidebarRef | null {
  const index = key.indexOf("\n");
  if (index <= 0 || index === key.length - 1) return null;
  return { consoleId: key.slice(0, index), commodoreId: key.slice(index + 1) };
}

/** 머신 칩의 색 — 같은 보는 컴퓨터에서는 같은 머신이 늘 같은 톤으로 선다. 테마를 아는 기존 토큰만 쓴다. */
export function unifiedMachineTone(consoleId: string): string {
  let hash = 0;
  for (let index = 0; index < consoleId.length; index += 1) hash = (hash * 31 + consoleId.charCodeAt(index)) | 0;
  return IDENTITY_TONES[Math.abs(hash) % IDENTITY_TONES.length]!;
}

/**
 * 셸 진입점. `entryId`는 이 창의 불투명 id라 이름·주소가 같은 머신도 갈리지 않는다.
 * 옛 셸이 id를 안 실으면 이름·주소로 남긴다.
 */
export function unifiedEntryForMachine<T extends { readonly id: string; readonly home: boolean; readonly label: string; readonly address: string }>(entries: readonly T[], machine: { readonly entryId?: string; readonly home: boolean; readonly label: string; readonly address: string }): T | null {
  if (machine.entryId) {
    const match = entries.find((entry) => entry.id === machine.entryId);
    if (match) return match;
  }
  if (machine.home) return entries.find((entry) => entry.home) ?? null;
  return entries.find((entry) => !entry.home && entry.label === machine.label && entry.address === machine.address)
    ?? entries.find((entry) => !entry.home && entry.label === machine.label)
    ?? null;
}
export function unifiedEntryForRow<T extends { readonly id: string; readonly home: boolean; readonly label: string; readonly address: string }>(entries: readonly T[], row: Pick<UnifiedSidebarRow, "home" | "machineLabel" | "machineAddress" | "entryId">): T | null {
  return unifiedEntryForMachine(entries, { entryId: row.entryId, home: row.home, label: row.machineLabel, address: row.machineAddress });
}

function rowBlocked(entry: ConsoleSectionEntry | null, status: UnifiedSidebarRow["status"]): boolean {
  if (entry) return consoleSwitchBlocked(entry);
  return status === "unreachable" || status === "untrusted" || status === "stopping";
}

interface UnifiedDragState {
  readonly sourceKey: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
  readonly sectionDrop: CommodoreSectionDrop | null;
}

/**
 * 서 있는 콘솔 행에만 붙는 기존 사령관 동작. 항목과 조건은 비통합 분기의 TheaterActionsMenu와 같고,
 * 자리만 통합 행의 ⋯ 메뉴(통합 이동·새 섹션 아래)와 행 머리(별칭 입력)다. 다른 머신 행에는 주지 않는다.
 */
export interface UnifiedStandingMenu {
  readonly renderItems: (row: UnifiedSidebarRow, onClose: () => void, opener: HTMLElement | null) => ReactNode;
  readonly renderAliasEditor: (row: UnifiedSidebarRow) => ReactNode;
}

/**
 * 통합 사이드바 — 머신 머리글과 머신별 섹션 반복 없이, 배치 한 벌에 모든 머신의 사령관을 그린다.
 * 셸 능력이 없을 때(브라우저·모바일·옛 셸)는 호출자가 옛 경로를 그대로 그린다.
 */
export function UnifiedSidebarList({ consoles, list, unified, standingCommodores, owningCommodoreId, onOpenHomeCommodore, standingMenu }: {
  readonly consoles: ConsoleSections;
  readonly standingCommodores: readonly SidebarCommodore[];
  readonly list: () => HTMLElement | null;
  readonly unified: UnifiedSidebarController;
  /** 지금 문서가 연 사령관 — 같은 이름이 여러 머신에 있어도 지금 콘솔의 것만 밝힌다. */
  readonly owningCommodoreId: string | null;
  /** 집 행을 지금 문서(집)에서 여는 일 — 부모의 사령관 머리 열기와 같다. */
  readonly onOpenHomeCommodore: (row: UnifiedSidebarRow) => void;
  /** 서 있는 콘솔 행의 기존 사령관 동작. 없으면 통합 이동·새 섹션만 둔다. */
  readonly standingMenu?: UnifiedStandingMenu | null;
}) {
  const t = useT();
  const compact = useSideBarState().compact;
  const layout = unified.layout;
  const [drag, setDrag] = useState<UnifiedDragState | null>(null);
  const dragRef = useRef<UnifiedDragState | null>(null);
  const orderedKeysRef = useRef<readonly string[]>([]);
  const runRef = useRef(unified.run);
  runRef.current = unified.run;
  const runLayoutSections = useRef(layout?.sections.length ?? 0);
  runLayoutSections.current = layout?.sections.length ?? 0;

  // 인증서가 바뀐 머신의 마지막 목록은 그리지 않는다 — 행이 없으면 맨 아래 알림 줄이 재검토로 이끈다. 배치는 layout.order에 남는다.
  const rows = useMemo(() => {
    const standingById = new Map(standingCommodores.map((commodore) => [commodore.commodoreId, commodore]));
    return unified.rows.filter((row) => row.status !== "untrusted").map((row) => {
      // 서 있는 콘솔의 이름은 비통합 행과 같은 목록이 소유한다 — 셸의 주기 명부는 다른 콘솔·첫 목록 수신 전의 표시만 맡는다.
      const commodore = unifiedEntryForRow(consoles.entries, row)?.active ? standingById.get(row.commodoreId) : null;
      return commodore ? { ...row, name: commodore.label } : row;
    });
  }, [unified.rows, consoles.entries, standingCommodores]);
  const byKey = useMemo(() => {
    const map = new Map<string, UnifiedSidebarRow>();
    for (const row of rows) map.set(unifiedRowKey(row), row);
    return map;
  }, [rows]);
  const orderedKeys = useMemo(() => {
    if (!layout) return [];
    const keys = layout.order.map(unifiedRowKey);
    for (const row of rows) {
      const key = unifiedRowKey(row);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }, [layout, rows]);
  useEffect(() => { orderedKeysRef.current = orderedKeys; });

  const membership = useMemo(() => {
    const map = new Map<string, string>();
    if (!layout) return map;
    for (const item of layout.membership) map.set(unifiedRowKey(item), item.sectionId);
    return map;
  }, [layout]);

  const updateDrag = (next: UnifiedDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const dragPointerId = drag?.pointerId ?? null;
  useEffect(() => {
    if (dragPointerId === null) return;
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const current = dragRef.current;
      if (!current) return;
      if (event.buttons === 0) {
        updateDrag(null);
        return;
      }
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (!current.dragging && distance < DRAG_THRESHOLD_PX) return;
      if (current.dragging) event.preventDefault();
      const chips = list();
      autoScrollUnifiedSideBar(event.clientY, chips);
      const dropIndex = theaterDropIndexFromPoint(event.clientY, orderedKeysRef.current, chips instanceof HTMLOListElement ? chips : null, current.sourceKey);
      const sectionDrop = commodoreSectionDropFromPoint(event.clientX, event.clientY, chips, current.sourceKey);
      updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex, sectionDrop });
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const snap = dragRef.current;
      updateDrag(null);
      if (!snap?.dragging) return;
      const row = parseUnifiedRowKey(snap.sourceKey);
      if (!row) return;
      const drop = snap.sectionDrop;
      const sectionCount = runLayoutSections.current;
      if (drop) {
        const target = drop.targetId ? parseUnifiedRowKey(drop.targetId) : null;
        if (drop.targetId && !target) return;
        runRef.current({
          op: "move", row, sectionId: drop.sectionId,
          ...(target ? { target, ...(drop.after === true ? { after: true as const } : {}) } : {}),
        });
        return;
      }
      // 섹션이 있으면 빈 틈에 떨어뜨린 끌기는 버린다 — 로컬 끌기와 같다. 섹션이 하나도 없을 때만 평평한 한 줄의 순서로 기록한다.
      if (sectionCount > 0) return;
      const rest = orderedKeysRef.current.filter((key) => key !== snap.sourceKey);
      const bounded = Math.max(0, Math.min(snap.dropIndex, rest.length));
      if (bounded >= rest.length) {
        const last = rest[rest.length - 1];
        const target = last ? parseUnifiedRowKey(last) : null;
        if (target) runRef.current({ op: "move", row, sectionId: null, target, after: true });
        return;
      }
      const target = parseUnifiedRowKey(rest[bounded]!);
      if (target) runRef.current({ op: "move", row, sectionId: null, target });
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      updateDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragPointerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginRowPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0) return;
    if (!orderedKeysRef.current.includes(key)) return;
    updateDrag({
      sourceKey: key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: orderedKeysRef.current.indexOf(key),
      sectionDrop: null,
    });
  };

  if (!layout) return null;
  const sections = layout.sections;
  const standingHome = consoles.active?.home === true;
  const bucket = (sectionId: string | null) => orderedKeys.filter((key) => {
    if (!byKey.has(key)) return false;
    return (membership.get(key) ?? null) === sectionId;
  });

  const renderRow = (key: string, flat: boolean) => {
    const row = byKey.get(key);
    if (!row) return null;
    const index = orderedKeys.indexOf(key);
    const target = drag?.sectionDrop?.targetId === key;
    return <UnifiedCommodoreRow key={key} rowKey={key} row={row} consoles={consoles} list={list}
      compact={compact} standingHome={standingHome} unified={unified} owningCommodoreId={owningCommodoreId} onOpenHomeCommodore={onOpenHomeCommodore} standingMenu={standingMenu}
      dragging={drag?.sourceKey === key && drag.dragging} dragOffsetY={drag?.sourceKey === key && drag.dragging ? drag.currentY - drag.startY : 0}
      dropBefore={drag !== null && drag.dragging && drag.sourceKey !== key
        && (flat ? !drag.sectionDrop && drag.dropIndex === index : target && drag.sectionDrop?.after !== true)}
      dropAfter={drag !== null && drag.dragging && drag.sourceKey !== key
        && (flat ? !drag.sectionDrop && index === orderedKeys.length - 1 && drag.dropIndex === orderedKeys.length : target && drag.sectionDrop?.after === true)}
      onPointerDragStart={beginRowPointerDrag} />;
  };

  return <>
    {sections.map((section, index) => {
      const keys = bucket(section.id);
      const collapsed = compact ? false : section.collapsed;
      const dropTarget = !!drag?.dragging && !!drag.sectionDrop && !drag.sectionDrop.targetId && drag.sectionDrop.sectionId === section.id;
      return <UnifiedSection key={section.id} sectionId={section.id} name={section.name} collapsed={collapsed}
        count={keys.length} dropTarget={dropTarget} unified={unified} index={index} total={sections.length}>
        {collapsed ? null : keys.map((key) => renderRow(key, false))}
      </UnifiedSection>;
    })}
    {/* 섹션이 없으면 평평한 한 줄, 있으면 「섹션 없음」 머리로 둔다 — 로컬 목록과 같은 자리다. */}
    {sections.length === 0
      ? bucket(null).map((key) => renderRow(key, true))
      : <UnifiedSection sectionId={null} name={t("sidebar.commodoreSection.none")} collapsed={compact ? false : layout.unsectionedCollapsed}
          count={bucket(null).length} dropTarget={!!drag?.dragging && !!drag.sectionDrop && !drag.sectionDrop.targetId && drag.sectionDrop.sectionId === null}
          unified={unified} index={-1} total={sections.length}>
          {bucket(null).map((key) => renderRow(key, false))}
        </UnifiedSection>}
    <UnifiedMachineNotices consoles={consoles} machines={unified.machines} rows={rows} />
  </>;
}

/** 통합 배치의 섹션 머리 — 이름 바꾸기·옮기기·접기·지우기를 셸 명령으로만 기록한다. */
function UnifiedSection({ sectionId, name, collapsed, count, dropTarget, unified, index, total, children }: {
  readonly sectionId: string | null;
  readonly name: string;
  readonly collapsed: boolean;
  readonly count: number;
  readonly dropTarget: boolean;
  readonly unified: UnifiedSidebarController;
  readonly index: number;
  readonly total: number;
  readonly children: ReactNode;
}) {
  const t = useT();
  const compact = useSideBarState().compact;
  const header = useRef<HTMLButtonElement>(null);
  const restoreNameFocus = useRef(false);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [menuFocusFirst, setMenuFocusFirst] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useLayoutEffect(() => {
    if (restoreNameFocus.current && !editing) {
      restoreNameFocus.current = false;
      header.current?.focus({ preventScroll: true });
    }
  }, [editing]);
  const openMenu = (anchor: DOMRect, focusFirst = false) => {
    setMenuFocusFirst(focusFirst);
    if (sectionId !== null) setMenu(anchor);
  };
  const longPress = useLongPress<HTMLButtonElement>((element) => openMenu(element.getBoundingClientRect()));
  const closeMenu = () => { setMenu(null); header.current?.focus({ preventScroll: true }); };
  const run = (command: UnifiedSidebarCommand) => { closeMenu(); unified.run(command); };

  return <li className={`workspace-commodore-section${dropTarget ? " is-drop-target" : ""}`} data-sidebar-section={sectionId ?? ""}>
    {compact ? null : editing && sectionId !== null ? <SectionNameInput name={name} onDone={(value, viaKey) => {
      restoreNameFocus.current = viaKey;
      setEditing(false);
      if (sectionId !== null && value && value !== name) unified.run({ op: "rename", sectionId, name: value });
    }} /> : <button ref={header} type="button" className={`workspace-commodore-section-head${menu && sectionId !== null ? " is-menu-target" : ""}`}
      data-sidebar-section-drop={sectionId ?? ""} aria-expanded={!collapsed} title={name}
      onClick={() => { unified.run({ op: "collapse", sectionId, collapsed: !collapsed }); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!longPress.claimContextMenu(event)) openMenu(new DOMRect(event.clientX, event.clientY, 0, 0)); }}
      onPointerDown={longPress.onPointerDown} onPointerMove={longPress.onPointerMove} onPointerUp={longPress.onPointerUp} onPointerCancel={longPress.onPointerCancel}
      onKeyDown={(event) => {
        if (sectionId !== null && event.key === "F2") { event.preventDefault(); setEditing(true); }
        if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); openMenu(event.currentTarget.getBoundingClientRect(), true); }
      }}>
      <span className="workspace-commodore-section-label">{name}</span>
      {collapsed ? <span className="workspace-commodore-section-count">{count}</span> : null}
      <ChevronGlyph direction={collapsed ? "right" : "down"} className="workspace-commodore-section-chevron" />
    </button>}
    {!collapsed ? <ol className="workspace-commodore-section-rows">
      {count > 0 ? children : <li className="workspace-commodore-section-empty" data-sidebar-section-drop={sectionId ?? ""} aria-hidden={compact ? true : undefined}>{compact ? null : t("sidebar.commodoreSection.empty")}</li>}
    </ol> : null}
    {menu && sectionId !== null ? <SectionMenu anchor={menu} focusFirst={menuFocusFirst} opener={header.current} label={t("sidebar.commodoreSection.actions", { name })} onClose={closeMenu}>
      <MenuItem icon={<PencilIcon />} onClick={() => { closeMenu(); setEditing(true); }}>{t("sidebar.commodoreSection.rename")}</MenuItem>
      <MenuItem icon={<ChevronGlyph direction="up" />} disabled={index <= 0} onClick={() => run({ op: "reorder", sectionId, direction: "up" })}>{t("sidebar.commodoreSection.up")}</MenuItem>
      <MenuItem icon={<ChevronGlyph direction="down" />} disabled={index >= total - 1} onClick={() => run({ op: "reorder", sectionId, direction: "down" })}>{t("sidebar.commodoreSection.down")}</MenuItem>
      <MenuItem icon={<PlusIcon />} onClick={() => { closeMenu(); unified.run({ op: "create", name: t("sidebar.commodoreSection.defaultName"), afterId: sectionId }); }}>{t("sidebar.commodoreSection.createBelow")}</MenuItem>
      <div className="theater-menu-divider" role="separator" />
      <MenuItem icon={<TrashIcon />} danger onClick={() => { setMenu(null); setDeleting(true); }}>{t("sidebar.commodoreSection.deleteMenu")}</MenuItem>
    </SectionMenu> : null}
    {deleting && sectionId !== null ? <ConfirmDialog question={t("sidebar.commodoreSection.deleteQuestion", { name })} cancelLabel={t("sidebar.commodore.cancel")}
      confirmLabel={t("sidebar.commodoreSection.delete")} danger busy={false} error={null}
      onCancel={() => setDeleting(false)}
      onConfirm={() => { setDeleting(false); unified.run({ op: "delete", sectionId, confirm: true }); }} /> : null}
  </li>;
}

/** 통합 배치의 사령관 행 — 집 행에는 칩이 없고, 다른 머신 행에는 이름 바로 오른쪽에 머신 칩이 선다. */
function UnifiedCommodoreRow({ rowKey, row, consoles, list, compact, standingHome, unified, owningCommodoreId, onOpenHomeCommodore, standingMenu, dragging, dragOffsetY, dropBefore, dropAfter, onPointerDragStart }: {
  readonly rowKey: string;
  readonly row: UnifiedSidebarRow;
  readonly consoles: ConsoleSections;
  readonly list: () => HTMLElement | null;
  readonly compact: boolean;
  readonly standingHome: boolean;
  readonly unified: UnifiedSidebarController;
  readonly owningCommodoreId: string | null;
  readonly onOpenHomeCommodore: (row: UnifiedSidebarRow) => void;
  readonly standingMenu?: UnifiedStandingMenu | null;
  readonly dragging: boolean;
  readonly dragOffsetY: number;
  readonly dropBefore: boolean;
  readonly dropAfter: boolean;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, key: string) => void;
}) {
  const t = useT();
  const entry = unifiedEntryForRow(consoles.entries, row);
  const blocked = rowBlocked(entry, row.status);
  // 지금 문서가 서 있는 콘솔의 행(집이든 원격이든)은 문서 안에서 연다. 같은 콘솔 안에서까지 셸 전환을 타면 문서가 다시 뜨면서 상태가 깨진다.
  const standingHere = entry?.active === true;
  const homeHere = standingHere || (row.home && standingHome);
  // 같은 이름의 사령관이 여러 머신에 있을 때, 지금 서 있는 콘솔의 그 사령관만 현재로 밝힌다.
  const current = owningCommodoreId !== null && row.commodoreId === owningCommodoreId
    && (row.home ? standingHome : entry?.active === true);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [menuFocusFirst, setMenuFocusFirst] = useState(false);
  const [chipCard, setChipCard] = useState<DOMRect | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const longPress = useLongPress<HTMLDivElement>((element) => openMenu(element.getBoundingClientRect(), returnFocusRef.current));
  const openMenu = (anchor: DOMRect, returnFocus: HTMLElement | null, focusFirst = false) => {
    returnFocusRef.current = returnFocus;
    setMenuFocusFirst(focusFirst);
    setMenu(anchor);
  };
  const closeMenu = () => {
    setMenu(null);
    const target = returnFocusRef.current;
    if (document.hasFocus()) target?.focus();
  };

  const open = (commanderId: string | null, rowEl: HTMLElement) => {
    // 서 있는 콘솔의 행은 전환 차단과 무관하게 문서 안에서 연다 — 차단 규칙은 다른 콘솔로 넘어갈 때만 본다.
    if (!homeHere && blocked) return;
    setMenu(null);
    setChipCard(null);
    if (homeHere) {
      if (commanderId !== null) openCommanderConversation(row.commodoreId, commanderId);
      else onOpenHomeCommodore(row);
      return;
    }
    if (!entry) return;
    const box = list();
    const top = box?.getBoundingClientRect().top ?? 0;
    const anchorY = Math.max(0, Math.round(rowEl.getBoundingClientRect().top - top));
    const scrollTop = Math.max(0, Math.round(box?.scrollTop ?? 0));
    consoles.command({
      switch: entry.id, commodore: row.commodoreId, anchorY, scrollTop, rightPanel: currentRightPanel(),
      ...(commanderId !== null ? { commander: commanderId } : {}),
    });
  };

  const look = row.look ?? { base: fallbackMongleBase(commodoreAvatarKey(row.commodoreId)), tone: null };
  const tone = look.tone !== null && isIdentityTone(look.tone) ? look.tone : null;
  // 서 있는 콘솔의 행에만 기존 사령관 동작을 둔다 — 별칭 입력은 행 머리에, 나머지는 ⋯ 메뉴의 통합 이동 아래에.
  const standingRow = standingHere && standingMenu ? row : null;
  const aliasEditor = standingRow && standingMenu ? standingMenu.renderAliasEditor(standingRow) : null;
  const previewText = row.preview && row.preview.length > 0 ? row.preview : t("sidebar.commodore.noConversation");
  const commanders = row.commanders ?? [];
  const moreCommanders = row.moreCommanders ?? 0;
  const dim = row.status === "unreachable";

  if (compact) {
    return <li className={`side-bar-theater-section${current ? " side-bar-theater-section--active" : ""}${dim ? " is-unified-dim" : ""}`} data-theater-id={rowKey} data-commodore-id={row.commodoreId}>
      <button type="button" className="unified-compact-row" title={`${row.name}${row.home ? "" : ` · ${row.machineLabel}`}`}
        aria-label={row.name} aria-disabled={blocked && !homeHere || undefined}
        onClick={(event) => open(null, event.currentTarget)}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openMenu(new DOMRect(event.clientX, event.clientY, 0, 0), null); }}>
        <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
          <MongleAvatar base={look.base} tone={tone} role="commodore" state="idle" size={32} label={row.name} decorative />
        </span>
      </button>
      {aliasEditor}
      {menu ? <UnifiedRowMenu anchor={menu} focusFirst={menuFocusFirst} opener={null} label={row.name} unified={unified} rowKey={rowKey} onClose={closeMenu} standingRow={standingRow} standingMenu={standingMenu} /> : null}
    </li>;
  }

  return <li className={`side-bar-theater-section${current ? " side-bar-theater-section--active" : ""}${dropBefore ? " side-bar-theater-section--drop-before" : ""}${dropAfter ? " side-bar-theater-section--drop-after" : ""}${dim ? " is-unified-dim" : ""}`}
    data-theater-id={rowKey} data-commodore-id={row.commodoreId}>
    <div
      className={`side-bar-theater-header is-card unified-row-head${dragging ? " side-bar-theater-header--dragging" : ""}`}
      style={dragging ? ({ "--drag-dy": `${Math.round(dragOffsetY)}px` } as CSSProperties) : undefined}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest(".unified-machine-chip, .unified-row-menu-trigger, .commander-row-glyph")) return;
        event.preventDefault();
        if (longPress.claimContextMenu(event)) return;
        openMenu(new DOMRect(event.clientX, event.clientY, 0, 0), null);
      }}
      onPointerDown={(event) => {
        if (event.target instanceof Element && (event.target.closest(".unified-machine-chip, .unified-row-menu-trigger, .commander-row-glyph") || event.target.closest("button.unified-machine-chip"))) return;
        longPress.onPointerDown(event);
        onPointerDragStart(event, rowKey);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={() => { longPress.onPointerUp(); }}
      onPointerCancel={longPress.onPointerCancel}
    >
      {/* 별칭 편집 중에는 머리 글자 자리에 입력이 선다 — 비통합 분기와 같은 입력이다. */}
      {aliasEditor ?? <button
        type="button"
        className="side-bar-theater-activate"
        aria-disabled={blocked && !homeHere || undefined}
        title={row.home ? row.name : `${row.name} · ${row.machineLabel}`}
        onClick={(event) => open(null, event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          openMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget, true);
        }}
      >
        <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
          <MongleAvatar base={look.base} tone={tone} role="commodore" state="idle" size={32} label={row.name} decorative />
        </span>
        <span className="side-bar-theater-text">
          <span className="unified-row-line">
            <span className="side-bar-theater-name">{row.name}</span>
            {row.home ? null : <UnifiedMachineChip row={row} onOpenCard={(anchor) => setChipCard(anchor)} />}
          </span>
          <span className="side-bar-theater-sub">{previewText}</span>
        </span>
      </button>}
      <button type="button" className="unified-row-menu-trigger" aria-label={t("sidebar.commodoreSection.actions", { name: row.name })}
        title={t("sidebar.commodoreSection.actions", { name: row.name })}
        onClick={(event) => openMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget, event.detail === 0)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="12.5" cy="8" r="1" fill="currentColor" /></svg>
      </button>
    </div>
    {!compact && (commanders.length > 0 || moreCommanders > 0) ? <div className="side-bar-commander-list" data-keep-objective-active="">
      <div className="commander-tab">
        <ol className="commander-tab-list side-bar-group-chips">
          {commanders.map((commander) => <CommanderRosterRow key={commander.id} commodoreId={row.commodoreId} commander={commander} blocked={blocked && !homeHere}
            onOpen={(rowEl) => open(commander.id, rowEl)}
            onGlyph={homeHere ? (tab, opener) => openCommanderRowGlyphTab(commander.id, tab, opener) : undefined} />)}
        </ol>
        {moreCommanders > 0 ? <p className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(moreCommanders) })}</p> : null}
      </div>
    </div> : null}
    {menu ? <UnifiedRowMenu anchor={menu} focusFirst={menuFocusFirst} opener={returnFocusRef.current} label={row.name} unified={unified} rowKey={rowKey} onClose={closeMenu} standingRow={standingRow} standingMenu={standingMenu} /> : null}
    {chipCard && !row.home ? <UnifiedMachineCard anchor={chipCard} row={row} entry={entry} consoles={consoles} onClose={() => setChipCard(null)} /> : null}
  </li>;
}

/** 다른 머신 행의 이름 옆 칩. 이름이 길면 이름이 먼저 줄고 칩은 남는다. */
function UnifiedMachineChip({ row, onOpenCard }: {
  readonly row: UnifiedSidebarRow;
  readonly onOpenCard: (anchor: DOMRect) => void;
}) {
  const t = useT();
  const tone = unifiedMachineTone(row.consoleId);
  return <button type="button" className="unified-machine-chip"
    style={{ "--mc": `var(--id-${tone})` } as CSSProperties}
    aria-label={t("sidebar.unified.machineInfo", { machine: row.machineLabel })}
    title={t("sidebar.unified.machineInfo", { machine: row.machineLabel })}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onOpenCard(event.currentTarget.getBoundingClientRect());
    }}>
    <span>{row.machineLabel}</span>
  </button>;
}

/** 칩을 누르면 나오는 머신 카드 — 이름·주소·상태와 「이 콘솔 관리」 진입. 저장된 원격 머신은 이름 바꾸기·잊기도 옛 머리글 폼과 같은 규칙으로 여기서 든다. */
function UnifiedMachineCard({ anchor, row, entry, consoles, onClose }: {
  readonly anchor: DOMRect;
  readonly row: UnifiedSidebarRow;
  readonly entry: ConsoleSectionEntry | null;
  readonly consoles: ConsoleSections;
  readonly onClose: () => void;
}) {
  const t = useT();
  const status = row.status === "unreachable" ? t("chrome.hosts.unreachable")
    : row.status === "untrusted" ? t("chrome.hosts.untrusted")
    : row.status === "stopping" ? t("chrome.hosts.stopping")
    : row.status === "slow" ? t("chrome.hosts.slow")
    : row.status === "ready" ? t("sidebar.unified.connected")
    : null;
  const manageable = entry !== null && consoleSectionManageable(entry);
  // 이웃 로컬 콘솔에는 「이 콘솔 관리」만 두고, 저장된 원격 호스트에만 이름 바꾸기·잊기를 둔다.
  const remote = entry !== null && entry.kind === "remote";
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry?.label ?? row.machineLabel);
  return <SectionMenu anchor={anchor} focusFirst={false} opener={null} label={row.machineLabel} onClose={onClose}>
    <div className="unified-machine-card" role="presentation">
      <b>{row.machineLabel}</b>
      <div>{row.machineAddress}{status ? ` · ${status}` : ""}</div>
      {manageable && entry ? <button type="button" className="side-console-cert"
        onClick={() => { onClose(); consoles.command({ manage: entry.id }); }}>{t("chrome.consoles.manageThis")}</button> : null}
      {remote && entry && !editing ? <button type="button" className="side-console-cert unified-machine-rename"
        aria-label={`${entry.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")}
        onClick={() => { setName(entry.label); setEditing(true); }}>{t("settings.remote.hosts.rename")}</button> : null}
      {remote && entry && editing ? <form className="side-console-form unified-machine-rename-form" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; consoles.command({ rename: { id: entry.id, label: next } }); setEditing(false); }}>
        <input autoFocus aria-label={t("settings.remote.hosts.rename")} value={name} maxLength={120} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} />
        <div><button type="submit" disabled={!name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
          {/* 빼기 전의 확인은 셸이 자기 대화상자로 묻는다 — 여기서 한 번 더 묻지 않는다. */}
          {!entry.active ? <button type="button" className="is-danger unified-machine-forget" aria-label={`${entry.label}: ${t("settings.remote.hosts.forget")}`} title={t("settings.remote.hosts.forget")} onClick={() => { onClose(); consoles.command({ forget: entry.id }); setEditing(false); }}>{t("settings.remote.hosts.forget")}</button> : null}</div>
      </form> : null}
    </div>
  </SectionMenu>;
}

/** 행의 ⋯·우클릭 메뉴 — 어느 머신 행이든 임의 섹션에 넣는다. 셸 명령으로만 기록한다. */
function UnifiedRowMenu({ anchor, focusFirst, opener, label, unified, rowKey, onClose, standingRow, standingMenu }: {
  readonly anchor: DOMRect;
  readonly focusFirst: boolean;
  readonly opener: HTMLElement | null;
  readonly label: string;
  readonly unified: UnifiedSidebarController;
  readonly rowKey: string;
  readonly onClose: () => void;
  /** 서 있는 콘솔의 행에만 든다. 없으면 통합 이동·새 섹션만 보인다. */
  readonly standingRow?: UnifiedSidebarRow | null;
  readonly standingMenu?: UnifiedStandingMenu | null;
}) {
  const t = useT();
  const layout = unified.layout;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const submenu = useRef<HTMLDivElement>(null);
  const id = useRef(`unified-move-${Math.random().toString(36).slice(2)}`).current;
  useContextMenuKeyboard({ open, menuSelector: `[data-unified-submenu="${id}"]`, returnFocusRef: { current: opener }, focusFirst, onEscape: () => { setOpen(false); opener?.focus(); } });
  useLayoutEffect(() => {
    if (!open || !submenu.current) return;
    const rect = submenu.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, anchor.left + 180 > window.innerWidth ? anchor.left - rect.width : anchor.right), top: Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8)) });
  }, [open, anchor]);
  useEffect(() => {
    if (!open) return;
    const element = anchorElementAt(anchor, null);
    const onScroll = (event: Event) => { if (scrollMovesAnchor(event, anchor, element)) { setOpen(false); onClose(); } };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open, anchor, onClose]);

  const row = parseUnifiedRowKey(rowKey);
  const sections: readonly { readonly id: string | null; readonly name: string }[] = layout
    ? [...layout.sections.map((section) => ({ id: section.id as string | null, name: section.name })), { id: null, name: t("sidebar.commodoreSection.none") }]
    : [{ id: null, name: t("sidebar.commodoreSection.none") }];
  const current = layout?.membership.find((item) => unifiedRowKey(item) === rowKey)?.sectionId ?? null;
  const move = (sectionId: string | null) => {
    onClose();
    if (row) unified.run({ op: "move", row, sectionId });
  };
  return <SectionMenu anchor={anchor} focusFirst={focusFirst} opener={opener} label={t("sidebar.commodoreSection.actions", { name: label })} onClose={() => { setOpen(false); onClose(); }}>
    <div className="workspace-commodore-section-move" onPointerEnter={() => { setOpen(true); }} onPointerLeave={() => setOpen(false)}>
      <button type="button" role="menuitem" className="theater-menu-item" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setOpen(true); } }}>
        <span className="theater-menu-check" aria-hidden="true"><SectionMoveIcon /></span>
        <span className="theater-menu-label">{t("sidebar.commodoreSection.move")}</span><ChevronGlyph direction="right" />
      </button>
      {open ? <div ref={submenu} data-unified-submenu={id} className="theater-menu workspace-commodore-section-submenu" role="menu"
        aria-label={t("sidebar.commodoreSection.move")} style={{ position: "fixed", ...position }}
        onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
        {sections.map((section) => <button type="button" role="menuitemradio" aria-checked={current === section.id} key={section.id ?? "none"}
          className="theater-menu-item" onClick={() => move(section.id)}>
          <span className="theater-menu-check" aria-hidden="true">{current === section.id ? <MenuCheckGlyph /> : null}</span>
          <span className="theater-menu-label">{section.name}</span>
        </button>)}
        <div className="theater-menu-divider" role="separator" />
        <MenuItem icon={<PlusIcon />} onClick={() => {
          onClose();
          if (row) unified.run({ op: "create", name: t("sidebar.commodoreSection.defaultName"), row });
        }}>{t("sidebar.commodoreSection.create")}</MenuItem>
      </div> : null}
    </div>
    {standingRow && standingMenu ? standingMenu.renderItems(standingRow, onClose, opener) : null}
  </SectionMenu>;
}

/**
 * 행이 없는 머신의 맨 아래 알림 줄 — 인증서가 바뀜, 목록 미지원 옛 콘솔, 사령관 0명, 목록을 받지 못함을 한 줄씩 보인다.
 * 전환·관리·인증서 재검토로 이어진다. 문구는 기존 chrome.consoles.*를 재사용한다.
 */
function UnifiedMachineNotices({ consoles, machines, rows }: {
  readonly consoles: ConsoleSections;
  readonly machines: readonly UnifiedSidebarMachine[];
  readonly rows: readonly UnifiedSidebarRow[];
}) {
  const t = useT();
  const withRows = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(row.consoleId);
    return set;
  }, [rows]);
  const orphans = machines.filter((machine) => !machine.home && !withRows.has(machine.consoleId));
  if (orphans.length === 0) return null;
  // 명부 첫 수신이 오기 전에는 인증서 바뀐 줄만 보인다 — 나머지는 로딩 중과 구분할 수 없다.
  const frame = consoles.rosterFrame;
  const visible = orphans.filter((machine) => machine.status === "untrusted" || (consoles.rosterCapable && frame));
  if (visible.length === 0) return null;
  return <>
    {visible.map((machine) => {
      const entry = unifiedEntryForMachine(consoles.entries, machine);
      const blocked = entry ? consoleSwitchBlocked(entry) : machine.status === "unreachable" || machine.status === "untrusted" || machine.status === "stopping";
      const roster = entry && consoles.rosterCapable ? consoles.roster(entry.id) : null;
      const untrusted = machine.status === "untrusted" || entry?.status === "untrusted";
      const note = untrusted ? t("chrome.consoles.rosterUntrusted")
        : roster === null ? t("chrome.consoles.rosterUnavailable")
        : roster.status === "unsupported" ? t("chrome.consoles.rosterUnsupported")
        : roster.status === "unavailable" ? t("chrome.consoles.rosterUnavailable")
        : t("chrome.consoles.rosterEmpty");
      const manageable = entry !== null && consoleSectionManageable(entry) && !consoles.entries.some((item) => item.home && item.status === "unreachable");
      // 행이 없어도 저장된 원격 머신은 잊을 수 있게 둔다 — 인증서가 바뀐 머신은 이 줄이 유일한 출구다.
      // 항목이 없을 때는 셸이 실어 준 창 불투명 id로 뺀다. 창이 지금 서 있는 머신은 잊지 않는다.
      const forgetId = entry ? entry.id : machine.entryId;
      const forgettable = machine.kind === "remote" && forgetId !== undefined && entry?.active !== true;
      return <li key={machine.consoleId} className="side-console-note unified-machine-notice" data-console-id={machine.consoleId} data-status={machine.status ?? undefined}>
        <p><b>{machine.label}</b>{" · "}{note}</p>
        <div className="unified-machine-notice-actions">
          {!blocked && entry ? <button type="button" className="side-console-enter" onClick={() => consoles.command({ switch: entry.id })}>{t("chrome.consoles.switchHere")}</button> : null}
          {manageable && entry ? <button type="button" className="side-console-cert" onClick={() => consoles.command({ manage: entry.id })}>{t("chrome.consoles.manage")}</button> : null}
          {untrusted ? <button type="button" className="side-console-cert" onClick={() => consoles.command({ add: true })}>{t("chrome.consoles.reviewCertificate")}</button> : null}
          {forgettable ? <button type="button" className="side-console-cert unified-machine-forget"
            aria-label={`${machine.label}: ${t("settings.remote.hosts.forget")}`} title={t("settings.remote.hosts.forget")}
            onClick={() => consoles.command({ forget: forgetId })}>{t("settings.remote.hosts.forget")}</button> : null}
        </div>
      </li>;
    })}
  </>;
}
