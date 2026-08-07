import { React } from "@fleet-console/sdk/plugin/browser";

import { getT, type TerminalMessageKey } from "../i18n/index.js";
import type { SessionInfo } from "./types.js";

const DEFAULT_GOAL_CHECK_LIMIT = 8;
const MIN_GOAL_CHECK_LIMIT = 1;
const MAX_GOAL_CHECK_LIMIT = 20;
const MAX_GOAL_CONDITION_CHARS = 4000;

export interface GoalSheetProps {
  readonly session: SessionInfo;
  readonly language?: "en" | "ko";
  readonly busy: boolean;
  readonly error: TerminalMessageKey | null;
  readonly onCancel: () => void;
  readonly onSubmit: (condition: string, checkLimit: number) => void;
}

/**
 * 한 줄짜리 설정 줄. 조건은 한 줄 입력이면 충분하다 — 서버가 개행을 공백으로 접으므로
 * 여러 줄을 받아도 저장되는 문장은 어차피 한 줄이다.
 */
export function GoalSheet({ session, language = "en", busy, error, onCancel, onSubmit }: GoalSheetProps) {
  const t = getT(language);
  // Fleet이 보낸 조건문만 되돌려 채운다. 터미널에서 직접 친 목표는 Fleet이 그 문장을 저장한 적이
  // 없으므로 빈 시트로 연다 — 추측해서 채우면 사용자가 보낸 적 없는 지시문을 다시 보내게 된다.
  const [condition, setCondition] = React.useState(
    session.goal?.origin === "fleet" ? session.goal.condition ?? "" : "",
  );
  // 아직 강제되지 않은 선택(pendingCheckLimit)이 있으면 그 값으로 연다 — 사용자가 방금 고른
  // 숫자를 다음 재개 전까지 잊어버리면, 시트가 제 선택을 되묻는 꼴이 된다.
  const [checkLimit, setCheckLimit] = React.useState(() => Math.min(
    MAX_GOAL_CHECK_LIMIT,
    Math.max(
      MIN_GOAL_CHECK_LIMIT,
      session.goal?.pendingCheckLimit ?? session.goal?.checkLimit ?? DEFAULT_GOAL_CHECK_LIMIT,
    ),
  ));
  const canSubmit = condition.trim().length > 0 && !busy;

  return (
    <form
      className="terminal-goal-sheet"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(condition, checkLimit);
      }}
    >
      <span className="terminal-goal-mark">{t("terminal.goal.mark")}</span>
      <input
        className="terminal-goal-field"
        type="text"
        maxLength={MAX_GOAL_CONDITION_CHARS}
        value={condition}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        aria-label={t("terminal.goal.sheet.condition")}
        placeholder={t("terminal.goal.sheet.condition")}
        onChange={(event) => setCondition(event.target.value)}
      />
      {/* 지시문 취급 경고는 줄인다는 뜻이지 지운다는 뜻이 아니다 — 짧은 표기가 늘 보이고
          전문은 title에 남는다. 오류가 나면 그 자리를 오류가 대신한다. */}
      {error ? (
        <span className="terminal-goal-error" role="alert">
          {t(error, error === "terminal.goal.error.tooLong" ? { limit: MAX_GOAL_CONDITION_CHARS } : undefined)}
        </span>
      ) : (
        <span className="terminal-goal-disclosure" title={t("terminal.goal.sheet.disclosure")}>
          {t("terminal.goal.sheet.disclosureShort")}
        </span>
      )}
      <div
        className="terminal-goal-stepper"
        role="group"
        aria-label={t("terminal.goal.sheet.checks")}
        title={t("terminal.goal.sheet.checksHelp", { limit: checkLimit })}
      >
        <button
          type="button"
          aria-label={t("terminal.goal.sheet.checksDown")}
          disabled={busy || checkLimit <= MIN_GOAL_CHECK_LIMIT}
          onClick={() => setCheckLimit((current) => Math.max(MIN_GOAL_CHECK_LIMIT, current - 1))}
        >
          −
        </button>
        <output>{checkLimit}</output>
        <button
          type="button"
          aria-label={t("terminal.goal.sheet.checksUp")}
          disabled={busy || checkLimit >= MAX_GOAL_CHECK_LIMIT}
          onClick={() => setCheckLimit((current) => Math.min(MAX_GOAL_CHECK_LIMIT, current + 1))}
        >
          +
        </button>
      </div>
      <button type="button" disabled={busy} onClick={onCancel}>{t("terminal.goal.sheet.cancel")}</button>
      <button type="submit" className="is-primary" disabled={!canSubmit}>{t("terminal.goal.sheet.submit")}</button>
    </form>
  );
}
