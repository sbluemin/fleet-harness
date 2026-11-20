import { useCallback, useEffect, useRef, useState } from "react";
import type { Translate } from "@fleet-console/i18n";

import type { CommodoreMessageKey } from "./i18n/index.js";
import type { CommodoreTranscriptEntry } from "../shared/contracts/types.js";
import type { CommodoreCliStatus } from "../shared/contracts/cli-status.js";
import { readCommodoreCliStatus, retryCommodore } from "./commodore-state.js";
import { commodoreCliFailure } from "./commodore-chat.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";

type T = Translate<CommodoreMessageKey>;

/** Claude Code 설치 안내 — 「설치 방법」이 여는 공식 문서. */
const CLAUDE_CODE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/**
 * 사령관 채팅의 CLI 문 — 호스트에 묻고, 「다시 확인」은 같은 경로를 다시 부른다.
 *
 * 처음 응답 전에는 `null`이다. 그동안 보내기를 막지 않는다 — 판정을 읽지 못한 것과 CLI가 없는 것은 다르고,
 * 실제로 없으면 보낸 뒤 원인 카드가 받는다. 호스트 판정 실패도 `ready`로 접어 같은 규율을 지킨다.
 */
export function useCommodoreCliStatus(commodoreId: string, enabled: boolean) {
  const [status, setStatus] = useState<CommodoreCliStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const check = useCallback(() => {
    if (!enabled || !commodoreId) return;
    const current = ++generation.current;
    setChecking(true);
    void readCommodoreCliStatus(commodoreId)
      .then((next) => { if (generation.current === current) setStatus(next); })
      .catch(() => { if (generation.current === current) setStatus("ready"); })
      .finally(() => { if (generation.current === current) setChecking(false); });
  }, [commodoreId, enabled]);
  // Theater가 바뀌면 이전 판정을 버리고 다시 묻는다 — 남의 상태로 새 대화를 막지 않는다.
  useEffect(() => { generation.current += 1; setStatus(null); setChecking(false); check(); }, [commodoreId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- check는 같은 두 값의 함수다.
  return { status, checking, recheck: check };
}

/** 막힌 상태의 입력창 — 초안은 쓰되 보내지 못한다. */
export function cliGateBlocks(status: CommodoreCliStatus | null): status is "missing" | "signedout" {
  return status === "missing" || status === "signedout";
}

/**
 * C1 — 입력창 위 상태 줄. CLI가 없거나 로그인이 없으면 제목·설명·해결 단추를 세운다.
 * 단추 문구와 문장은 승인된 시안 그대로다.
 */
export function CommodoreCliGate({ t, status, checking, recheck }: {
  readonly t: T;
  readonly status: CommodoreCliStatus;
  readonly checking: boolean;
  readonly recheck: () => void;
}) {
  const cause = cliGateBlocks(status) ? status : null;
  if (!cause) return null;
  return (
    <div className="objectives-commodore-cli-gate" role="status">
      <span className="objectives-commodore-cli-gate-dot" aria-hidden="true" />
      <div className="objectives-commodore-cli-gate-copy">
        <b>{t(`commodore.cli.gate.${cause}.title` as CommodoreMessageKey)}</b>
        <span>{t(`commodore.cli.gate.${cause}.body` as CommodoreMessageKey)}</span>
        <div className="objectives-commodore-cli-gate-actions">
          {cause === "missing" ? (
            <>
              <button type="button" className="objectives-btn is-small" onClick={openClaudeInstallGuide}>{t("commodore.cli.action.install")}</button>
              <button type="button" className="objectives-btn is-small" onClick={openAgentCliSettings}>{t("commodore.cli.action.path")}</button>
            </>
          ) : (
            <button type="button" className="objectives-btn is-small" onClick={openCommodoreLoginCard}>{t("commodore.cli.action.login")}</button>
          )}
          <button type="button" className="objectives-commodore-text-button" disabled={checking} onClick={recheck}>{t("commodore.cli.action.recheck")}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * C2 — 보낸 뒤 CLI 원인으로 실패했을 때의 원인 카드. 「오류 · …」 줄 대신 서고,
 * 「다시 보내기」는 같은 대기 말을 다시 턴에 싣는다(자동 재시도는 없다).
 */
export function CommodoreCliFailureCard({ t, commodoreId, entries, onFail }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly onFail: (error: unknown) => void;
}) {
  const cause = commodoreCliFailure(entries);
  if (!cause) return null;
  return (
    <div className="objectives-commodore-cli-card" role="status">
      <b>{t(`commodore.cli.fail.${cause}.title` as CommodoreMessageKey)}</b>
      <p>{t(`commodore.cli.fail.${cause}.body` as CommodoreMessageKey)}</p>
      <div className="objectives-commodore-cli-card-actions">
        {cause === "missing" ? (
          <>
            <button type="button" className="objectives-btn is-small" onClick={openClaudeInstallGuide}>{t("commodore.cli.action.install")}</button>
            <button type="button" className="objectives-btn is-small" onClick={openAgentCliSettings}>{t("commodore.cli.action.path")}</button>
          </>
        ) : (
          <button type="button" className="objectives-btn is-small" onClick={openCommodoreLoginCard}>{t("commodore.cli.action.login")}</button>
        )}
        <button type="button" className="objectives-commodore-text-button" onClick={() => { void retryCommodore(commodoreId).catch(onFail); }}>{t("commodore.cli.action.resend")}</button>
      </div>
    </div>
  );
}

export function openClaudeInstallGuide(): void {
  // 다른 외부 링크와 같은 문법 — 새 창, opener 없음.
  window.open(CLAUDE_CODE_INSTALL_URL, "_blank", "noopener,noreferrer");
}

/** 설정의 Agent CLI 경로 화면 — 기존 설정 문을 그대로 쓴다(모바일은 /settings?section=). */
export function openAgentCliSettings(): void {
  openSettingsSurface("agent-cli");
}

/**
 * 로그인 카드의 자리 — 다음 미션 「로그인 연결·통합」에서 Quota의 `claude auth login` 카드에 연결한다.
 * 이번 미션은 단추의 위치와 click 이벤트만 둔다.
 */
function openCommodoreLoginCard(): void {
  // 연결은 다음 미션의 몫이다.
}
