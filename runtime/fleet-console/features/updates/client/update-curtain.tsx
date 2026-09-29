import { useT } from "../../../core/client/src/i18n/index.js";
import { UPDATE_CURTAIN_STAGES, acknowledgeUpdateOutcome, useUpdateProgress } from "./update-progress-store.js";

/**
 * 업데이트를 **연결 오류가 아니라 진행 상태**로 만드는 화면.
 *
 * 이 커튼이 없으면 같은 순간이 "연결 끊김"으로 보이고, 그것은 고장과 구별되지 않는다.
 * 그래서 커튼은 서버가 닿지 않는 동안에도 내려가지 않는다 — 닿지 않는 것이 곧 진행 중이라는
 * 뜻이기 때문이다. 커튼을 걷는 것은 종착 기록(성공/실패)뿐이다.
 *
 * 단계는 이 화면이 관측할 수 있는 사실만큼만 나눈다. 서버가 닿지 않는 동안 설치와 기동은
 * 구별할 방법이 없으므로 한 단계다.
 */
export function UpdateCurtain() {
  const t = useT();
  const state = useUpdateProgress();

  if (state.outcome !== null) {
    const failed = state.outcome === "failed";
    return (
      <div className={`update-outcome update-outcome--${failed ? "failed" : "ok"}`} role="status" aria-live="polite">
        <span className="update-outcome-signal" aria-hidden="true" />
        <span className="update-outcome-text">
          {failed
            ? t("chrome.update.outcomeFailed", { reason: describeFailure(state.progress?.error ?? null, t) })
            : t("chrome.update.outcomeDone", { version: state.progress?.targetVersion ?? "" })}
          {state.progress?.endpointChanged === true ? (
            <span className="update-outcome-note">{t("chrome.update.addressMoved")}</span>
          ) : null}
        </span>
        <button type="button" className="update-outcome-dismiss" onClick={acknowledgeUpdateOutcome} aria-label={t("common.dismiss")}>
          ×
        </button>
      </div>
    );
  }

  if (!state.watching) return null;

  const activeIndex = UPDATE_CURTAIN_STAGES.indexOf(state.stage);
  // 지나간 단계와 남을 단계의 이름은 싣지 않는다 — 기다리는 사람에게 필요한 것은 지금 무엇을
  // 하고 있는지와 얼마나 남았는지뿐이다. 칸들이 "얼마나"를, 한 줄이 "무엇을" 말한다.
  return (
    <div className="update-curtain" role="status" aria-live="polite">
      <div className="update-curtain-plate">
        <div className="update-curtain-now">
          <span className="update-curtain-step">{t(`chrome.update.step.${state.stage}`)}</span>
          <span className="update-curtain-count">{activeIndex + 1} / {UPDATE_CURTAIN_STAGES.length}</span>
        </div>
        <span className="update-curtain-track" aria-hidden="true">
          {UPDATE_CURTAIN_STAGES.map((key, index) => (
            <i key={key} className={index < activeIndex ? "is-done" : index === activeIndex ? "is-now" : undefined} />
          ))}
        </span>
        <p className="update-curtain-sub">
          {state.delegated
            ? t("chrome.update.curtainSubShell")
            : t("chrome.update.curtainSub", { version: state.targetVersion ?? "" })}
        </p>
      </div>
    </div>
  );
}

function describeFailure(error: string | null, t: ReturnType<typeof useT>): string {
  if (error === "update_worker_lost") return t("chrome.update.failureWorkerLost");
  return error ?? t("chrome.update.failureUnknown");
}
