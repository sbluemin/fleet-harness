import { useState } from "react";

import { ApiError, applyConsoleUpdate } from "../../integration/api.js";
import { requestDesktopShellUpdate, type DesktopShellUpdate } from "../../integration/desktop-shell-update.js";
import { useT } from "../../i18n/index.js";
import { openWhatsNew } from "../../integration/store.js";
import { beginUpdateWatch, markUpdateDelegated } from "../../../../../features/updates/client/update-progress-store.js";

/**
 * 새 버전이 나왔다는 말풍선. 도움말 버튼에 달려, 그 점이 가리키는 것을 열어 보지 않아도 바로 편다 —
 * 점만으로는 메뉴를 열어 볼 이유가 되지 못했고, 그래서 Desktop은 사실상 갱신되지 않았다.
 *
 * 닫으면 그 버전으로는 다시 서지 않고 점만 남는다: 알림은 알리는 것이지 조르는 것이 아니다.
 *
 * 둘 다 밀렸고 이 창이 이 기계의 콘솔을 보고 있으면 말풍선은 하나만 선다. 셸 재시작이 Console도
 * 최신으로 만들기 때문이다 — 두 장을 세우면 사용자는 두 번 누르고 두 번 재시작한다.
 */

const DISMISSED_KEY = "fleet-console.update-notice-dismissed";

export type UpdateNoticeKind = "shell" | "console";

export interface UpdateNotice {
  readonly kind: UpdateNoticeKind | null;
  /** 이 창이 보고 있는 콘솔의 갱신이 셸 재시작에 접히는가. */
  readonly consoleFolds: boolean;
  readonly dismissed: boolean;
  readonly dismiss: () => void;
}

export function useUpdateNotice(input: {
  readonly shellUpdate: DesktopShellUpdate;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly onHomeConsole: boolean;
}): UpdateNotice {
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissed);
  const shellShows = input.shellUpdate.stage !== "idle" && input.shellUpdate.version !== null;
  const consoleShows = input.updateAvailable && input.latestVersion !== null;
  /**
   * 말풍선은 한 번에 한 장이고, 둘 다 밀렸으면 셸이 먼저다.
   *
   * 이 기계의 콘솔을 보고 있으면 그 한 장이 둘을 다 말한다(셸 재시작이 Console도 데려온다).
   * 원격 콘솔을 보고 있으면 그렇지 않은데, 그때 Console 갱신은 도움말 점과 메뉴 행에만 남는다 —
   * 두 장을 쌓는 대신 받아들인 한계다. 셸을 갱신하고 돌아온 사용자는 앱을 끄지 않고 그 자리에서
   * 원격 콘솔을 이어서 갱신할 수 있고, 그 사이 잃는 것은 알림 한 장뿐이다.
   */
  const kind: UpdateNoticeKind | null = shellShows ? "shell" : consoleShows ? "console" : null;
  const token = shellShows ? `desktop:${input.shellUpdate.version}` : consoleShows ? `console:${input.latestVersion}` : null;

  return {
    kind,
    consoleFolds: consoleShows && shellShows && input.onHomeConsole,
    dismissed: token === null || dismissed.includes(token),
    dismiss: () => {
      if (token === null) return;
      const next = [...new Set([...dismissed, token])].slice(-20);
      setDismissed(next);
      writeDismissed(next);
    },
  };
}

export function UpdateNoticeBubble({ kind, shellUpdate, latestVersion, consoleFolds, hasShell, onHomeConsole, onDismiss }: {
  readonly kind: UpdateNoticeKind;
  readonly shellUpdate: DesktopShellUpdate;
  readonly latestVersion: string | null;
  readonly consoleFolds: boolean;
  readonly hasShell: boolean;
  readonly onHomeConsole: boolean;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  const [consoleState, setConsoleState] = useState<"idle" | "armed" | "applying">("idle");
  const shell = kind === "shell";
  const stage = shellUpdate.stage;

  const applyConsole = async (): Promise<void> => {
    if (latestVersion === null || consoleState === "applying") return;
    const acknowledgeHostRestart = consoleState === "armed";
    setConsoleState("applying");
    try {
      const result = await applyConsoleUpdate(acknowledgeHostRestart ? { acknowledgeHostRestart: true } : {});
      // 202는 시작됐다는 뜻일 뿐이다. 결과를 아는 것은 재기동을 겪고 돌아온 콘솔이고, 그때까지 화면은 커튼이 소유한다.
      if (result.status === "delegated") markUpdateDelegated(latestVersion);
      else beginUpdateWatch(latestVersion);
    } catch (error) {
      const code = error instanceof ApiError ? error.message : "network_error";
      // 남의 기계를 재시작하는 일은 한 번 더 누르게 한다 — 버전 행과 같은 문법이다.
      setConsoleState(code === "host_restart_confirmation_required" ? "armed" : "idle");
    }
  };

  const title = shell && stage === "ready" ? t("chrome.updateNotice.readyTitle") : t("chrome.updateNotice.title");
  const lead = shell
    ? shellLead(stage, shellUpdate.version ?? "", t)
    : t("chrome.updateNotice.consoleAvailable", { version: latestVersion ?? "" });
  const detail = shell
    ? shellDetail(stage, consoleFolds ? latestVersion : null, t)
    : consoleDetail(consoleState, hasShell, onHomeConsole, t);
  const actionLabel = shell
    ? stage === "ready" ? t("chrome.updateNotice.restart") : stage === "error" ? t("common.retry") : t("chrome.updateNotice.update")
    : consoleState === "armed" ? t("chrome.system.update.confirmHostRestartConfirm") : t("chrome.updateNotice.update");

  return (
    <div className="command-band-update-bubble" role="status" aria-live="polite">
      <div className="command-band-update-bubble-head">
        <span className="command-band-update-bubble-title">{title}</span>
        <button type="button" className="command-band-update-bubble-close" onClick={onDismiss} aria-label={t("chrome.toast.dismissNotification")}>×</button>
      </div>
      <p className="command-band-update-bubble-lead">{lead}</p>
      <p className="command-band-update-bubble-detail">{detail}</p>
      {shell && stage === "downloading" ? (
        <span className="command-band-update-bubble-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, (shellUpdate.percent ?? 0) / 100))})` }} />
        </span>
      ) : null}
      <button type="button" className="command-band-update-bubble-link" onClick={() => openWhatsNew()}>{t("chrome.updateNotice.releaseNotes")}</button>
      {/* 받는 중에는 누를 것이 없다 — 진행은 막대와 문장이 말한다. */}
      {shell && stage === "downloading" ? null : (
        <button
          type="button"
          className="command-band-update-bubble-action"
          onClick={() => {
            if (shell) void requestDesktopShellUpdate(stage === "ready" ? "restart" : "download");
            else void applyConsole();
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useT>;

function shellLead(stage: string, version: string, t: Translate): string {
  if (stage === "downloading") return t("chrome.updateNotice.desktopDownloading", { version });
  if (stage === "ready") return t("chrome.updateNotice.desktopReady", { version });
  if (stage === "error") return t("chrome.updateNotice.desktopFailed");
  return t("chrome.updateNotice.desktopAvailable", { version });
}

function shellDetail(stage: string, foldedConsoleVersion: string | null, t: Translate): string {
  if (stage === "downloading") return t("chrome.updateNotice.keepWorking");
  if (stage === "error") return t("chrome.updateNotice.desktopFailedDetail");
  // 접힌 Console 버전을 여기서 함께 말한다 — 말풍선을 한 장으로 줄인 이유가 그 한 줄이다.
  if (foldedConsoleVersion !== null) return t("chrome.updateNotice.desktopCarriesConsole", { version: foldedConsoleVersion });
  return t("chrome.updateNotice.desktopOnlyThisMachine");
}

function consoleDetail(state: string, hasShell: boolean, onHomeConsole: boolean, t: Translate): string {
  if (state === "armed") return t("chrome.system.update.confirmHostRestartTitle");
  if (hasShell && !onHomeConsole) return t("chrome.updateNotice.consoleRemote");
  if (hasShell) return t("chrome.updateNotice.consoleShellRestart");
  return t("chrome.updateNotice.consoleInPlace");
}

function readDismissed(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(tokens: readonly string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(tokens));
  } catch {
    // 닫았다는 기억은 편의일 뿐이다 — 저장이 막혀도 알림 자체는 제 일을 한다.
  }
}
