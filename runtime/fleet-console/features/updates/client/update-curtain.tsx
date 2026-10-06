import { useState } from "react";

import {
  CONSOLE_START_COMMAND,
  describeConsoleUpdateOldConsoleEnding,
  describeConsoleUpdateRecovery,
  describeConsoleUpdateSilence,
} from "@fleet-console/protocol/lifecycle/update";
import { describeConsoleLifecycleWait } from "@fleet-console/protocol/lifecycle/wait";

import { useT } from "../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import type { ConsoleUpdateProgress } from "../../../core/client/src/integration/types.js";
import { UPDATE_CURTAIN_STAGES, acknowledgeUpdateOutcome, dismissUpdateWatch, useUpdateProgress } from "./update-progress-store.js";

/**
 * 업데이트를 **연결 오류가 아니라 진행 상태**로 만드는 화면.
 *
 * 이 커튼이 없으면 같은 순간이 "연결 끊김"으로 보이고, 그것은 고장과 구별되지 않는다.
 * 그래서 커튼은 서버가 닿지 않는 동안에도 내려가지 않는다 — 닿지 않는 것이 곧 진행 중이라는
 * 뜻이기 때문이다. 커튼을 걷는 것은 종착 기록(성공/실패)과 사람의 손뿐이다.
 *
 * 단계는 이 화면이 관측할 수 있는 사실만큼만 나눈다. 서버가 닿지 않는 동안 설치와 기동은
 * 구별할 방법이 없으므로 한 단계다.
 *
 * 이 화면은 무엇도 판정하지 않고, 사유·결말·상태의 해석을 제 말로 쓰지 않는다. 실패와 그 사유·옛 Console의 결말은
 * worker와 돌아온 Console이 정해 보내고, 그것을 사람에게 말하는 문장과 복구 안내를 여는 시각은 수명주기 계약의
 * 상수·공유 문구(describe*)에서 온다. 이 화면의 말(i18n)은 제목·필드 이름·버튼 같은 틀뿐이다. 계약 문구는 영어다.
 */
export function UpdateCurtain() {
  const t = useT();
  const state = useUpdateProgress();
  const mobileLayout = useViewMode().effective === "mobile";
  const currentVersion = useConsoleState().version;

  if (state.outcome !== null) {
    if (state.outcome === "failed") return <UpdateFailureNotice progress={state.progress} currentVersion={currentVersion} />;
    const ending = state.progress?.oldConsoleOutcome;
    return (
      <div className="update-outcome update-outcome--ok" role="status" aria-live="polite">
        <span className="update-outcome-signal" aria-hidden="true" />
        <span className="update-outcome-text">
          {t("chrome.update.outcomeDone", { version: state.progress?.targetVersion ?? "" })}
          {ending ? <span className="update-outcome-note">{describeConsoleUpdateOldConsoleEnding(ending)}</span> : null}
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

  // 수락 전 대기는 커튼이 아니다. 메뉴를 닫아도 남는 상태 줄이고, Console은 아직 멈추지 않았다.
  if (state.preparing !== null && !state.watching) {
    return (
      <div className="update-outcome update-outcome--live" role="status" aria-live="polite" aria-busy="true">
        <span className="update-outcome-signal" aria-hidden="true" />
        <span className="update-outcome-text">
          <strong className="update-outcome-headline">{t("chrome.system.update.requestingTitle")}</strong>
          <p className="update-outcome-contract">{describeConsoleLifecycleWait("update-preflight")}</p>
        </span>
      </div>
    );
  }

  if (!state.watching) return null;

  const activeIndex = UPDATE_CURTAIN_STAGES.indexOf(state.stage);
  const track = (className: string) => (
    <span className={className} aria-hidden="true">
      {UPDATE_CURTAIN_STAGES.map((key, index) => (
        <i key={key} className={index < activeIndex ? "is-done" : index === activeIndex ? "is-now" : undefined} />
      ))}
    </span>
  );
  // 지나간 단계와 남을 단계의 이름은 싣지 않는다 — 기다리는 사람에게 필요한 것은 지금 무엇을
  // 하고 있는지와 얼마나 남았는지뿐이다. 칸들이 "얼마나"를, 한 줄이 "무엇을" 말한다.
  // 모바일 배치(S-50): 가운데 묶음 — 워드마크, 「Console을 업데이트하는 중」, 「이전 → 새 버전」과 끝 안내, 진행 칸.
  // 닫기 알약과 「진행 중인 작업은 멈추지 않습니다」는 넣지 않는다: 이 커튼에는 닫는 동작이 없고(종착 기록만 걷는다),
  // 작업이 멈추지 않는다는 사실은 확인되지 않았다(D40). 계약의 복귀 시한을 넘긴 침묵에서만 복구 안내와 함께
  // 화면으로 돌아가는 손잡이가 생긴다.
  if (mobileLayout) {
    return (
      <div className="mobile-update-screen" role="status" aria-live="polite">
        <span className="mobile-wordmark">Fleet</span>
        <strong className="mobile-update-title">{t("mobile.update.title")}</strong>
        <p className="mobile-update-sub">
          {state.targetVersion ? `${currentVersion} → ${state.targetVersion}` : t(`chrome.update.step.${state.stage}`)}
          <br />
          {t("mobile.update.note")}
        </p>
        {track("update-curtain-track mobile-update-track")}
        {state.silentPastReturn ? <SilentConsoleRecovery /> : null}
      </div>
    );
  }
  return (
    <div className="update-curtain" role="status" aria-live="polite">
      <div className={`update-curtain-plate${state.silentPastReturn ? " is-silent" : ""}`}>
        <div className="update-curtain-now">
          <span className="update-curtain-step">{t(`chrome.update.step.${state.stage}`)}</span>
          <span className="update-curtain-count">{activeIndex + 1} / {UPDATE_CURTAIN_STAGES.length}</span>
        </div>
        {track("update-curtain-track")}
        <p className="update-curtain-sub">
          {state.delegated
            ? t("chrome.update.curtainSubShell")
            : t("chrome.update.curtainSub", { version: state.targetVersion ?? "" })}
        </p>
        {state.silentPastReturn ? <SilentConsoleRecovery /> : null}
      </div>
    </div>
  );
}

/**
 * 계약의 복귀 시한을 넘긴 침묵. 실패로 확정하지 않는다 — 설치에는 계약 예산이 없어서, 아직 설치 중인 업데이트와
 * 돌아갈 Console 없이 끝난 업데이트를 이 화면은 구별할 수 없다. 그 해석(describeConsoleUpdateSilence)과 사람이 직접
 * 할 수 있는 일(describeConsoleUpdateRecovery, 시작 명령)은 모두 계약 문구이고, 화면은 계속 확인한다. lock 경로는
 * 싣지 않는다: 경로가 담긴 진단은 그 명령이 터미널에 출력한다.
 */
function SilentConsoleRecovery() {
  const t = useT();
  return (
    <section className="update-recovery update-recovery--waiting" aria-label={t("chrome.update.recoveryTitle")}>
      <strong className="update-recovery-title">{t("chrome.update.recoveryTitle")}</strong>
      <p className="update-recovery-contract">{describeConsoleUpdateSilence()}</p>
      <p className="update-recovery-contract">{describeConsoleUpdateRecovery()}</p>
      <StartCommand />
      <div className="update-recovery-actions">
        <button type="button" className="update-recovery-leave" onClick={dismissUpdateWatch}>{t("chrome.update.leaveCurtain")}</button>
      </div>
    </section>
  );
}

function StartCommand() {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(CONSOLE_START_COMMAND).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="update-recovery-command">
      <code>{CONSOLE_START_COMMAND}</code>
      <button type="button" onClick={copy}>{copied ? t("chrome.update.copied") : t("chrome.update.copy")}</button>
    </div>
  );
}

/**
 * 돌아온 Console이 읽어 준 실패. 무슨 일이 있었는지와 옛 Console이 어떻게 끝났는지는 계약의 공유 문구를 본문에
 * 그대로 보인다(사유 문구는 Console이 description으로 보내고, 결말 문구는 계약이 만든다). worker가 남긴 원문은
 * 진단용으로만 접어 둔다.
 */
function UpdateFailureNotice({ progress, currentVersion }: { readonly progress: ConsoleUpdateProgress | null; readonly currentVersion: string }) {
  const t = useT();
  const ending = progress?.oldConsoleOutcome;
  const words = progress?.error && progress.error !== progress.description ? progress.error : null;
  return (
    <div className="update-outcome update-outcome--failed" role="status" aria-live="polite">
      <span className="update-outcome-signal" aria-hidden="true" />
      <div className="update-outcome-text">
        <strong className="update-outcome-headline">{t("chrome.update.outcomeFailedTitle")}</strong>
        {progress?.description ? <p className="update-outcome-contract">{progress.description}</p> : null}
        {ending ? <p className="update-outcome-contract">{describeConsoleUpdateOldConsoleEnding(ending)}</p> : null}
        <div className="update-outcome-facts">
          {currentVersion ? <span>{t("chrome.update.runningNow", { version: currentVersion })}</span> : null}
          {progress?.endpointChanged === true ? <span>{t("chrome.update.addressMoved")}</span> : null}
        </div>
        {words ? (
          <details className="update-recovery-details">
            <summary>{t("chrome.update.workerWords")}</summary>
            <pre>{words}</pre>
          </details>
        ) : null}
      </div>
      <button type="button" className="update-outcome-dismiss" onClick={acknowledgeUpdateOutcome} aria-label={t("common.dismiss")}>
        ×
      </button>
    </div>
  );
}
