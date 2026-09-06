import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";


import { OperationNameMark } from "../components/operation-name-mark.js";
import { useT } from "../i18n/index.js";
import { type OperationActivityVisual, type OperationMarkVisual } from "../operation-activity.js";
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
  /**
   * 활동 — 섹션 분류의 입력. groupOperationsByStatus가 이 값에서 칸을 정하며(미확인 도착은 거기서
   * AWAITING으로 승격된다), 승격은 그 함수 하나만 소유한다.
   */
  readonly status?: OperationActivityVisual;
  /**
   * 마크 축 — 마크가 그리는 값. 섹션 축과 갈라지는 유일한 값이 "unseen"이다: 칸은 AWAITING이되
   * 색은 초록(느린 점등)이라, 진짜 대기와 안 본 채 끝난 것이 한 화면에서 구별된다.
   */
  readonly mark?: OperationMarkVisual;
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
  const { operation, active, minimized, status, mark } = entry;
  // 마크 축이 없는 엔트리(직접 구성한 입력)는 섹션 축을 그대로 그린다 — 두 축은 "unseen"에서만 갈린다.
  const markVisual = mark ?? status;
  const title = displayTitle(operation);
  // 전역 선별 목록에서 같은 제목이 여러 Theater에 있을 수 있다 — pill은 장식(aria-hidden)이므로
  // 소속 Theater를 접근성 이름에 함께 싣는다. 기존 aria 키의 groupContext 슬롯을 재사용한다.
  const theaterContext = theaterName ? t("sidebar.chip.inTheater", { name: theaterName }) : "";
  const groupContext = (statusAxis && groupMark ? t("sidebar.chip.inGroup", { name: groupMark.name }) : "") + theaterContext;
  // 미확인 도착은 활동 축과 별개의 사실이 아니다 — 그 조건이 곧 표시 활동의 AWAITING이므로
  // 칩은 상태 마크 하나로만 말한다. 접미 문구·행 틴트·우측 점은 같은 사실의 중복 발화였다.
  const chipAriaLabel = resumeOnActivate
    ? t("sidebar.chip.resumeAria", { title, groupContext })
    : active
      ? t("sidebar.chip.focusedAria", { title, groupContext })
      : t("sidebar.chip.focusAria", { title, groupContext });
  const rename = useInlineRename({ currentTitle: title, onCommit: (next) => onRename(operation.id, next), onBegin: onDisarmClose });
  const chipClassName = [
    "side-bar-chip",
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
    // 좁힌 레일(.is-narrow) 안의 칩은 display:none으로 가려져 있을 수 있다 — 접힘(inert)과 같은
    // 사양 계약이다: 소비하지 않고 남겨 두면 사이드바가 먼저 넓히고, 다시 그려진 칩이 소비한다.
    if (chip.closest(".operations-side-bar.is-narrow")) return false;
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
      {/* 이름 왼쪽 슬롯은 활동 상태가 소유한다 — 목록에서 먼저 읽혀야 하는 것은 무엇으로
          띄웠는지가 아니라 지금 무엇을 하고 있는지다. 칩 자체가 상태를 접근성 이름으로
          말하지 않으므로 마크가 그 이름을 진다. 예외는 Shell 하나다: Shell은 활동 축을
          발행하지 않아 비콘이 늘 같은 값으로 굳으므로, 그 자리를 종류 글리프가 가져간다. */}
      <span className="side-bar-chip-beacon-button">
        <OperationNameMark operation={operation} status={markVisual} className="side-bar-chip-status" />
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

