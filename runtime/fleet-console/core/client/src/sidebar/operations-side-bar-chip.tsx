import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";


import type { LaunchProviderGlyphId } from "../components/launch-provider-glyphs.js";
import { useT } from "../i18n/index.js";
import { operationActivityLabel, operationActivityVisual, type OperationActivityVisual } from "../operation-activity.js";
import { useInlineRename } from "../use-inline-rename.js";
import type { OperationNode } from "../types.js";
import {
  subscribeSideBarOperationAction,
  type SideBarOperationMenuAction,
} from "./interaction.js";

export interface SideBarEntry {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly minimized: boolean;
  readonly notificationCount: number;
  readonly status?: OperationActivityVisual;
  /**
   * 플러그인이 준 실행 표면 표식(예: "CHAT"). 호스트는 뜻을 모른 채 글자만 그린다 —
   * 색은 활동을 말하는 자리이므로 모드는 신호 채널을 빌리지 않는다.
   */
  readonly surface?: string;
  readonly icon: ReactNode;
  /** 실행된 공급자. 있으면 마크가 그 공급자의 캐리어 시그니처 톤을 입는다. */
  readonly launchProvider?: LaunchProviderGlyphId | null;
}

interface SideBarChipProps {
  readonly entry: SideBarEntry;
  readonly index: number;
  readonly isCloseArmed: boolean;
  readonly accentValue: string | null;
  readonly groupMark?: { readonly name: string; readonly color: string } | null;
  /** 전역 선별 사이드바에서 소속 Theater를 축약 없이 보여주는 중립 pill — Theater 이름 전체를 넣는다. */
  readonly theaterName?: string | null;
  readonly statusAxis?: boolean;
  readonly idleUnseen?: boolean;
  readonly statusLanded?: boolean;
  readonly reorderEnabled?: boolean;
  readonly dragging: boolean;
  readonly dragOffsetY: number;
  readonly dropTarget: boolean;
  /** peek(비활성 Theater) 미리보기 칩 — focus만 살리고 close/rename/accent/재배치 어포던스를 렌더하지 않는다. */
  readonly preview?: boolean;
  /** 선별 사이드바처럼 최소화가 의미 없는 표면 — false면 최소화 버튼과 팔레트 최소화 소비를 끈다. */
  readonly minimizeEnabled?: boolean;
  /** 컨텍스트 메뉴(그룹/액센트) 호스트가 없는 표면 — false면 메뉴 어포던스와 해당 팔레트 소비를 끈다. */
  readonly menuEnabled?: boolean;
  /** 휴면 선반처럼 본동작이 focus가 아닌 resume인 표면 — 접근성 이름과 툴팁도 같은 동사를 쓴다. */
  readonly resumeOnActivate?: boolean;
  readonly onArmClose: (operationId: string) => void;
  readonly onDisarmClose: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onMinimize: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onKeyboardMove: (operationId: string, direction: -1 | 1) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => void;
  readonly onOpenAccent: (
    operationId: string,
    anchor: DOMRect,
    returnFocus?: HTMLElement | null,
    requestedAction?: SideBarOperationMenuAction,
  ) => void;
  readonly onRename: (operationId: string, title: string) => void;
}

export function OperationsSideBarChip({
  entry,
  index,
  isCloseArmed,
  accentValue,
  groupMark = null,
  theaterName = null,
  statusAxis = false,
  idleUnseen = false,
  statusLanded = false,
  reorderEnabled = true,
  minimizeEnabled = true,
  menuEnabled = true,
  resumeOnActivate = false,
  dragging,
  dragOffsetY,
  dropTarget,
  preview = false,
  onArmClose,
  onDisarmClose,
  onClose,
  onMinimize,
  onFocus,
  onKeyboardMove,
  onPointerDragStart,
  onOpenAccent,
  onRename,
}: SideBarChipProps) {
  const t = useT();
  const chipRef = useRef<HTMLLIElement | null>(null);
  const suppressClickRef = useRef(false);
  const { operation, active, minimized, notificationCount, status, surface } = entry;
  const title = displayTitle(operation);
  // 전역 선별 목록에서 같은 제목이 여러 Theater에 있을 수 있다 — pill은 장식(aria-hidden)이므로
  // 소속 Theater를 접근성 이름에 함께 싣는다. 기존 aria 키의 groupContext 슬롯을 재사용한다.
  const theaterContext = theaterName ? t("sidebar.chip.inTheater", { name: theaterName }) : "";
  const groupContext = (statusAxis && groupMark ? t("sidebar.chip.inGroup", { name: groupMark.name }) : "") + theaterContext;
  const unseenContext = idleUnseen ? t("sidebar.chip.unseenContext") : "";
  const chipAriaLabel = resumeOnActivate
    ? t("sidebar.chip.resumeAria", { title, groupContext })
    : active
      ? t("sidebar.chip.focusedAria", { title, groupContext, unseenContext })
      : t("sidebar.chip.focusAria", { title, groupContext, unseenContext });
  const rename = useInlineRename({ currentTitle: title, onCommit: (next) => onRename(operation.id, next), onBegin: onDisarmClose });
  const chipClassName = [
    "side-bar-chip",
    idleUnseen ? "side-bar-chip--unseen" : "",
    active ? "side-bar-chip--active" : "",
    minimized ? "side-bar-chip--minimized" : "",
    statusLanded ? "side-bar-chip--status-landed" : "",
    dragging ? "side-bar-chip--dragging" : "",
    dropTarget ? "side-bar-chip--drop-target" : "",
  ].filter(Boolean).join(" ");
  const closeClassName = ["side-bar-chip-close", isCloseArmed ? "is-armed" : ""].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--user-accent": accentValue } : {}),
    ...(dragging ? { "--drag-dy": `${Math.round(dragOffsetY)}px` } : {}),
  } as CSSProperties;

  const focus = () => {
    onDisarmClose();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onFocus(operation.id);
  };
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const close = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isCloseArmed) {
      onArmClose(operation.id);
      return;
    }
    onDisarmClose();
    onClose(operation.id);
  };
  // accent 진입 = 우클릭(컨텍스트 메뉴) / 키보드 Menu 키. 칩 본클릭은 focus 전용이므로
  // rail tier에서 중앙 아이콘을 눌러도 focus가 동작한다.
  const openAccent = (event: SyntheticEvent<HTMLLIElement>) => {
    event.preventDefault();
    onDisarmClose();
    onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect());
  };

  useEffect(() => subscribeSideBarOperationAction((request) => {
    if (request.operationId !== operation.id || preview) return false;
    const chip = chipRef.current;
    if (!chip) return false;
    if (chip.closest("[inert]")) return false;
    if (request.action === "rename") {
      rename.begin();
      return true;
    }
    if (request.action === "assign-group" || request.action === "set-accent") {
      // 메뉴 호스트가 없는 표면에서 소비를 자칭하면 팔레트 요청이 침묵 실패한다 — 미소비로 남긴다.
      if (!menuEnabled) return false;
      onDisarmClose();
      // 팔레트로 부른 칩은 사이드바 스크롤 밖일 수 있다. rect를 읽기 전에 끌어와야 메뉴가 화면 안에 앵커링된다.
      chip.scrollIntoView({ block: "nearest" });
      onOpenAccent(operation.id, chip.getBoundingClientRect(), chip, request.action);
      return true;
    }
    if (!minimizeEnabled) return false;
    onDisarmClose();
    onMinimize(operation.id);
    chip.focus();
    return true;
  }), [menuEnabled, minimizeEnabled, onDisarmClose, onMinimize, onOpenAccent, operation.id, preview, rename]);

  return (
    <li
      ref={chipRef}
      data-side-bar-chip-id={operation.id}
      data-reorder-enabled={reorderEnabled ? "true" : "false"}
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-haspopup={preview || !menuEnabled ? undefined : "menu"}
      aria-label={chipAriaLabel}
      aria-current={active ? "true" : undefined}
      title={resumeOnActivate
        ? t("sidebar.chip.resumeTitle")
        : preview
          ? t("sidebar.chip.previewTitle")
          : active
            ? t("sidebar.chip.activeTitle")
            : t("sidebar.chip.idleTitle")}
      style={chipStyle}
      onClick={focus}
      onContextMenu={preview || !menuEnabled ? undefined : openAccent}
      onFocus={() => {
        if (!isCloseArmed) onDisarmClose();
      }}
      onPointerDown={reorderEnabled ? (event) => onPointerDragStart(event, operation.id) : undefined}
      onPointerUp={() => {
        if (dragging) suppressClickRef.current = true;
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // 재배치: Alt+Shift+↑/↓ — shift 없는 Alt+↑/↓는 operations의 Operation 순환이 가져간다.
        if (!preview && reorderEnabled && event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onKeyboardMove(operation.id, event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (!preview && menuEnabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          onDisarmClose();
          onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focus();
        }
      }}
    >
      <span className="side-bar-chip-beacon-button" aria-hidden="true">
        <span className={`side-bar-chip-op-icon${entry.launchProvider ? ` operation-provider-mark is-${entry.launchProvider}` : ""}`}>
          {entry.icon ?? <DefaultOpIcon />}
        </span>
      </span>
      {rename.renaming ? (
        <input
          className="side-bar-chip-rename-input"
          ref={rename.inputRef}
          value={rename.draftTitle}
          aria-label={t("sidebar.chip.renameAria", { title })}
          onChange={(e) => rename.setDraftTitle(e.target.value)}
          onKeyDown={rename.handleKeyDown}
          onBlur={rename.handleBlur}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="side-bar-chip-name" onDoubleClick={preview ? undefined : rename.begin}>{title}</span>
      )}
      {notificationCount > 0 ? (
        <span className="side-bar-chip-count">{notificationCount}</span>
      ) : null}
      {theaterName ? (
        <span className="side-bar-chip-theater-pill" title={theaterName} aria-hidden="true">
          {theaterName}
        </span>
      ) : null}
      {groupMark && statusAxis && !preview ? (
        <span
          className="side-bar-chip-group-pill"
          title={groupMark.name}
          aria-hidden="true"
          style={{ "--group-mark": groupMark.color } as CSSProperties}
        >
          {groupMark.name}
        </span>
      ) : groupMark && !statusAxis ? (
        <span
          className="side-bar-chip-group-mark"
          title={groupMark.name}
          aria-label={t("sidebar.chip.groupAria", { name: groupMark.name })}
          style={{ "--group-mark": groupMark.color } as CSSProperties}
        />
      ) : null}
      {idleUnseen ? (
        <span
          className="side-bar-chip-unseen"
          aria-hidden="true"
          title={t("sidebar.chip.unseenTitle")}
        />
      ) : null}
      {!statusAxis ? (
        <span
          className={`side-bar-chip-status ${chipStatusClass(status)}`}
          role="img"
          aria-label={chipStatusLabel(status)}
          title={chipStatusLabel(status)}
        />
      ) : null}
      {surface && !preview ? (
        <span className="side-bar-chip-surface" title={surface}>{surface}</span>
      ) : null}
      {!preview && !minimized && minimizeEnabled ? (
        <button
          type="button"
          className="side-bar-chip-minimize"
          onPointerDown={stopClosePointer}
          onClick={(event) => {
            event.stopPropagation();
            // 다른 칩 액션(focus·rename·accent)과 동일하게, 최소화 전에 armed close를 먼저 해제한다 —
            // 그러지 않으면 최소화 후에도 "Close?" armed 상태가 타임아웃까지 남아 단발 클릭 close 위험이 생긴다.
            onDisarmClose();
            onMinimize(operation.id);
          }}
          aria-label={t("sidebar.chip.minimizeAria", { title })}
          title={t("sidebar.chip.minimizeTitle")}
        >
          <SideBarMinimizeIcon />
        </button>
      ) : null}
      {preview ? null : (
        <button
          type="button"
          className={closeClassName}
          onPointerDown={stopClosePointer}
          onClick={close}
          aria-label={isCloseArmed ? t("sidebar.chip.confirmCloseAria", { title }) : t("sidebar.chip.closeAria", { title })}
          title={isCloseArmed ? t("sidebar.chip.confirmCloseTitle") : t("sidebar.chip.closeTitle")}
        >
          {isCloseArmed ? t("sidebar.chip.closeArmed") : <SideBarCloseIcon />}
        </button>
      )}
    </li>
  );
}

function displayTitle(operation: OperationNode): string {
  return operation.title;
}

function chipStatusClass(status: OperationActivityVisual | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "tenant-beacon is-turn-running";
  if (visual === "background") return "tenant-beacon is-background";
  if (visual === "awaiting") return "tenant-beacon is-awaiting";
  if (visual === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-idle";
}

function chipStatusLabel(status: OperationActivityVisual | undefined): string {
  return operationActivityLabel(status);
}

function SideBarCloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SideBarMinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 11.5h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DefaultOpIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="2" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
