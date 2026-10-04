import { useNavigate } from "react-router-dom";

import { openTheaterSystemPrompt } from "../../../../../features/settings/client/theater-system-prompt-sheet.js";
import { resolveOperationActivity } from "../../../../../features/execution/client/operation-activity.js";
import { useT } from "../../i18n/index.js";
import { setActiveTheater } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushMobileSheet, setMobileDestination } from "./mobile-store.js";
import "../../styles/mobile.css";

/**
 * Theater 화면(S-36) — 묶음 카드 한 줄이 Theater 하나다: 모노그램, 이름, 「작업 n개 · k건 대기」, 지금 Theater는 ✓.
 * 상단 막대의 ⋮는 지금 Theater를 대상으로 시스템 프롬프트·Theater 추가·목록에서 빼기를 연다.
 */
export function MobileTheaterPage({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const navigate = useNavigate();
  const active = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;

  useClaimMobileBar({
    variant: "centered",
    title: t("mobile.theaters.title"),
    leading: "menu",
    ...(active ? {
      menu: {
        label: t("mobile.bar.theaterMenu"),
        caption: active.label,
        items: [
          { id: "prompt", icon: <MobileIcon name="pencil" size={20} />, label: t("mobile.menu.prompt"), run: () => openTheaterSystemPrompt(active, null) },
          { id: "add", icon: <MobileIcon name="plus" size={20} />, label: t("mobile.menu.addTheater"), run: () => pushMobileSheet({ kind: "folder" }) },
          { id: "forget", icon: <MobileIcon name="minus" size={20} />, label: t("mobile.menu.forgetTheater"), run: () => pushMobileSheet({ kind: "forget", theaterId: active.id }) },
        ],
      },
    } : {}),
  });

  const enter = (theaterId: string) => {
    setActiveTheater(theaterId);
    // 그 Theater의 홈(마지막 작업, 없으면 빈 홈)으로 간다 — 루트끼리의 이동은 history를 늘리지 않는다.
    setMobileDestination({ kind: "home" });
    navigate("/operations", { replace: true });
  };

  return (
    <section className="mobile-theater-page" aria-labelledby="mobile-theater-page-title">
      <h1 id="mobile-theater-page-title" className="mobile-visually-hidden">{t("mobile.theaters.title")}</h1>
      <div className="mobile-group">
        {state.theaters.map((theater) => {
          const operations = state.operations.filter((operation) => operation.theaterId === theater.id);
          const awaiting = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
          const here = theater.id === state.activeTheaterId;
          return (
            <button type="button" className="mobile-group-row is-two" key={theater.id} aria-current={here ? "true" : undefined} onClick={() => enter(theater.id)}>
              <MobileMonogram label={theater.label} toneKey={theater.id} />
              <span className="mobile-group-row-copy">
                {theater.label}
                <small>
                  {t("mobile.sheet.theater.summary", { count: operations.length })}
                  {awaiting > 0 ? <> · <span className="is-awaiting">{t("mobile.sheet.theater.awaiting", { count: awaiting })}</span></> : null}
                </small>
              </span>
              {here ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
            </button>
          );
        })}
      </div>
      <div className="mobile-group">
        <button type="button" className="mobile-group-row" onClick={() => pushMobileSheet({ kind: "folder" })} disabled={state.addingTheater}>
          <span className="mobile-group-row-icon"><MobileIcon name="plus" /></span>
          <span className="mobile-group-row-copy">{t("mobile.sheet.theater.add")}</span>
        </button>
      </div>
      {state.theaterError !== null ? <p className="mobile-sheet-error mobile-theater-error" role="alert">{state.theaterError}</p> : null}
    </section>
  );
}
