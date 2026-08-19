import { useT } from "../i18n/index.js";
import { acknowledgeUpdateOutcome, useUpdateProgress } from "../update-progress-store.js";

/**
 * 업데이트를 **연결 오류가 아니라 진행 상태**로 만드는 화면.
 *
 * 이 커튼이 없으면 같은 순간이 "연결 끊김"으로 보이고, 그것은 고장과 구별되지 않는다.
 * 그래서 커튼은 서버가 닿지 않는 동안에도 내려가지 않는다 — 닿지 않는 것이 곧 진행 중이라는
 * 뜻이기 때문이다. 커튼을 걷는 것은 종착 기록(성공/실패)뿐이다.
 */
const STEP_KEYS = ["stopping", "installing", "starting", "reconnecting"] as const;

export function UpdateCurtain() {
  const t = useT();
  const state = useUpdateProgress();

  if (state.outcome !== null) {
    const failed = state.outcome === "failed";
    return (
      <div className={`update-outcome update-outcome--${failed ? "failed" : "ok"}`} role="status" aria-live="polite">
        <span className="update-outcome-text">
          {failed
            ? t("chrome.update.outcomeFailed", { reason: describeFailure(state.progress?.error ?? null, t) })
            : t("chrome.update.outcomeDone", { version: state.progress?.targetVersion ?? "" })}
        </span>
        {state.progress?.endpointChanged === true ? (
          <span className="update-outcome-note">{t("chrome.update.addressMoved")}</span>
        ) : null}
        <button type="button" className="update-outcome-dismiss" onClick={acknowledgeUpdateOutcome}>
          {t("common.dismiss")}
        </button>
      </div>
    );
  }

  if (!state.watching) return null;

  const activeIndex = state.delegated ? 2 : resolveStepIndex(state.progress?.phase ?? null);
  return (
    <div className="update-curtain" role="status" aria-live="polite">
      <div className="update-curtain-card">
        <h2 className="update-curtain-title">{t("chrome.update.curtainTitle")}</h2>
        <p className="update-curtain-sub">
          {state.delegated
            ? t("chrome.update.curtainSubShell")
            : t("chrome.update.curtainSub", { version: state.targetVersion ?? "" })}
        </p>
        <ol className="update-curtain-steps">
          {STEP_KEYS.map((key, index) => (
            <li
              key={key}
              className={`update-curtain-step${index < activeIndex ? " is-done" : index === activeIndex ? " is-now" : ""}`}
            >
              <span className="update-curtain-mark" aria-hidden="true" />
              <span>{t(`chrome.update.step.${key}` as "chrome.update.step.stopping")}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * 서버가 닿지 않는 동안에는 국면을 물어볼 곳이 없다. 그때 화면이 가리키는 단계는 추측이
 * 아니라 사실이다 — 워커는 콘솔을 내린 **직후** 설치를 시작하므로, 닿지 않는 시간은
 * 설치 시간이다.
 */
export function resolveStepIndex(phase: string | null): number {
  if (phase === "starting" || phase === "preflight-ok" || phase === "stopping-console") return 0;
  if (phase === "starting-daemon") return 2;
  return 1;
}

function describeFailure(error: string | null, t: ReturnType<typeof useT>): string {
  if (error === "update_worker_lost") return t("chrome.update.failureWorkerLost");
  return error ?? t("chrome.update.failureUnknown");
}
