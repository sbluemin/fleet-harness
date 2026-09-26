import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { ZenTaskbarWelcomeIllustration } from "../onboarding.js";
import { cancelTriageEntry, confirmTriageEntry, useTriageEntryRequest } from "./triage-store.js";

/** 웰컴 카드의 그림·표면·버튼 문법을 쓰는 진입 확인. 지목은 store가 열기 전에 보관한다. */
export function TriageEntryDialog() {
  const request = useTriageEntryRequest();
  const t = useT();
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (request) primaryRef.current?.focus(); }, [request]);
  useEffect(() => () => cancelTriageEntry(), []);
  if (!request) return null;
  return createPortal(
    <div className="onboarding-welcome-overlay" role="presentation">
      <button type="button" className="onboarding-welcome-scrim" tabIndex={-1} aria-label={t("common.cancel")} onClick={cancelTriageEntry} />
      <div className="onboarding-welcome-deck">
        <section ref={cardRef} className="onboarding-welcome-card" role="dialog" aria-modal="true" aria-labelledby="triage-entry-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelTriageEntry(); }
            if (event.key === "Tab") {
              // 웰컴 대화상자와 같은 버튼 순환으로 포커스를 가둔다.
              const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
              if (!buttons.length) return;
              event.preventDefault();
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
          <div className="onboarding-welcome-slide">
            <div className="onboarding-welcome-copy"><h2 id="triage-entry-title">{t("canvas.triage.zenEntryTitle")}</h2></div>
            <div className="onboarding-welcome-art"><ZenTaskbarWelcomeIllustration /></div>
            <div className="onboarding-welcome-copy"><p>{t("canvas.triage.zenEntryBody")}</p></div>
          </div>
          <div className="onboarding-welcome-foot">
            <span />
            <div className="onboarding-welcome-actions">
              <button type="button" className="onboarding-welcome-secondary" onClick={cancelTriageEntry}>{t("common.cancel")}</button>
              <button ref={primaryRef} type="button" className="onboarding-welcome-primary" onClick={confirmTriageEntry}>{t("canvas.triage.zenEntryConfirm")}</button>
            </div>
          </div>
        </section>
      </div>
    </div>, document.body,
  );
}
