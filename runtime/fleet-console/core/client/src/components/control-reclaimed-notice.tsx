import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { CONTROL_RECLAIMED_EVENT, type SessionEndedDetail, type SessionEndedReason } from "../control-session.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";

/**
 * 화면은 하나지만 문구는 갈린다. 아무도 회수하지 않았는데 "회수되었습니다"가 뜨면, 이어받은
 * 기기를 찾아가야 할 사람이 자기 콘솔 주인을 의심한다.
 */
const NOTICE_COPY = {
  reclaimed: {
    eyebrow: "chrome.control.reclaimed.eyebrow",
    title: "chrome.control.reclaimed.title",
    body: "chrome.control.reclaimed.body",
  },
  superseded: {
    eyebrow: "chrome.control.superseded.eyebrow",
    title: "chrome.control.superseded.title",
    body: "chrome.control.superseded.body",
  },
} as const satisfies Record<SessionEndedReason, Record<"eyebrow" | "title" | "body", CoreMessageKey>>;

export function ControlReclaimedNotice() {
  const t = useT();
  const [reason, setReason] = useState<SessionEndedReason | null>(null);

  useEffect(() => {
    const showNotice = (event: Event) => {
      // 사유를 읽지 못한 신호는 지금까지의 뜻으로 되돌린다 — 회수가 둘 중 훨씬 흔하다.
      const detail = (event as CustomEvent<SessionEndedDetail>).detail;
      setReason(detail?.reason === "superseded" ? "superseded" : "reclaimed");
    };
    window.addEventListener(CONTROL_RECLAIMED_EVENT, showNotice);
    return () => window.removeEventListener(CONTROL_RECLAIMED_EVENT, showNotice);
  }, []);

  if (reason === null) return null;
  const copy = NOTICE_COPY[reason];
  return createPortal(
    <div className="control-reclaimed-notice" role="alert" aria-live="assertive">
      <section className="control-reclaimed-card">
        <span className="control-reclaimed-signal" aria-hidden="true" />
        <span className="control-reclaimed-eyebrow">{t(copy.eyebrow)}</span>
        <h2>{t(copy.title)}</h2>
        <p>{t(copy.body)}</p>
      </section>
    </div>,
    document.body,
  );
}
