import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { AccentToneList } from "@fleet-console/sdk/components/accent-tone-list";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { ArchiveGlyph } from "../../../../core/client/src/chrome/components/archive-glyph.js";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import type { OperationGroup, OperationNode } from "../../../../core/client/src/integration/types.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import { accentToneLabels, resolveAccentColor } from "./operation-accent.js";

export interface GroupContextMenuChipActions {
  readonly onSetAccent: (key: string | null) => void;
  readonly onSetGroupId: (groupId: string | null) => void;
  readonly onCreateGroup: (name: string) => void;
  /** 창 닫기 — 캡션 X와 같은 닫기(유예 삭제 + 실행 취소 토스트). 두 번 눌러 확정한 뒤에만 부른다. */
  readonly onCloseOperation: () => void;
  /** 「더블클릭으로 열기」를 켠 사이드바만 — 한 번 클릭이 고르기라 메뉴 맨 위에서 연다. */
  readonly onOpen?: () => void;
  /** 사이드바 칩만 — 이름을 그 칩 자리에서 고친다(F2 와 같은 동작). */
  readonly onRename?: () => void;
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
    // 앵커 자리의 주인은 열린 뒤 한 번만 짚는다 — 오버레이가 덮은 뒤라 오버레이는 건너뛴다.
    const anchorElement = anchorElementAt(anchor, cardRef.current?.parentElement);
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, anchor, anchorElement)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

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

  const { onOpen, onRename } = actions;
  return (
    <>
      {onOpen || onRename ? (
        <>
          {onOpen ? (
            <button type="button" className="group-context-menu-item" role="menuitem" onClick={() => { onClose(); onOpen(); }}>
              <span className="group-context-menu-item__glyph" aria-hidden="true"><OpenGlyph /></span>
              <span className="group-context-menu-item__name">{t("canvas.groupMenu.open")}</span>
              <kbd className="group-context-menu-item__key" aria-hidden="true">↵</kbd>
            </button>
          ) : null}
          {onRename ? (
            <button type="button" className="group-context-menu-item" role="menuitem" onClick={() => { onClose(); onRename(); }}>
              <span className="group-context-menu-item__glyph" aria-hidden="true"><RenameGlyph /></span>
              <span className="group-context-menu-item__name">{t("canvas.groupMenu.rename")}</span>
              <kbd className="group-context-menu-item__key" aria-hidden="true">F2</kbd>
            </button>
          ) : null}
          <div className="group-context-menu-divider" aria-hidden="true" />
        </>
      ) : null}
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

function OpenGlyph() {
  return <svg viewBox="0 0 14 14"><path d="M5.5 3H3.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1H10a1 1 0 0 0 1-1V8.5M8 2.5h3.5V6M11.5 2.5 6.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function RenameGlyph() {
  return <svg viewBox="0 0 14 14"><path d="M2.5 11.5h2.2l6.4-6.4a1.3 1.3 0 0 0-2.2-2.2L2.5 9.3v2.2ZM8 4l2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/**
 * 보관 — 메뉴의 맨 끝 칸(Windows 11 작업 표시줄 메뉴의 「창 닫기」 자리). 한 번에 보관하고 메뉴를 닫는다 —
 * 되돌리기는 토스트와 ⌘Z가, 복원은 보관함이 맡는다. 캡션·칩과 같은 보관 글리프를 쓴다.
 * Enter를 누르고 있는 반복 입력은 받지 않는다 — 메뉴를 연 키가 그대로 보관까지 이어지면 안 된다.
 */
function CloseWindowItem({ onCloseOperation, onClose }: { onCloseOperation: () => void; onClose: () => void }) {
  const t = useT();
  const trigger = () => {
    onClose();
    onCloseOperation();
  };
  return (
    <button
      type="button"
      className="group-context-menu-item group-context-menu-item--close"
      role="menuitem"
      onClick={trigger}
      onKeyDownCapture={(event) => {
        if (!event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span className="group-context-menu-item__glyph" aria-hidden="true"><ArchiveGlyph /></span>
      <span className="group-context-menu-item__name">{t("canvas.groupMenu.archive")}</span>
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
