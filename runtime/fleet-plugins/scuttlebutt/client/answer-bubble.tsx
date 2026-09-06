import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { AdmiralId } from "./chat-session.js";
import { currentExchange, type ChatState } from "./chat-store.js";
import { getT } from "./scuttlebutt-catalog.js";
import { isConsoleReadEnabled } from "./console-read.js";

/**
 * Quick Launch에서 물은 답이 서는 자리.
 *
 * 지저귐 말풍선(`.scuttlebutt-bird-say`)은 `white-space: nowrap` 한 줄이라 문단을 담지 못한다 —
 * 200자를 그리면 폭이 1,700px가 되어 캔버스를 넘는다. 그래서 봉투는 도착 알림 말풍선의 것
 * (최대 360px·줄바꿈·닫기 버튼·좌표 추적)을 그대로 입고, 색만 지저귐의 brass를 쓴다.
 * 도착 알림의 `positive`는 "끝났다"는 **상태**를 말하는 신호 채널이라 답변이 물려받으면 안 된다.
 *
 * 도착 알림과 다른 점 하나: **자동으로 사라지지 않는다.** 6초는 읽는 시간이 아니라 알아채는
 * 시간이고, 답을 읽기 전에 지우면 물어본 사람이 잃는다.
 */
export function AnswerBubble({
  admiral,
  state,
  mascot,
  locale,
  positionRevision,
  onExpand,
  onDismiss,
}: {
  readonly admiral: AdmiralId;
  readonly state: ChatState;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly locale?: ConsoleLocale;
  readonly positionRevision: number;
  readonly onExpand: () => void;
  /**
   * `restoreFocus`는 키보드로 닫았을 때만 참이다. 마우스로 닫고도 새에 포커스를 되돌리면
   * `:focus-visible` 링이 새를 감싸고 다른 곳을 누를 때까지 남는다 — 누른 적 없는 곳에 뜬 테두리는
   * 사용자가 지울 방법을 모른다. 키보드로 닫은 사람에게는 반대로 그 링이 지금 어디에 서 있는지다.
   */
  readonly onDismiss: (restoreFocus: boolean) => void;
}) {
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  const t = getT(locale);

  const updatePlacement = React.useCallback(() => {
    const mascotElement = mascot.current;
    const bubble = bubbleRef.current;
    if (!mascotElement || !bubble) return;
    const mascotRect = mascotElement.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const alignRight = mascotRect.left + mascotRect.width / 2 > window.innerWidth / 2;
    const placeAbove = mascotRect.top + mascotRect.height / 2 > window.innerHeight / 2;
    const preferredLeft = alignRight ? mascotRect.right - bubbleRect.width : mascotRect.left;
    const left = clamp(preferredLeft, margin, window.innerWidth - bubbleRect.width - margin);
    // 여러 부관이 동시에 답하면 말풍선끼리 겹친다 — 감속 모션에서 무리가 한 줄로 정박하면 새 사이가
    // 92px인데 말풍선은 360px까지 벌어지므로, 뒤 말풍선이 앞 답을 거의 다 덮는다. 가로로 실제
    // 겹치는 앞 말풍선만큼만 세로로 비켜선다 — 멀리 떨어진 말풍선까지 밀어내면 이유 없이 떠오른다.
    const lane = laneOffset({
      bubble,
      siblings: Array.from(document.querySelectorAll<HTMLElement>(".scuttlebutt-answer-bubble")),
      left,
      width: bubbleRect.width,
      height: bubbleRect.height,
      placeAbove,
      anchorTop: mascotRect.top,
      anchorBottom: mascotRect.bottom,
      gap,
    });
    // 좌표를 상태로 돌리면 프레임마다 리렌더가 돈다 — 따라붙는 값은 DOM에 직접 쓴다(도착 알림과 같다).
    bubble.style.left = `${left}px`;
    if (placeAbove) {
      bubble.style.top = "";
      bubble.style.bottom = `${window.innerHeight - mascotRect.top + gap + lane}px`;
    } else {
      bubble.style.bottom = "";
      bubble.style.top = `${mascotRect.bottom + gap + lane}px`;
    }
    bubble.style.visibility = "visible";
  }, [mascot]);

  // 답하는 동안 부관은 정박하지만, 정박 전이·창 리사이즈·다른 새의 이동으로 좌표는 여전히 움직인다.
  React.useLayoutEffect(() => {
    let frame = window.requestAnimationFrame(function follow() {
      updatePlacement();
      frame = window.requestAnimationFrame(follow);
    });
    updatePlacement();
    return () => window.cancelAnimationFrame(frame);
  }, [positionRevision, updatePlacement]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      // 전면 표면이 같은 Escape를 아직 소비하지 않았을 수 있다 — 디스패치가 끝난 뒤 다시 본다
      // (도착 알림과 같은 계약).
      window.setTimeout(() => {
        if (event.defaultPrevented) return;
        onDismiss(true);
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const answer = readAnswerText(state);
  const working = state.phase === "starting" || state.phase === "thinking";
  const name = t(`chat.label.${admiral}` as "chat.label.tori");

  return (
    <div
      ref={bubbleRef}
      className="scuttlebutt-answer-bubble"
      role="group"
      aria-label={name}
      onPointerDown={(event) => event.preventDefault()}
    >
      {/* 답은 한 글자씩 스트리밍된다 — 보이는 문단을 라이브 영역으로 두면 청크마다 전체가 다시
          읽힌다. 상시 존재하는 이 영역은 턴이 정착한 뒤에만 내용을 갖고, 그래서 한 번만 읽힌다
          (라이브 영역은 내용이 바뀌기 전에 이미 마운트돼 있어야 알림이 나간다). */}
      <span className="scuttlebutt-answer-announce" aria-live="polite" aria-atomic="true">
        {working ? "" : answer ?? ""}
      </span>
      <div className="scuttlebutt-answer-body">
        <span className="scuttlebutt-answer-who">
          {name}
          <span className="scuttlebutt-answer-capability">{t(isConsoleReadEnabled() ? "mention.capabilityConsole" : "mention.capability")}</span>
        </span>
        {answer === null
          ? <span className="scuttlebutt-answer-working">{t("answer.working")}</span>
          : <p className="scuttlebutt-answer-text">{answer}</p>}
        {/* 말풍선은 앞부분과 입구다 — 전문과 이어 묻기는 원래 있던 카드가 받는다. */}
        <button type="button" className="scuttlebutt-answer-expand" onClick={onExpand}>
          {t("answer.expand")}
        </button>
      </div>
      <button
        type="button"
        className="scuttlebutt-answer-dismiss"
        aria-label={t("answer.dismiss")}
        // detail === 0은 키보드 활성화다(새 버튼의 onClick이 쓰는 판별과 같다). 마우스 클릭은
        // 포인터가 이미 자리를 말했으므로 포커스를 옮기지 않는다.
        onClick={(event) => onDismiss(event.detail === 0)}
      >
        ✕
      </button>
      {working ? <span className="scuttlebutt-answer-wait" aria-hidden="true" /> : null}
    </div>
  );
}

/**
 * 지금 문답의 답만 읽는다. 아직 한 글자도 오지 않았으면 null이고, 그때는 상태 문구가 대신 선다 —
 * 빈 말풍선은 "실패했나"로 읽힌다.
 */
function readAnswerText(state: ChatState): string | null {
  const entries = currentExchange(state);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && (entry.kind === "assistant" || entry.kind === "error") && entry.text.length > 0) return entry.text;
  }
  return null;
}

/**
 * 이 말풍선보다 먼저 선 말풍선 중 **가로로 실제 겹치는** 것들의 높이 합. 그만큼 마스코트에서
 * 멀어지는 방향으로 비켜서면 답이 서로를 가리지 않는다.
 *
 * DOM 순서를 레인 순서로 쓴다 — 무리가 답변 목록 순서대로 렌더하므로 먼저 물은 답이 마스코트에
 * 가장 가깝게 남고, 뒤에 온 답만 바깥으로 쌓인다.
 */
export interface LanePlacement {
  readonly bubble: HTMLElement;
  readonly siblings: readonly HTMLElement[];
  readonly left: number;
  readonly width: number;
  readonly height: number;
  /** 마스코트 위로 열리는가. 아래로 열리면 레인은 반대 방향으로 자란다. */
  readonly placeAbove: boolean;
  readonly anchorTop: number;
  readonly anchorBottom: number;
  readonly gap: number;
}

/**
 * 앞선 말풍선을 피해 마스코트에서 멀어지는 거리.
 *
 * 높이를 더하는 것으로는 부족하다 — 마스코트마다 세로 위치가 다르면 한 칸 밀어도 그만큼 어긋난
 * 만큼 다시 겹친다(정상 모션에서 47px 어긋난 두 부관으로 75×77px 겹침 실측). 그래서 **놓일 자리의
 * 실제 사각형**으로 판정하고, 겹치는 형제의 바깥 변까지만 정확히 물러선다.
 *
 * DOM 순서를 레인 순서로 쓴다 — 무리가 답변 목록 순서대로 렌더하므로 먼저 물은 답이 마스코트에
 * 가장 가깝게 남고, 뒤에 온 답만 바깥으로 쌓인다.
 */
export function laneOffset(input: LanePlacement): number {
  const { bubble, siblings, left, width, height, placeAbove, anchorTop, anchorBottom, gap } = input;
  const blockers: readonly DOMRect[] = siblings
    .slice(0, Math.max(0, siblings.indexOf(bubble) === -1 ? siblings.length : siblings.indexOf(bubble)))
    // 아직 좌표를 못 잰 형제(첫 프레임)는 건너뛴다 — 0,0에 있는 상자로 레인을 계산하면 튄다.
    .filter((sibling) => sibling.style.visibility === "visible")
    .map((sibling) => sibling.getBoundingClientRect())
    .filter((rect) => rect.left < left + width && left < rect.left + rect.width);

  let lane = 0;
  // 한 번 훑는 것으로는 부족하다 — 마스코트 높이가 제각각이면 뒤쪽 형제를 피해 물러난 자리가 앞서
  // 지나쳤던 형제 위로 되돌아갈 수 있다(세 부관이 겹칠 때 실측 재현). 자리가 더 움직이지 않을 때까지
  // 다시 훑는다. 형제 수만큼만 돌므로(부관은 셋) 끝나지 않는 일은 없다.
  for (let pass = 0; pass <= blockers.length; pass += 1) {
    let moved = false;
    for (const rect of blockers) {
      const top = placeAbove ? anchorTop - gap - lane - height : anchorBottom + gap + lane;
      if (top >= rect.bottom || rect.top >= top + height) continue;
      // 겹치는 형제의 바깥 변 너머로 물러선다. 앞선 형제가 이미 더 큰 레인을 요구했으면 그것을 지킨다.
      const next = Math.max(lane, placeAbove ? anchorTop - rect.top : rect.bottom - anchorBottom);
      if (next > lane) {
        lane = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return lane;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
