import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { useAgentState } from "../../../execution/client/agent/store.js";
import { consoleUseWrapClassName, gestureCallerLabel, getOperationWrap, subscribeConsoleUseGestures } from "../../../console-use/client/gestures.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { describeWorkspace, visibleWorkspace } from "../../../execution/client/components/operation-workspace-context.js";
import { useTheaterLabel } from "../../../../core/client/src/hooks/use-store.js";
import { ArchiveGlyph } from "@fleet-console/sdk/components/archive-glyph";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { operationMarkLabel, type OperationActivityVisual, type OperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { OperationAvatar, mongleStateOfMark } from "../avatars.js";
import { useInlineRename } from "../../../../core/client/src/integration/use-inline-rename.js";
import type { OperationNode } from "../../../../core/client/src/integration/types.js";
import {
  subscribeSideBarOperationAction,
  type SideBarOperationMenuAction,
} from "./interaction.js";
import { OperationDetailCard } from "./operation-detail-card.js";
import { pointOnText } from "./operations-side-bar-hit-test.js";
import { DecisionRequestMark } from "../decision-request-mark.js";
import { scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import { CONVERSATION_ROW_PHRASE } from "./side-bar-row-style.js";
import { useConversationRowPreview } from "../conversation/conversation-slots.js";

/** 포인터가 잠깐 지나가는 것과 겨누는 것을 가르는 시간. 목록을 훑는 동안 카드가 따라 뜨면 안 된다. */
const DETAIL_HOVER_DELAY_MS = 400;

export interface SideBarEntry {
  readonly operation: OperationNode;
  readonly active: boolean;
  /** 「더블클릭으로 열기」를 켠 사이드바에서 열지 않고 고르기만 한 Operation — 활성이면 세우지 않는다. */
  readonly selected?: boolean;
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

/**
 * 묶음의 뿌리(지휘관) 행 — 상태 줄 앞에 `✓ N/N` 을 얹는다. 사이드바는 지휘관 한 행이 묶음을 대표하므로 단계 행은 서지 않는다.
 */
export interface SideBarChipCluster {
  /** 상태 문구 앞의 단계 글. 임무가 없으면 null. */
  readonly strip: ReactNode;
  /** 칩 접근 이름에 싣는 같은 글. 보이는 단계가 없으면 없다. */
  readonly progressLabel?: string;
  /** 뿌리에게 결정 요청이 섰다 — 이름 옆에 표식이 선다(비콘·상태 칸은 활동 그대로). */
  readonly decisionRequest?: boolean;
  /** 뿌리의 목표가 사람의 검토를 기다린다 — 아바타가 검토 대기 얼굴이 된다(다른 표면과 같은 기준). */
  readonly awaitingReview?: boolean;
}

interface SideBarChipProps {
  readonly entry: SideBarEntry;
  readonly cluster?: SideBarChipCluster | null;
  readonly index: number;
  readonly accentValue: string | null;
  readonly groupMark?: { readonly name: string; readonly color: string } | null;
  readonly statusAxis?: boolean;
  readonly statusLanded?: boolean;
  readonly reorderEnabled?: boolean;
  readonly dragging: boolean;
  readonly dragOffsetY: number;
  readonly dropTarget: boolean;
  /** peek(비활성 Theater) 미리보기 칩 — focus만 살리고 close/rename/accent/재배치 어포던스를 렌더하지 않는다. */
  readonly preview?: boolean;
  /** 컨텍스트 메뉴(그룹/액센트) 호스트가 없는 표면 — false면 메뉴 어포던스와 해당 팔레트 소비를 끈다. */
  readonly menuEnabled?: boolean;
  /** 휴면 선반처럼 본동작이 focus가 아닌 resume인 표면 — 접근성 이름과 툴팁도 같은 동사를 쓴다. */
  readonly resumeOnActivate?: boolean;
  /**
   * 「더블클릭으로 열기」 — 있으면 한 번 클릭과 Space 는 이것(열지 않고 고르기)을, 더블클릭과 Enter 는 본동작(onFocus)을 부른다.
   * 터치 탭은 더블 탭 판정이 브라우저마다 달라 늘 본동작이다. 없으면 한 번 클릭이 곧 본동작이다(기본).
   */
  readonly onSelect?: (operationId: string) => void;
  readonly onClose: (operationId: string) => void;
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
  accentValue,
  groupMark = null,
  statusAxis = false,
  statusLanded = false,
  reorderEnabled = true,
  menuEnabled = true,
  resumeOnActivate = false,
  onSelect,
  dragging,
  dragOffsetY,
  dropTarget,
  preview = false,
  cluster = null,
  onClose,
  onFocus,
  onKeyboardMove,
  onPointerDragStart,
  onOpenAccent,
  onRename,
}: SideBarChipProps) {
  const t = useT();
  const chipRef = useRef<HTMLLIElement | null>(null);
  const suppressClickRef = useRef(false);
  // 터치 탭은 고르기 모드에서도 연다 — 클릭 사건이 포인터 종류를 싣지 않는 환경이 있어 누를 때 기록해 둔다.
  const pointerTypeRef = useRef("mouse");
  const { operation, active, status, mark } = entry;
  const selected = entry.selected === true && !active;
  // 마크 축이 없는 엔트리(직접 구성한 입력)는 섹션 축을 그대로 그린다 — 두 축은 "unseen"에서만 갈린다.
  const markVisual = mark ?? status;
  const title = displayTitle(operation);
  // "지금 어디" 축 — 서버가 세션 DTO에 실어 보내는 투영이다. 칩이 그리는 것은 브랜치 한 조각뿐이고,
  // 폴더는 hover 상세 카드가 진다. 접근성 이름은 여기서도 폴더까지 싣는다.
  const session = useAgentState().sessions[operation.id];
  const context = visibleWorkspace(session?.workspace);
  // 대화 중심 화면의 행은 위치 줄 대신 상태 문구 한 줄을 둔다(위치는 겨누면 뜨는 상세 카드가 그대로 말한다).
  // 미리보기 원천(그룹 타임라인)이 연결되면 마지막 발화가, 아니면 상태 문구가 그 줄에 선다 — 연결 지점은 이 한 곳이다.
  const rowPreview = useConversationRowPreview(operation.id);
  const workspaceContext = context ? describeWorkspace(t, context) : "";
  // 상태에 담는 것은 칩의 자리뿐이다: 내용을 스냅샷으로 얼려 두면 열어 둔 채 활동이나 작업 폴더가
  // 바뀌었을 때 카드가 지난 사실을 계속 말한다.
  const [detailAnchor, setDetailAnchor] = useState<DOMRect | null>(null);
  const detailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailId = useId();
  // 카드의 「위치」는 Theater 이름을 뿌리로 삼는다.
  const detailTheaterLabel = useTheaterLabel(operation.theaterId);
  const groupContext = (statusAxis && groupMark ? t("sidebar.chip.inGroup", { name: groupMark.name }) : "") + workspaceContext;
  // 미확인 도착은 활동 축과 별개의 사실이 아니다 — 그 조건이 곧 표시 활동의 AWAITING이므로
  // 칩은 상태 마크 하나로만 말한다. 접미 문구·행 틴트·우측 점은 같은 사실의 중복 발화였다.
  const ariaTitle = title;
  const chipVerb = selected
    ? t("sidebar.chip.selectedAria", { title: ariaTitle, groupContext })
    : resumeOnActivate
      ? t("sidebar.chip.resumeAria", { title: ariaTitle, groupContext })
      : active
        ? t("sidebar.chip.focusedAria", { title: ariaTitle, groupContext })
        : t("sidebar.chip.focusAria", { title: ariaTitle, groupContext });
  // 단계 글은 보이는 `✓ N/N` 과 같다. 줄에 접근 이름이 있어 자식 글은 낭독되지 않으므로 여기에 싣는다.
  const chipAriaLabel = cluster?.progressLabel ? `${chipVerb}, ${cluster.progressLabel}` : chipVerb;
  const rename = useInlineRename({ currentTitle: title, onCommit: (next) => onRename(operation.id, next) });
  // Console Use — 에이전트가 이 Operation 을 읽거나 만지면 행 전체가 그 채널 색으로 감싸인다.
  const wrap = useSyncExternalStore(subscribeConsoleUseGestures, () => (preview ? null : getOperationWrap(operation.id)), () => null);
  const chipClassName = [
    "side-bar-chip",
    consoleUseWrapClassName(wrap),
    active ? "side-bar-chip--active" : "",
    selected ? "side-bar-chip--selected" : "",
    statusLanded ? "side-bar-chip--status-landed" : "",
    dragging ? "side-bar-chip--dragging" : "",
    dropTarget ? "side-bar-chip--drop-target" : "",
    "side-bar-chip--conversation",
  ].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--user-accent": accentValue } : {}),
    ...(dragging ? { "--drag-dy": `${Math.round(dragOffsetY)}px` } : {}),
  } as CSSProperties;

  const focus = () => {
        if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onFocus(operation.id);
  };
  // 고르기 모드의 한 번 클릭 — 더블클릭의 둘째 클릭(detail 2)은 이어지는 dblclick 이 연다.
  const select = (event: ReactMouseEvent<HTMLLIElement>) => {
    if (!onSelect || pointerTypeRef.current === "touch") {
      focus();
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (event.detail <= 1) onSelect(operation.id);
  };
  // 칩 안의 버튼(보관)과 이름 입력에서 난 더블클릭은 그 컨트롤의 것이다 — 버블된 것을 열기로 읽지 않는다.
  // 이름 글자의 더블클릭은 이름 변경이 먼저 멈춘다.
  const openOnDoubleClick = (event: ReactMouseEvent<HTMLLIElement>) => {
    if (pointerTypeRef.current === "touch" || dragging) return;
    if (event.target instanceof Element && event.target.closest("button, input")) return;
    onFocus(operation.id);
  };
  // 이름 글자 위 더블클릭은 이름 변경이다 — 고르기 모드에서도 그렇고, 여는 더블클릭은 이름 밖 자리만 진다. 이름 칸은 줄 폭으로
  // 늘어나 있으므로 글자 자리로 판정하고, 이름 변경이면 칩의 openOnDoubleClick 까지 번지지 않게 멈춘다. 고르기 모드에서
  // 터치·끌기 중의 더블클릭은 예전처럼 아무것도 하지 않는다.
  const renameOnNameDoubleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (onSelect && (pointerTypeRef.current === "touch" || dragging)) return;
    if (!pointOnText(event.currentTarget, event.clientX, event.clientY)) return;
    event.stopPropagation();
    rename.begin();
  };
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  // 상세 카드 — 포인터는 잠깐 머문 뒤에, 키보드 포커스는 곧바로 연다. 이름을 고치는 중이거나
  // 끌고 있거나 닫기가 armed면 열지 않는다: 그 순간의 칩은 읽는 자리가 아니라 조작하는 자리다.
  // preview 칩이 내려놓는 것은 close·rename·accent 같은 조작 어포던스이지 읽을 거리가 아니다.
  // 폴더를 칩에서 내린 뒤로는 카드가 그 자리를 지므로, 여기서 막으면 미리보기만 위치를 잃는다.
  const detailBlocked = rename.renaming || dragging;
  // 지연 타이머는 걸릴 때의 렌더를 붙들고 있다 — 기다리는 사이에 바뀐 차단 상태를 ref로 다시 본다.
  const detailBlockedRef = useRef(detailBlocked);
  detailBlockedRef.current = detailBlocked;
  const closeDetail = () => {
    if (detailTimerRef.current) {
      clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
    setDetailAnchor(null);
  };
  const armDetail = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (detailBlocked || event.pointerType !== "mouse") return;
    const element = event.currentTarget;
    if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
    detailTimerRef.current = setTimeout(() => {
      detailTimerRef.current = null;
      if (!detailBlockedRef.current) setDetailAnchor(element.getBoundingClientRect());
    }, DETAIL_HOVER_DELAY_MS);
  };
  // 칩의 보관은 한 번에 끝난다 — 되돌리기는 토스트와 ⌘Z가, 복원은 보관함이 맡는다.
  const archive = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose(operation.id);
  };
  // accent 진입 = 우클릭(컨텍스트 메뉴) / 키보드 Menu 키. 칩 본클릭은 focus 전용이므로
  // rail tier에서 중앙 아이콘을 눌러도 focus가 동작한다.
  const openAccent = (event: SyntheticEvent<HTMLLIElement>) => {
    event.preventDefault();
        onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect());
  };

  // 카드는 열릴 때 잰 칩 자리를 들고 있다 — 목록이 스크롤되거나 창이 바뀌면 그 자리는 이미 거짓이다.
  // 따라 옮기는 대신 닫는다: 읽던 사람이 손을 움직인 것이고, 다시 겨누면 다시 열린다.
  useEffect(() => {
    if (!detailAnchor) return;
    const dismiss = () => setDetailAnchor(null);
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, detailAnchor, chipRef.current)) dismiss();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [detailAnchor]);

  // 조작이 시작되면 이미 열려 있던 카드도 물러난다. 닫기 버튼은 포인터 이벤트를 삼키므로 칩의
  // 이탈 처리가 닿지 않는다 — 열지 않는 조건과 닫는 조건을 같은 값 하나로 묶어야 어긋나지 않는다.
  useEffect(() => {
    if (!detailBlocked) return;
    if (detailTimerRef.current) {
      clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
    setDetailAnchor(null);
  }, [detailBlocked]);

  useEffect(() => () => {
    if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
  }, []);

  useEffect(() => subscribeSideBarOperationAction((request) => {
    if (request.operationId !== operation.id || preview) return false;
    const chip = chipRef.current;
    if (!chip) return false;
    if (chip.closest("[inert]")) return false;
    if (request.action === "rename") {
      rename.begin();
      return true;
    }
    // 남은 요청은 assign-group / set-accent — 메뉴 호스트가 없는 표면에서 소비를 자칭하면 팔레트 요청이 침묵 실패한다. 미소비로 남긴다.
    if (!menuEnabled) return false;
    // 팔레트로 부른 칩은 사이드바 스크롤 밖일 수 있다. rect를 읽기 전에 끌어와야 메뉴가 화면 안에 앵커링된다.
    chip.scrollIntoView({ block: "nearest" });
    onOpenAccent(operation.id, chip.getBoundingClientRect(), chip, request.action);
    return true;
  }), [menuEnabled, onOpenAccent, operation.id, preview, rename]);

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
      aria-describedby={detailAnchor ? detailId : undefined}
      aria-description={wrap ? t("sidebar.chip.gaze", { caller: gestureCallerLabel(wrap.gesture.caller), summary: wrap.gesture.summary }) : undefined}
      /* 네이티브 툴팁은 세우지 않는다 — 겨누면 상세 카드가 뜨고, 둘이 겹쳐 뜨면 어느 쪽도 읽히지 않는다. */
      style={chipStyle}
      onClick={onSelect ? select : focus}
      onDoubleClick={onSelect ? openOnDoubleClick : undefined}
      onContextMenu={preview || !menuEnabled ? undefined : openAccent}
      onPointerEnter={armDetail}
      onPointerLeave={closeDetail}
      onFocus={(event) => {
        if (event.target === event.currentTarget && !detailBlocked) setDetailAnchor(event.currentTarget.getBoundingClientRect());
      }}
      onBlur={closeDetail}
      onPointerDown={(event) => {
        pointerTypeRef.current = event.pointerType;
        closeDetail();
        if (reorderEnabled) onPointerDragStart(event, operation.id);
      }}
      onPointerUp={() => {
        if (dragging) suppressClickRef.current = true;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailAnchor) {
          event.preventDefault();
          closeDetail();
          return;
        }
        if (event.target !== event.currentTarget) return;
        // 재배치: Alt+Shift+↑/↓ — shift 없는 Alt+↑/↓는 operations의 Operation 순환이 가져간다.
        if (!preview && reorderEnabled && event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onKeyboardMove(operation.id, event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (!preview && menuEnabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
                    onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget);
          return;
        }
        if (!preview && event.key === "F2") {
          event.preventDefault();
          rename.begin();
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (onSelect && event.key === " ") onSelect(operation.id);
          else focus();
        }
      }}
    >
      {/* 이름 왼쪽 슬롯은 활동 상태가 소유한다 — 목록에서 먼저 읽혀야 하는 것은 무엇으로
          띄웠는지가 아니라 지금 무엇을 하고 있는지다. 그 상태를 이 Operation 의 몽글 아바타가 얼굴과
          몸짓으로 말한다(구성원은 베이스만, 그 밖은 지휘관 안테나). 칩 자체가 상태를 접근성 이름으로
          말하지 않으므로 아바타가 그 이름을 진다. */}
      <span className="side-bar-chip-beacon-button">
        <OperationAvatar operation={operation} state={mongleStateOfMark(markVisual, { decisionRequest: cluster?.decisionRequest === true, awaitingReview: cluster?.awaitingReview === true })} size={22} label={operationMarkLabel(markVisual)} className="side-bar-chip-status" />
      </span>
      <span className="side-bar-chip-text">
        {/* 이름 줄 — 스냅 표식은 이름의 생략 부호 밖에 서므로 제목이 길어도 잘리지 않는다.
            이름을 고치는 동안에는 입력이 줄을 다 쓴다. */}
        <span className="side-bar-chip-name-row">
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
            <>
              <span className="side-bar-chip-name" onDoubleClick={preview ? undefined : renameOnNameDoubleClick}>{title}</span>
              {cluster?.decisionRequest ? <DecisionRequestMark /> : null}
            </>
          )}
        </span>
        {markVisual || cluster?.strip ? (
          <span className="side-bar-chip-status-line" aria-hidden="true">
            {cluster?.strip ?? null}
            {markVisual ? (
              <span className="side-bar-chip-preview">
                {rowPreview?.text ?? t(cluster?.decisionRequest ? "conversation.row.decision" : CONVERSATION_ROW_PHRASE[markVisual])}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      {preview ? null : <PluginOperationMarks operation={operation} />}
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
      {preview ? null : (
        <button
          type="button"
          className="side-bar-chip-close"
          onPointerDown={stopClosePointer}
          onClick={archive}
          aria-label={t("sidebar.chip.archiveAria", { title })}
          title={t("sidebar.chip.archiveTitle")}
        >
          <ArchiveGlyph />
        </button>
      )}
      {detailAnchor ? (
        <OperationDetailCard
          id={detailId}
          anchor={detailAnchor}
          activity={markVisual}
          /* 칩 줄과 달리 카드는 걸러지지 않은 투영을 받는다 — git이 아닌 Theater의 루트는 브랜치도
             폴더도 없어 칩에는 낼 것이 없지만, 세션이 선 자리는 여전히 그 Theater다. */
          workspace={session?.workspace ?? null}
          theaterLabel={detailTheaterLabel}
          createdAt={session?.createdAt ?? operation.ts.createdAt}
        />
      ) : null}
    </li>
  );
}

function displayTitle(operation: OperationNode): string {
  return operation.title;
}

/**
 * Operation 종류가 칩에 싣는 표식 — 이 Operation에 허용된 것(관찰·콘솔 사용·컴퓨터 사용)을 목록에서
 * 읽게 한다. 활동은 비콘이 지므로 여기는 상태가 아니라 사실만 선다. 실패해도 칩은 살아야 한다.
 */
function PluginOperationMarks({ operation }: { readonly operation: OperationNode }) {
  const registry = useFeatureRegistry();
  const language = useConsoleLocale();
  const descriptor = registry.operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  return (
    <>
      <OperationCaptionContributions operation={operation} language={language} surface="chip" />
      {descriptor?.operationMarks ? (
        <PluginErrorBoundary fallback={<></>}>
          {descriptor.operationMarks({ operation, language, onClose: () => undefined })}
        </PluginErrorBoundary>
      ) : null}
    </>
  );
}

/**
 * Console Use 시선 표식 — 어느 에이전트가 방금 이 Operation 을 읽거나 만졌는지. 호출자의 아이덴티티 톤 점 하나이며
 * 8초 뒤 사라진다. 배경·테두리는 칠하지 않는다(아이덴티티는 잉크·점에만).
 */
