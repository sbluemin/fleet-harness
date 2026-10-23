import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { AdmiralId } from "./chat-session.js";
import { placeNoticeBubble } from "./notice-bubble.js";
import { getT } from "./scuttlebutt-catalog.js";

/**
 * 첫 출근 소개. 부관을 처음 들인 사람에게 할 수 있는 것·못 하는 것·비용을 한 번 말한다 —
 * "켜는 것이 곧 동의"라는 실험 페이지의 문장을 부관 자신의 입으로 옮긴 것이다. 닫으면 설정에
 * 남아 다시 뜨지 않는다. 시간으로 사라지지 않는다: 읽기 전에 지우면 소개가 아니다.
 */
export function IntroBubble({
  admiral,
  locale,
  mascot,
  positionRevision,
  onDismiss,
}: {
  readonly admiral: AdmiralId;
  readonly locale?: ConsoleLocale;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly positionRevision: number;
  readonly onDismiss: () => void;
}) {
  const bubbleRef = React.useRef<HTMLDivElement>(null);
  const t = getT(locale);
  const name = t(`bird.${admiral}`);

  const updatePlacement = React.useCallback(() => {
    const mascotElement = mascot.current;
    const bubble = bubbleRef.current;
    if (!mascotElement || !bubble) return;
    placeNoticeBubble({
      bubble,
      mascot: mascotElement,
      order: 3,
      siblings: Array.from(document.querySelectorAll<HTMLElement>(".scuttlebutt-notice-bubble")),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }, [mascot]);

  React.useLayoutEffect(() => {
    let frame = window.requestAnimationFrame(function follow() {
      updatePlacement();
      frame = window.requestAnimationFrame(follow);
    });
    updatePlacement();
    return () => window.cancelAnimationFrame(frame);
  }, [positionRevision, updatePlacement]);

  return (
    <div
      ref={bubbleRef}
      className="scuttlebutt-notice-bubble is-intro"
      data-order={3}
      role="note"
      aria-label={t("intro.title", { name })}
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="scuttlebutt-notice-body">
        <span className="scuttlebutt-notice-label">{t("intro.title", { name })}</span>
        <p className="scuttlebutt-intro-text">{t("intro.body", { name })}</p>
        <button type="button" className="scuttlebutt-intro-ok" onClick={onDismiss}>{t("intro.ok")}</button>
      </div>
      <button type="button" className="scuttlebutt-notice-dismiss" aria-label={t("bubble.dismiss")} onClick={onDismiss}>✕</button>
    </div>
  );
}
