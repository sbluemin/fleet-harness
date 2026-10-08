import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { ALIGN_MIN_BODY_HEIGHT, ALIGN_MIN_BODY_WIDTH } from "./canvas-store.js";
import { cancelAlignFit, confirmAlignFit, confirmAlignFitCollapsed, useAlignFitRequest, type AlignFitRequest } from "./align-fit-store.js";
import "./canvas-confirm-dialog.css";

/** 모두 정렬 진입 확인 — 본문 하한을 넘으면 남길 패널을 고르게 한다. 세션은 종료·보관하지 않는다. */
export function AlignFitDialog() {
  const request = useAlignFitRequest();
  useEffect(() => () => cancelAlignFit(), []);
  return request ? <AlignFitCard request={request} /> : null;
}

function AlignFitCard({ request }: { readonly request: AlignFitRequest }) {
  const t = useT();
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set(request.defaultKeptIds));
  useEffect(() => { primaryRef.current?.focus(); }, []);
  const toggle = (id: string) => setKept((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (next.size < request.capacity) next.add(id);
    return next;
  });
  const keptIds = request.panels.map((panel) => panel.id).filter((id) => kept.has(id));
  const full = kept.size >= request.capacity;
  return createPortal(
    <div className="canvas-confirm-overlay" role="presentation">
      <button type="button" className="canvas-confirm-scrim" tabIndex={-1} aria-label={t("common.cancel")} onClick={cancelAlignFit} />
      <div className="canvas-confirm-deck">
        <section ref={cardRef} className="canvas-confirm-card" role="dialog" aria-modal="true" aria-labelledby="align-fit-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelAlignFit(); }
            if (event.key === "Tab") {
              const items = [...(cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])]
                .filter((element) => element.tabIndex >= 0);
              if (!items.length) return;
              event.preventDefault();
              const at = items.indexOf(document.activeElement as HTMLElement);
              items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
            }
          }}>
          <div className="canvas-confirm-copy">
            <h2 id="align-fit-title">{t("canvas.alignFit.title", { count: kept.size })}</h2>
            <p>{t("canvas.alignFit.body", {
              width: Math.floor(request.smallest.width),
              height: Math.floor(request.smallest.height),
              capacity: request.capacity,
              minWidth: ALIGN_MIN_BODY_WIDTH,
              minHeight: ALIGN_MIN_BODY_HEIGHT,
            })}</p>
          </div>
          <div className="canvas-confirm-copy">
            <div className="align-fit-meta">
              <span id="align-fit-keep">{t("canvas.alignFit.keep")}</span>
              <span aria-live="polite">{t("canvas.alignFit.limit", { selected: kept.size, capacity: request.capacity })}</span>
            </div>
            <ul className="align-fit-list" aria-labelledby="align-fit-keep">
              {request.panels.map((panel) => {
                const checked = kept.has(panel.id);
                const blocked = !checked && full;
                return (
                  <li key={panel.id}>
                    <label className={`align-fit-row${blocked ? " is-disabled" : ""}`}>
                      <input type="checkbox" checked={checked} disabled={blocked} onChange={() => toggle(panel.id)} />
                      <span>{panel.title}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p>{t("canvas.alignFit.note")}</p>
          </div>
          <div className="canvas-confirm-foot">
            <span />
            <div className="canvas-confirm-actions">
              <button type="button" className="canvas-confirm-secondary" onClick={cancelAlignFit}>{t("common.cancel")}</button>
              {request.collapsedCapacity !== null ? (
                <button type="button" className="canvas-confirm-secondary" onClick={confirmAlignFitCollapsed}>
                  {t("canvas.alignFit.collapse", { count: Math.min(request.collapsedCapacity, request.panels.length) })}
                </button>
              ) : null}
              <button ref={primaryRef} type="button" className="canvas-confirm-primary" disabled={kept.size === 0}
                onClick={() => confirmAlignFit(keptIds)}>
                {t("canvas.alignFit.confirm", { shown: kept.size, hidden: request.panels.length - kept.size })}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>, document.body,
  );
}
