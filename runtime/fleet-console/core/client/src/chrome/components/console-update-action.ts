import { useEffect, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { ApiError, checkConsoleUpdate } from "../../integration/api.js";
import { setState } from "../../integration/store.js";
import { requestConsoleUpdate, useUpdateProgress } from "../../../../../features/updates/client/update-progress-store.js";
import type { CoreMessageKey } from "../../i18n/index.js";

/**
 * Console 업데이트를 시작하는 두 화면(데스크톱 버전 행, 폰 업데이트 시트)이 같이 타는 상태 머신.
 * idle → armed(원격 호스트 재시작 동의 대기) / blocked(누를 수 없음) / error(다시 시도), 요청 중은 업데이트 store의 preparing이다.
 */

export type UpdateApplyState = "idle" | "armed" | "blocked" | "error";

export interface UpdateApplyCopy {
  readonly label: string;
  /** 행 안에서 라벨 뒤에 붙는 두 번째 줄. 버전 델타나 확인 문구가 여기 온다. */
  readonly detail?: string;
  readonly title: string;
  readonly tone: "info" | "warn" | "live" | "blocked" | "error";
  readonly disabled: boolean;
}


/**
 * 캐시를 기다리지 않고 지금 묻는다. 서버가 레지스트리를 다시 조회하고, 그 답을 스토어에 바로 쓴다 —
 * 달라졌다면 SSE로도 오지만, 같을 때는 이 응답만이 "확인했다"는 증거다.
 * 새 버전이 있으면 true: 행이 칩 행으로 바뀌므로 "최신" 표시는 필요 없다.
 */
export async function refreshConsole(): Promise<boolean> {
  const status = await checkConsoleUpdate();
  setState({ updateAvailable: status.updateAvailable, latestVersion: status.latestVersion, shellUpdateRequired: status.shellUpdateRequired });
  return status.updateAvailable;
}


export type VersionRefreshState = "idle" | "busy" | "current" | "failed";
export const VERSION_REFRESH_RESULT_MS = 3000;

/** 「최신 버전 확인」의 상태 — 결과(최신·확인 실패)는 3초만 서고 idle로 돌아간다. 새 버전이면 호출자의 행이 바뀌므로 결과를 싣지 않는다. */
export function useVersionRefresh(onRefresh: () => Promise<boolean>): { readonly state: VersionRefreshState; readonly refresh: () => Promise<void> } {
  const [state, setRefreshState] = useState<VersionRefreshState>("idle");

  useEffect(() => {
    if (state !== "current" && state !== "failed") return;
    const timer = setTimeout(() => setRefreshState("idle"), VERSION_REFRESH_RESULT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const refresh = async () => {
    if (state === "busy") return;
    setRefreshState("busy");
    try {
      const newer = await onRefresh();
      setRefreshState(newer ? "idle" : "current");
    } catch {
      setRefreshState("failed");
    }
  };
  return { state, refresh };
}

/**
 * 업데이트 요청의 상태. 첫 누름이 원격 리스너의 409(host_restart_confirmation_required)를 받으면 armed가 되고,
 * 두 번째 누름이 acknowledgeHostRestart를 실어 보낸다. 수락이든 거절이든 `apply`는 다시 누를 수 있게 돌아간다 —
 * 거절의 사유는 상단 배너가, 수락 뒤의 화면은 커튼이 소유한다. 반환 값은 요청이 서버에 닿아 처리되었는지다.
 */
export function useConsoleUpdateAction(latestVersion: string | null, t: Translate<CoreMessageKey>): {
  readonly applyState: UpdateApplyState;
  readonly preparing: boolean;
  readonly copy: UpdateApplyCopy;
  readonly apply: () => Promise<boolean>;
} {
  const [applyState, setApplyState] = useState<UpdateApplyState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const preparing = useUpdateProgress().preparing !== null;
  const copy = resolveUpdateApplyCopyFor(applyState, errorCode, latestVersion, t);

  const apply = async (): Promise<boolean> => {
    if (latestVersion === null || copy.disabled || preparing) return false;
    const acknowledgeHostRestart = applyState === "armed";
    setErrorCode(null);
    try {
      const result = await requestConsoleUpdate(latestVersion, acknowledgeHostRestart ? { acknowledgeHostRestart: true } : {});
      if (result === "busy") return false;
      setApplyState("idle");
      return true;
    } catch (error) {
      const code = error instanceof ApiError ? error.message : "network_error";
      setErrorCode(code);
      if (code === "host_restart_confirmation_required") {
        setApplyState("armed");
        return false;
      }
      setApplyState(isBlockedUpdateApplyError(code) ? "blocked" : "error");
      return false;
    }
  };
  return { applyState, preparing, copy, apply };
}

export function resolveUpdateApplyCopyFor(
  applyState: UpdateApplyState,
  errorCode: string | null,
  latestVersion: string | null,
  t: Translate<CoreMessageKey>,
): UpdateApplyCopy {
  const latest = latestVersion
    ? t("chrome.system.update.latestVersion", { version: latestVersion })
    : t("chrome.system.update.available");
  if (applyState === "armed") {
    return {
      label: t("chrome.system.update.confirmHostRestart"),
      detail: t("chrome.system.update.confirmHostRestartConfirm"),
      title: t("chrome.system.update.confirmHostRestartTitle"),
      tone: "warn",
      disabled: false,
    };
  }
  if (applyState === "blocked") return resolveBlockedUpdateApplyCopy(errorCode, t);
  if (applyState === "error") return { label: t("common.retry"), title: resolveUpdateErrorTitle(errorCode, t), tone: "error", disabled: false };
  // 대기 중 업데이트 안내는 정보다. 칩은 목표 버전만 말하고, 신호 채널은 확인 대기(warn)·진행(live)·실패(error)만 쓴다.
  return { label: latestVersion ? `v${latestVersion} ↑` : t("chrome.system.update.available"), title: latest, tone: "info", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null, t: Translate<CoreMessageKey>): UpdateApplyCopy {
  if (errorCode === "local_channel") return { label: t("chrome.system.update.local"), title: t("chrome.system.update.localTitle"), tone: "blocked", disabled: true };
  // 이 콘솔이 스스로 갈아 끼울 수 없는 레이아웃은 이제 셸에게 넘어간다. 이 문구는 그
  // 위임을 모르는 옛 서버에 붙었을 때만 남는 마지막 안내다.
  if (errorCode === "managed_runtime_update_requires_relaunch") return { label: t("chrome.system.update.managed"), title: t("chrome.system.update.managedTitle"), tone: "blocked", disabled: true };
  if (errorCode === "shell_update_required") return { label: t("chrome.system.update.shellRequired"), title: t("chrome.system.update.shellRequiredTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_already_in_progress") return { label: t("chrome.system.update.busy"), title: t("chrome.system.update.busyTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_not_available") return { label: t("chrome.system.update.current"), title: t("chrome.system.update.currentTitle"), tone: "blocked", disabled: true };
  return { label: t("chrome.system.update.blocked"), title: t("chrome.system.update.blockedTitle"), tone: "error", disabled: false };
}

// 내려받기·검증 실패는 콘솔을 내리기 전에 난다. 다시 누를 수 있는 실패이므로 이유만 제목에 적는다.
function resolveUpdateErrorTitle(errorCode: string | null, t: Translate<CoreMessageKey>): string {
  if (errorCode === "checksum_mismatch") return t("chrome.system.update.checksumTitle");
  if (errorCode === "download_failed") return t("chrome.system.update.downloadFailedTitle");
  return t("chrome.system.update.retryTitle");
}

export function isBlockedUpdateApplyError(code: string): boolean {
  return code === "local_channel" || code === "managed_runtime_update_requires_relaunch" || code === "shell_update_required" || code === "update_already_in_progress" || code === "update_not_available";
}

