import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { OperationGroup, OperationNode } from "../types.js";
import { AccentToneList } from "./accent-popover.js";
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

type GroupContextMenuProps =
  | {
      readonly kind: "chip";
      readonly operation: OperationNode;
      readonly groups: readonly OperationGroup[];
      readonly accentKey: string | null;
      readonly anchor: DOMRect;
      readonly actions: GroupContextMenuChipActions;
      readonly onClose: () => void;
    }
  | {
      readonly kind: "group-header";
      readonly group: OperationGroup;
      readonly anchor: DOMRect;
      readonly actions: GroupContextMenuHeaderActions;
      readonly onClose: () => void;
    };

const POPOVER_GAP = 8;
const POPOVER_ESTIMATED_HEIGHT = 320;

export function GroupContextMenu(props: GroupContextMenuProps) {
  const { anchor, onClose } = props;
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  useLayoutEffect(() => {
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 208));
    const below = anchor.bottom + POPOVER_GAP;
    const flipUp = below + POPOVER_ESTIMATED_HEIGHT > window.innerHeight;
    setStyle(
      flipUp
        ? { position: "fixed", left, top: "auto", bottom: Math.round(window.innerHeight - anchor.top + POPOVER_GAP) }
        : { position: "fixed", left, top: Math.round(below) },
    );
  }, [anchor]);

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
    <div className="group-context-menu-overlay" role="presentation" onPointerDown={onClose}>
      {style ? (
        <div
          className="group-context-menu-card"
          role="menu"
          aria-label={props.kind === "chip" ? "Operation options" : `${props.group.name} options`}
          style={style}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {props.kind === "chip" ? (
            <ChipMenuContent {...props} />
          ) : (
            <GroupHeaderMenuContent {...props} />
          )}
        </div>
      ) : null}
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
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState(`Group ${groups.length + 1}`);
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
      <div className="group-context-menu-section-label">Group</div>
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
            {isSelected ? <CheckMark /> : null}
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
          aria-label="New group name"
          placeholder="Group name"
        />
      ) : (
        <button
          type="button"
          className="group-context-menu-item group-context-menu-item--new"
          role="menuitem"
          onClick={() => setShowNewInput(true)}
        >
          <span className="group-context-menu-item__new-label">＋ New group</span>
        </button>
      )}
      <div className="group-context-menu-divider" aria-hidden="true" />
      <div className="group-context-menu-section-label">Accent</div>
      <AccentToneList
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
      <div className="group-context-menu-section-label">Color</div>
      <AccentToneList
        accentKey={group.color}
        includeNone={false}
        onSelect={(key) => {
          if (key) actions.onSetColor(key);
          onClose();
        }}
      />
      <div className="group-context-menu-divider" aria-hidden="true" />
      <div className="group-context-menu-section-label">Rename</div>
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
        aria-label="Group name"
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
        aria-label={ungroupArmed ? "Confirm: remove all members and delete group" : "Ungroup all members and delete group"}
      >
        {ungroupArmed ? "Confirm ungroup all?" : "Ungroup all"}
      </button>
    </>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="group-context-menu-item__check" aria-hidden="true">
      <path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
