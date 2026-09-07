import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n/index.js";
import type { OperationGroup, OperationNode } from "../types.js";
import { AccentToneList } from "./accent-tone-list.js";
import { resolveAccentColor } from "./operation-accent.js";

export interface GroupContextMenuChipActions {
  readonly onSetAccent: (key: string | null) => void;
  readonly onSetGroupId: (groupId: string | null) => void;
  readonly onCreateGroup: (name: string) => void;
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
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div className="group-context-menu-overlay" data-keep-operation-active role="presentation" onPointerDown={onClose}>
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
        onSelect={(key) => { actions.onSetAccent(key); onClose(); }}
      />
    </>
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
