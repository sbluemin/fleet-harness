import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { AdmiralId } from "./chat-session.js";
import { currentExchange, type ChatState } from "./chat-store.js";
import { getT } from "./scuttlebutt-catalog.js";

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
    // 좌표를 상태로 돌리면 프레임마다 리렌더가 돈다 — 따라붙는 값은 DOM에 직접 쓴다(도착 알림과 같다).
    bubble.style.left = `${left}px`;
    if (placeAbove) {
      bubble.style.top = "";
      bubble.style.bottom = `${window.innerHeight - mascotRect.top + gap}px`;
    } else {
      bubble.style.bottom = "";
      bubble.style.top = `${mascotRect.bottom + gap}px`;
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
          <span className="scuttlebutt-answer-capability">{t("mention.capability")}</span>
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
