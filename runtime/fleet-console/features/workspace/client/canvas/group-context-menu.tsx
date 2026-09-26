import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { AccentToneList } from "@fleet-console/sdk/components/accent-tone-list";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import type { OperationGroup, OperationNode } from "../../../../core/client/src/integration/types.js";
import { accentToneLabels, resolveAccentColor } from "./operation-accent.js";

export interface GroupContextMenuChipActions {
  readonly onSetAccent: (key: string | null) => void;
  readonly onSetGroupId: (groupId: string | null) => void;
  readonly onCreateGroup: (name: string) => void;
  /** 창 닫기 — 캡션 X와 같은 닫기(유예 삭제 + 실행 취소 토스트). 두 번 눌러 확정한 뒤에만 부른다. */
  readonly onCloseOperation: () => void;
}

export interface GroupContextMenuHeaderActions {
  readonly onSetColor: (color: string | null) => void;
  readonly onRename: (name: string) => void;
  readonly onUngroupAll: () => void;
}

// 카드의 어느 변을 앵커에 맞추는가. 우클릭(커서 앵커)은 start — 커서에서 오른쪽으로 펼친다.
// 캡션의 More 버튼은 end — 버튼 오른쪽 변에 맞춰 패널 안쪽으로 펼친다(패널 밖으로 삐져나가지 않는다).
export type GroupContextMenuAlign = "start" | "end";

type GroupContextMenuProps =
  | {
      readonly kind: "chip";
      readonly operation: OperationNode;
      readonly groups: readonly OperationGroup[];
      readonly accentKey: string | null;
      readonly anchor: DOMRect;
      readonly align?: GroupContextMenuAlign;
      readonly actions: GroupContextMenuChipActions;
      readonly onClose: () => void;
    }
  | {
      readonly kind: "group-header";
      readonly group: OperationGroup;
      readonly anchor: DOMRect;
      readonly align?: GroupContextMenuAlign;
      readonly actions: GroupContextMenuHeaderActions;
      readonly onClose: () => void;
    };

const POPOVER_GAP = 6;
/** 창 닫기 무장 창 — 캡션 X(operation-frame.tsx CLOSE_ARM_DURATION_MS)와 같은 1.5초. */
const CLOSE_ARM_DURATION_MS = 1500;
const VIEWPORT_MARGIN = 8;

export function GroupContextMenu(props: GroupContextMenuProps) {
  const t = useT();
  const { anchor, onClose } = props;
  const align = props.align ?? "start";
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  // 자리는 실측으로 정한다 — 카드를 먼저 숨긴 채 그려 폭·높이를 읽는다. 추정 높이로 뒤집기를
  // 판정하면 섹션 하나가 늘어날 때마다 화면 아래에서 조용히 잘린다.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const rawLeft = align === "end" ? anchor.right - width : anchor.left;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));
    const below = anchor.bottom + POPOVER_GAP;
    const above = anchor.top - POPOVER_GAP - height;
    // 아래가 맞으면 아래, 아니면 위. 양쪽 다 모자라면 뷰포트 안으로 밀어 넣는다 — 잘리는 것보다 겹치는 편이 낫다.
    const top = below + height + VIEWPORT_MARGIN <= window.innerHeight
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    setStyle({ position: "fixed", left, top: Math.round(top) });
  }, [align, anchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div className="group-context-menu-overlay" data-native-browser-transparent data-keep-operation-active role="presentation" onPointerDown={onClose}>
      <div
        ref={cardRef}
        className="group-context-menu-card"
        role="menu"
        aria-label={props.kind === "chip" ? t("canvas.groupMenu.operationOptions") : t("canvas.groupMenu.groupOptions", { name: props.group.name })}
        style={style ?? { position: "fixed", left: 0, top: 0, visibility: "hidden" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {props.kind === "chip" ? (
          <ChipMenuContent {...props} />
        ) : (
          <GroupHeaderMenuContent {...props} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ChipMenuContent({
  operation,
  groups,
  accentKey,
  actions,
  onClose,
}: {
  operation: OperationNode;
  groups: readonly OperationGroup[];
  accentKey: string | null;
  actions: GroupContextMenuChipActions;
  onClose: () => void;
}) {
  const t = useT();
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState(() => t("canvas.groupMenu.defaultName", { n: groups.length + 1 }));
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (showNewInput) { inputRef.current?.select(); }
  }, [showNewInput]);

  const confirmNewGroup = () => {
    const name = newName.trim();
    if (!name) return;
    actions.onCreateGroup(name);
    onClose();
  };

  return (
    <>
      <PluginOperationMenuSection operation={operation} onClose={onClose} />
      <div className="group-context-menu-section-label">{t("canvas.groupMenu.sectionGroup")}</div>
      {groups.map((group) => {
        const color = resolveAccentColor(group.color);
        const isSelected = operation.groupId === group.id;
        return (
          <button
            key={group.id}
            type="button"
            className={`group-context-menu-item${isSelected ? " is-selected" : ""}`}
            role="menuitemradio"
            aria-checked={isSelected}
            onClick={() => { actions.onSetGroupId(isSelected ? null : group.id); onClose(); }}
          >
            <span
              className="group-context-menu-item__dot"
              style={color ? { background: color } as CSSProperties : undefined}
              aria-hidden="true"
            />
            <span className="group-context-menu-item__name">{group.name}</span>
            <CheckMark />
          </button>
        );
      })}
      {showNewInput ? (
        <input
          ref={inputRef}
          className="group-context-menu-new-input"
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composingRef.current) { e.preventDefault(); confirmNewGroup(); }
            if (e.key === "Escape") { e.preventDefault(); setShowNewInput(false); }
          }}
          onBlur={() => setShowNewInput(false)}
          aria-label={t("canvas.groupMenu.newGroupNameAria")}
          placeholder={t("canvas.groupMenu.groupNamePlaceholder")}
        />
      ) : (
        <button
          type="button"
          className="group-context-menu-item group-context-menu-item--new"
          role="menuitem"
          onClick={() => setShowNewInput(true)}
        >
          <PlusMark />
          <span className="group-context-menu-item__name">{t("canvas.groupMenu.newGroup")}</span>
        </button>
      )}
      <div className="group-context-menu-divider" aria-hidden="true" />
      <AccentToneList
        label={t("canvas.groupMenu.sectionAccent")}
        accentKey={accentKey}
        includeNone
        labels={accentToneLabels(t)}
        onSelect={(key) => { actions.onSetAccent(key); onClose(); }}
      />
      <div className="group-context-menu-divider" aria-hidden="true" />
      <CloseWindowItem onCloseOperation={actions.onCloseOperation} onClose={onClose} />
    </>
  );
}

/**
 * 창 닫기 — 메뉴의 맨 끝 칸(Windows 11 작업 표시줄 메뉴의 「창 닫기」). 쉬는 모양은 중립 항목이고,
 * 캡션 X·칩 X처럼 첫 누름이 무장(붉은 면)하고 창 안의 두 번째 누름이 닫는다.
 */
function CloseWindowItem({ onCloseOperation, onClose }: { onCloseOperation: () => void; onClose: () => void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  const trigger = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (armed) {
      setArmed(false);
      onClose();
      onCloseOperation();
      return;
    }
    setArmed(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setArmed(false);
    }, CLOSE_ARM_DURATION_MS);
  };
  return (
    <button
      type="button"
      className={`group-context-menu-item group-context-menu-item--close${armed ? " group-context-menu-item--danger is-armed" : ""}`}
      role="menuitem"
      onClick={trigger}
      // Enter를 누르고 있는 것만으로 무장→확정이 이어지지 않게 한다(메뉴 키보드 훅의 Enter보다 먼저 받는다).
      onKeyDownCapture={(event) => {
        if (!event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <CloseMark />
      <span className="group-context-menu-item__name" aria-live="polite">
        {armed ? t("canvas.groupMenu.closeWindowArmed") : t("canvas.groupMenu.closeWindow")}
      </span>
    </button>
  );
}

/**
 * Operation 종류가 메뉴에 싣는 섹션 — 이 Operation에 **대한** 스위치(관찰·콘솔 사용·컴퓨터 사용 같은).
 * 캡션·사이드바 우클릭·War Room 카드가 같은 카드를 열므로 여기 한 번만 서면 세 진입점이 같은 것을
 * 본다. 실패해도 메뉴의 나머지는 살아야 하므로 조각만 조용히 비운다.
 */
function PluginOperationMenuSection({ operation, onClose }: { operation: OperationNode; onClose: () => void }) {
  const registry = usePluginRegistry();
  const language = useConsoleLocale();
  const descriptor = registry.operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  if (!descriptor?.operationMenu) return null;
  return (
    <PluginErrorBoundary fallback={<></>}>
      {descriptor.operationMenu({ operation, language, onClose })}
      <div className="group-context-menu-divider" aria-hidden="true" />
    </PluginErrorBoundary>
  );
}

function GroupHeaderMenuContent({
  group,
  actions,
  onClose,
}: {
  group: OperationGroup;
  actions: GroupContextMenuHeaderActions;
  onClose: () => void;
}) {
  const t = useT();
  const [renameValue, setRenameValue] = useState(group.name);
  const [ungroupArmed, setUngroupArmed] = useState(false);
  const composingRef = useRef(false);

  const confirmRename = () => {
    const name = renameValue.trim();
    if (!name || name === group.name) { onClose(); return; }
    actions.onRename(name);
    onClose();
  };

  return (
    <>
      {/* 그룹 색은 durable 스키마상 팔레트 키 중 하나로 필수다(무색 그룹 미지원). None 항목은 제공하지 않는다. */}
      <AccentToneList
        label={t("canvas.groupMenu.sectionColor")}
        accentKey={group.color}
        includeNone={false}
        labels={accentToneLabels(t)}
        onSelect={(key) => {
          if (key) actions.onSetColor(key);
          onClose();
        }}
      />
      <div className="group-context-menu-divider" aria-hidden="true" />
      <div className="group-context-menu-section-label">{t("canvas.groupMenu.sectionRename")}</div>
      <input
        className="group-context-menu-new-input"
        type="text"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !composingRef.current) { e.preventDefault(); confirmRename(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        onBlur={confirmRename}
        aria-label={t("canvas.groupMenu.groupNameAria")}
      />
      <div className="group-context-menu-divider" aria-hidden="true" />
      <button
        type="button"
        className={`group-context-menu-item group-context-menu-item--danger${ungroupArmed ? " is-armed" : ""}`}
        role="menuitem"
        onClick={() => {
          if (!ungroupArmed) { setUngroupArmed(true); return; }
          actions.onUngroupAll();
          onClose();
        }}
        aria-label={ungroupArmed ? t("canvas.groupMenu.confirmUngroupAria") : t("canvas.groupMenu.ungroupAria")}
      >
        {ungroupArmed ? t("canvas.groupMenu.confirmUngroupAll") : t("canvas.groupMenu.ungroupAll")}
      </button>
    </>
  );
}

function CloseMark() {
  return (
    <svg viewBox="0 0 14 14" className="group-context-menu-item__close" aria-hidden="true">
      <path d="m3.5 3.5 7 7m0-7-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusMark() {
  return (
    <svg viewBox="0 0 14 14" className="group-context-menu-item__plus" aria-hidden="true">
      <path d="M7 2.5v9M2.5 7h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="group-context-menu-item__check" aria-hidden="true">
      <path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
