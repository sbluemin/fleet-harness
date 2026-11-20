import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Translate } from "@fleet-console/i18n";

import type { CommodoreMessageKey } from "./i18n/index.js";
import type { CommodoreTranscriptEntry } from "../shared/contracts/types.js";
import type { CommodoreCliStatus } from "../shared/contracts/cli-status.js";
import { readCommodoreCliStatus, retryCommodore } from "./commodore-state.js";
import { commodoreCliFailure } from "./commodore-chat.js";
import { beginClaudeLogin, getLoginStates, subscribeLogins } from "../../quota/client/provider-login.js";
import { getQuotaApi } from "../../quota/client/summary-store.js";
import { requestQuotaPanelOpen } from "../../quota/client/toolbar-summary.js";

type T = Translate<CommodoreMessageKey>;

/** Claude 로그인 카드의 지금 — 번들 스토어의 Claude 칸. 값이 바뀔 때만 새 상태다. */
const claudeLoginPhase = () => getLoginStates().claude.phase;

/** Claude Code 설치 안내 — 「설치 방법」이 여는 공식 문서. */
const CLAUDE_CODE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/**
 * 채팅의 CLI 문 — 호스트에 묻고, 「다시 확인」은 같은 경로를 다시 부른다.
 * 사령관 채팅과 지휘관 채팅이 같은 상태 기계를 공유한다.
 *
 * 처음 응답 전에는 `null`이다. 그동안 보내기를 막지 않는다 — 판정을 읽지 못한 것과 CLI가 없는 것은 다르고,
 * 실제로 없으면 보낸 뒤 원인 카드가 받는다. 호스트 판정 실패도 `ready`로 접어 같은 규율을 지킨다.
 *
 * 대화의 최신 실패가 CLI 원인으로 새로 바뀌면(보내는 동안 CLI가 사라지거나 로그인이 풀린 경우) 같은 경로를 다시 읽어
 * C1 상태 줄을 세우고 보내기를 막는다 — 보낸 뒤 카드만 있고 다시 보낼 수 있던 두 원인의 차이를 없앤다.
 */
export function useCliStatusProbe(
  scopeKey: string,
  enabled: boolean,
  failure: "missing" | "signedout" | null,
  readStatus: () => Promise<CommodoreCliStatus>,
) {
  const [status, setStatus] = useState<CommodoreCliStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const readRef = useRef(readStatus);
  readRef.current = readStatus;
  const check = useCallback(() => {
    if (!enabled || !scopeKey) return;
    const current = ++generation.current;
    setChecking(true);
    void readRef.current()
      .then((next) => { if (generation.current === current) setStatus(next); })
      .catch(() => { if (generation.current === current) setStatus("ready"); })
      .finally(() => { if (generation.current === current) setChecking(false); });
  }, [scopeKey, enabled]);
  // 대상이 바뀌면 이전 판정을 버리고 다시 묻는다 — 남의 상태로 새 대화를 막지 않는다.
  useEffect(() => { generation.current += 1; setStatus(null); setChecking(false); check(); }, [scopeKey, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- check는 같은 두 값의 함수다.
  // 최신 실패가 CLI 원인으로 새로 바뀌면 다시 읽는다 — 처음 실패로 화면이 설 때는 위의 첫 읽기가 이미 맡는다.
  const previousFailure = useRef(failure);
  useEffect(() => {
    const previous = previousFailure.current;
    previousFailure.current = failure;
    if (failure !== null && failure !== previous) check();
  }, [failure, check]);
  // 로그인 카드가 성공하면 채팅이 쓰는 CLI 로그인도 그 자리에서 바뀐다 — 상태를 다시 읽어 막힌 입력을 푼다(C1-2).
  const loginPhase = useSyncExternalStore(subscribeLogins, claudeLoginPhase, claudeLoginPhase);
  const previousLoginPhase = useRef(loginPhase);
  useEffect(() => {
    const previous = previousLoginPhase.current;
    previousLoginPhase.current = loginPhase;
    if (previous !== "signed_in" && loginPhase === "signed_in") check();
  }, [loginPhase, check]);
  return { status, checking, recheck: check };
}

export function useCommodoreCliStatus(commodoreId: string, enabled: boolean, failure: "missing" | "signedout" | null = null) {
  return useCliStatusProbe(commodoreId, enabled, failure, () => readCommodoreCliStatus(commodoreId));
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
            <button type="button" className="objectives-btn is-small" onClick={openClaudeInstallGuide}>{t("commodore.cli.action.install")}</button>
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
 * C2 — 보낸 뒤 CLI 원인으로 실패했을 때의 원인 카드 본체. 사령관 채팅과 지휘관 채팅이 같은 문구·단추·동작을 공유한다.
 */
export function CliFailureCard({ t, cause, onResend, canResend = true }: {
  readonly t: T;
  readonly cause: "missing" | "signedout";
  readonly onResend?: () => void;
  readonly canResend?: boolean;
}) {
  return (
    <div className="objectives-commodore-cli-card" role="status">
      <b>{t(`commodore.cli.fail.${cause}.title` as CommodoreMessageKey)}</b>
      <p>{t(`commodore.cli.fail.${cause}.body` as CommodoreMessageKey)}</p>
      <div className="objectives-commodore-cli-card-actions">
        {cause === "missing" ? (
          <button type="button" className="objectives-btn is-small" onClick={openClaudeInstallGuide}>{t("commodore.cli.action.install")}</button>
        ) : (
          <button type="button" className="objectives-btn is-small" onClick={openCommodoreLoginCard}>{t("commodore.cli.action.login")}</button>
        )}
        {onResend && canResend ? (
          <button type="button" className="objectives-commodore-text-button" onClick={onResend}>{t("commodore.cli.action.resend")}</button>
        ) : null}
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
  return <CliFailureCard t={t} cause={cause} onResend={() => { void retryCommodore(commodoreId).catch(onFail); }} />;
}

export function openClaudeInstallGuide(): void {
  // 다른 외부 링크와 같은 문법 — 새 창, opener 없음.
  window.open(CLAUDE_CODE_INSTALL_URL, "_blank", "noopener,noreferrer");
}

/**
 * Quota의 Claude 로그인 카드 — 사령관·지휘관 채팅의 C1·C2 「로그인」이 같은 자리에 닿는다. 터미널 claude와 같은 로그인을
 * 찾고(CLI 기본 로그인) 없으면 `claude auth login` 카드를 시작한 뒤, 그 카드가 서는 Quota 패널을 연다. 번들 스토어라
 * 패널이 늦게 열려도 같은 카드가 선다. 성공(signed_in)은 `useCliStatusProbe`가 보고 cli-status를 다시 읽는다.
 */
export function openCommodoreLoginCard(): void {
  const api = getQuotaApi();
  if (api) void beginClaudeLogin(api);
  requestQuotaPanelOpen();
}
