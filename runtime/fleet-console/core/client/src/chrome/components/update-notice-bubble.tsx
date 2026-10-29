import { useEffect, useRef, useState } from "react";

import { ApiError } from "../../integration/api.js";
import { requestDesktopShellUpdate, useDesktopShellUpdate, type DesktopShellUpdate } from "../../integration/desktop-shell-update.js";
import { useDesktopHomeOrigin, type DesktopShellHome } from "../../integration/desktop-shell.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { openWhatsNew } from "../../integration/store.js";
import { requestConsoleUpdate, useUpdateProgress } from "../../../../../features/updates/client/update-progress-store.js";

/**
 * 새 버전이 나왔다는 말풍선. 앱 메뉴 버튼 위에 늘 서서, 메뉴를 열어 보지 않아도 바로 편다 —
 * 메뉴 안의 점만으로는 열어 볼 이유가 되지 못했다. 말풍선이 메뉴 안에 살던 동안에는 닫힌 메뉴와
 * 함께 숨어 있다가 메뉴를 여는 순간 그 위에 겹쳐 떴다. 메뉴가 열려 있으면 물러선다.
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

export interface UpdateSignals {
  readonly shell: DesktopShellHome;
  readonly shellUpdate: DesktopShellUpdate;
  /** 이 창이 이 기계의 콘솔을 보고 있는가 — 셸 재시작이 그 콘솔까지 데려오는 경우다. */
  readonly onHomeConsole: boolean;
  readonly consoleFoldsIntoShell: boolean;
  /** 도움말 점의 뜻: 이 메뉴 안에 올릴 것이 있다 — Console이든 Desktop이든. */
  readonly updateReady: boolean;
}

/**
 * 도움말 메뉴와 말풍선이 함께 읽는 갱신 판정. 둘은 따로 마운트되지만 같은 셸 스냅샷을 구독하므로,
 * 메뉴가 열릴 때 다시 읽은 값이 말풍선에도 그대로 닿는다.
 */
export function useUpdateSignals(input: {
  readonly reloadToken: number;
  readonly updateAvailable: boolean;
  readonly shellUpdateRequired: boolean;
}): UpdateSignals {
  const shell = useDesktopHomeOrigin(input.reloadToken);
  const shellUpdate = useDesktopShellUpdate(input.reloadToken);
  const consoleActionable = input.updateAvailable && !input.shellUpdateRequired;
  /**
   * 셸 재시작 한 번이 Console까지 최신으로 만든다 — 돌아온 셸의 진입 흐름이 새 Console을 조달하기
   * 때문이다. 그래서 셸 갱신이 걸려 있으면 Console 행은 칩을 거두고 그 사실만 말한다.
   *
   * 창이 남의 기계의 콘솔을 보고 있으면 접지 않는다. 그때 두 행은 서로 다른 기계를 가리키고 있어,
   * 접는 순간 남의 호스트 재시작이 내 앱 재시작에 숨는다.
   */
  const onHomeConsole = shell.origin !== null && shell.origin === window.location.origin;
  return {
    shell,
    shellUpdate,
    onHomeConsole,
    consoleFoldsIntoShell: input.updateAvailable
      && onHomeConsole
      && (shellUpdate.stage === "available" || shellUpdate.stage === "downloading" || shellUpdate.stage === "ready"),
    updateReady: consoleActionable || shellUpdate.stage === "available" || shellUpdate.stage === "ready",
  };
}

/**
 * 앱 메뉴 버튼 곁에 늘 마운트되는 말풍선. 메뉴가 열려 있는 동안(`suppressed`)은 서지 않는다 —
 * 같은 자리에 판이 둘 서면 어느 것도 읽히지 않는다.
 */
export function ConsoleUpdateNotice({ suppressed, onEscape }: {
  readonly suppressed: boolean;
  /** 키보드로 닫은 뒤 초점을 돌려줄 곳. */
  readonly onEscape: () => void;
}) {
  const state = useConsoleState();
  const signals = useUpdateSignals({ reloadToken: 0, updateAvailable: state.updateAvailable, shellUpdateRequired: state.shellUpdateRequired });
  // 셸이 먼저 바뀌어야 하는 Console 갱신은 셸 갱신에 실려 올 때만 알린다 — 따로 알릴 버튼이 없다.
  const notice = useUpdateNotice({
    shellUpdate: signals.shellUpdate,
    updateAvailable: state.shellUpdateRequired ? signals.consoleFoldsIntoShell : state.updateAvailable,
    latestVersion: state.latestVersion,
    onHomeConsole: signals.onHomeConsole,
  });
  // 업데이트 결과 배너가 서 있는 동안 말풍선은 물러선다 — 같은 자리에 겹치면 배너가 전하는 사유가 가려진다.
  // 닫기(dismiss)와 달리 기억하지 않으므로, 배너를 확인하면 말풍선이 돌아와 다시 시도할 수 있다.
  const outcomeShowing = useUpdateProgress().outcome !== null;
  if (suppressed || outcomeShowing || notice.kind === null || notice.dismissed) return null;
  return (
    <UpdateNoticeBubble
      kind={notice.kind}
      shellUpdate={signals.shellUpdate}
      latestVersion={state.latestVersion}
      consoleFolds={notice.consoleFolds}
      hasShell={signals.shell.desktopVersion !== null}
      onHomeConsole={signals.onHomeConsole}
      onDismiss={notice.dismiss}
      onEscape={() => { notice.dismiss(); onEscape(); }}
    />
  );
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

export function UpdateNoticeBubble({ kind, shellUpdate, latestVersion, consoleFolds, hasShell, onHomeConsole, onDismiss, onEscape }: {
  readonly kind: UpdateNoticeKind;
  readonly shellUpdate: DesktopShellUpdate;
  readonly latestVersion: string | null;
  readonly consoleFolds: boolean;
  readonly hasShell: boolean;
  readonly onHomeConsole: boolean;
  readonly onDismiss: () => void;
  readonly onEscape: () => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 버블 단계에서 듣는다 — 먼저 Escape를 소비한 메뉴가 있으면 말풍선은 남는다.
    // 경계는 말풍선이 달린 자리(앱 메뉴 버튼과 그 곁)다. 다른 곳의 Escape는 이 말풍선의 일이 아니다.
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Node)) return;
      const boundary = rootRef.current?.parentElement;
      if (!boundary?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onEscape]);
  const [consoleState, setConsoleState] = useState<"idle" | "armed">("idle");
  const preparing = useUpdateProgress().preparing !== null;
  const shell = kind === "shell";
  const stage = shellUpdate.stage;

  const applyConsole = async (): Promise<void> => {
    if (latestVersion === null || preparing) return;
    const acknowledgeHostRestart = consoleState === "armed";
    try {
      const result = await requestConsoleUpdate(latestVersion, acknowledgeHostRestart ? { acknowledgeHostRestart: true } : {});
      if (result === "busy") return;
      setConsoleState("idle");
    } catch (error) {
      const code = error instanceof ApiError ? error.message : "network_error";
      // 남의 기계를 재시작하는 일은 한 번 더 누르게 한다 — 버전 행과 같은 문법이다.
      setConsoleState(code === "host_restart_confirmation_required" ? "armed" : "idle");
    }
  };

  // 제목이 곧 무엇이 나왔는지다. 따로 "업데이트 가능" 머리를 두지 않는다 — 버튼이 그 말을 한다.
  const title = shell
    ? shellLead(stage, shellUpdate.version ?? "", t)
    : t("chrome.updateNotice.consoleAvailable", { version: latestVersion ?? "" });
  const detail = shell
    ? shellDetail(stage, consoleFolds ? latestVersion : null, t)
    : consoleDetail(consoleState, hasShell, onHomeConsole, t);
  const actionLabel = shell
    ? stage === "ready" ? t("chrome.updateNotice.restart") : stage === "error" ? t("common.retry") : t("chrome.updateNotice.update")
    : consoleState === "armed" ? t("chrome.system.update.confirmHostRestartConfirm")
      : preparing ? t("chrome.system.update.requesting") : t("chrome.updateNotice.update");
  // Console은 worker가 준비될 때까지 답을 미룬다. 그동안은 커튼이 아니라 누른 자리에서 요청 중임을 말한다.
  const actionBusy = !shell && preparing;

  return (
    <div ref={rootRef} className="command-band-update-bubble" role="status" aria-live="polite">
      <div className="command-band-update-bubble-head">
        <span className="command-band-update-bubble-title">{title}</span>
        <button type="button" className="command-band-update-bubble-close" onClick={onDismiss} aria-label={t("chrome.toast.dismissNotification")}>×</button>
      </div>
      <p className="command-band-update-bubble-detail">{detail}</p>
      {shell && stage === "downloading" ? (
        <span className="command-band-update-bubble-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, (shellUpdate.percent ?? 0) / 100))})` }} />
        </span>
      ) : null}
      <div className="command-band-update-bubble-row">
        <button type="button" className="command-band-update-bubble-link" onClick={() => openWhatsNew()}>{t("chrome.updateNotice.releaseNotes")}</button>
        {/* 받는 중에는 누를 것이 없다 — 진행은 막대와 문장이 말한다. */}
        {shell && stage === "downloading" ? null : (
          <button
            type="button"
            className="command-band-update-bubble-action"
            disabled={actionBusy}
            aria-busy={actionBusy || undefined}
            onClick={() => {
              if (shell) void requestDesktopShellUpdate(stage === "ready" ? "restart" : "download");
              else void applyConsole();
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
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
