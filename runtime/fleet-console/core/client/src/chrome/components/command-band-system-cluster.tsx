import { useEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/i18n";

import { useUpdateProgress } from "../../../../../features/updates/client/update-progress-store.js";
import { refreshConsole, useConsoleUpdateAction, useVersionRefresh } from "./console-update-action.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { isDesktopShell, PICKER_ANCHOR_PARAM, PICKER_AT_PARAM, PICKER_PLACE_PARAM, PICKER_PLACE_SIDE, PICKER_SURFACE_OPEN, PICKER_SURFACE_PARAM, useDesktopHomeOrigin, type DesktopShellHome } from "../../integration/desktop-shell.js";
import { requestDesktopShellUpdate, useDesktopShellUpdate, type DesktopShellUpdate } from "../../integration/desktop-shell-update.js";
import { UpdateNoticeBubble, useUpdateNotice } from "./update-notice-bubble.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT, type CoreMessageKey } from "../../i18n/index.js";
import { COMMISSIONING_SEEN_KEY, openWhatsNew, setState } from "../../integration/store.js";
import { forgetReplayableOnboarding } from "../../../../../features/onboarding/client/onboarding-host.js";
import { EFFORT_CONFIRM_TIP_SEEN_KEY } from "../../../../../features/onboarding/client/seen-store.js";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog.js";
import { useMenuButtonKeyboard } from "./use-menu-button-keyboard.js";
import { useSideSubmenu, type SideSubmenuGroup } from "./use-side-submenu.js";

export { placeSubmenu, submenuContentHeight, useSideSubmenuGroup, type SideSubmenuGroup, type SubmenuPlacement } from "./use-side-submenu.js";

interface GithubStarsState {
  readonly count: number | null;
  readonly status: "idle" | "loading" | "ready" | "error";
}

const GITHUB_REPO_URL = "https://github.com/sbluemin/fleet-harness";
const GITHUB_STARGAZERS_URL = "https://github.com/sbluemin/fleet-harness/stargazers";
const GITHUB_STARS_API_URL = "https://api.github.com/repos/sbluemin/fleet-harness";
const GITHUB_STARS_CACHE_KEY = "fleet-console.github-stars";
const GITHUB_STARS_TTL_MS = 6 * 60 * 60 * 1000;
const GITHUB_LATEST_RELEASE_URL = "https://github.com/sbluemin/fleet-harness/releases/latest";

/** 창 좌표로 말이 되는 상한. 이보다 큰 값은 칩의 자리가 아니다. */
const PICKER_ANCHOR_LIMIT = 100_000;

/**
 * 목록을 부른 칩의 자리 — 부른 콘솔의 뷰포트 CSS px. 덮개는 창 전체를 덮으므로 배율만 다를 뿐 같은
 * 자리를 가리키고, 그 배율 차이는 덮개가 뷰포트 폭의 비로 되돌린다.
 */
export interface HostPickerAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface HostPickerContext {
  /** 이 목록을 부른 콘솔. 현재 줄을 표시하는 데만 쓴다. */
  readonly at: string | null;
  /** 판을 매달 칩의 자리. 없거나 말이 안 되면 null이고, 판은 창 모서리에 선다. */
  readonly anchor: HostPickerAnchor | null;
  /** 부른 자리가 메뉴 항목이면 판은 그 옆에 서브메뉴로 선다. 도구모음 칩이면 위·아래에 매달린다. */
  readonly side: boolean;
}

/**
 * 이 화면이 "집의 목록만 펼치는 표면"으로 서빙됐는가.
 *
 * 부른 쪽이 실어 보낸 값은 그대로 믿지 않는다 — 화면에 그릴 값이므로 모양을 먼저 본다.
 */
export function readHostPickerSurface(search: string): HostPickerContext | null {
  const params = new URLSearchParams(search);
  if (params.get(PICKER_SURFACE_PARAM) !== PICKER_SURFACE_OPEN) return null;
  const at = params.get(PICKER_AT_PARAM);
  return {
    at: at !== null && isConsoleOriginShape(at) ? at : null,
    anchor: parsePickerAnchor(params.get(PICKER_ANCHOR_PARAM)),
    side: params.get(PICKER_PLACE_PARAM) === PICKER_PLACE_SIDE,
  };
}

/** 정수 여섯 개(left,top,right,bottom,뷰포트 폭,높이)만 받는다. 칩이 뷰포트 안에 서지 않으면 버린다. */
function parsePickerAnchor(value: string | null): HostPickerAnchor | null {
  if (value === null || !/^\d{1,6}(,\d{1,6}){5}$/.test(value)) return null;
  const [left, top, right, bottom, viewportWidth, viewportHeight] = value.split(",").map(Number) as [number, number, number, number, number, number];
  if (viewportWidth === 0 || viewportHeight === 0 || viewportWidth > PICKER_ANCHOR_LIMIT || viewportHeight > PICKER_ANCHOR_LIMIT) return null;
  if (left > right || top > bottom || right > viewportWidth || bottom > viewportHeight) return null;
  return { left, top, right, bottom, viewportWidth, viewportHeight };
}

function isConsoleOriginShape(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

/** 도움말 메뉴 — 도구모음의 한 칸이다. 상단 바에서는 아래로, 독의 메뉴 항목에서는 호스트와 같이 옆으로 열린다. */
export function ConsoleHelpMenu({ menuItem = false, sideSubmenuGroup }: { readonly menuItem?: boolean; readonly sideSubmenuGroup?: SideSubmenuGroup } = {}) {
  const state = useConsoleState();
  return (
    <HelpMenu
      menuItem={menuItem}
      sideSubmenuGroup={sideSubmenuGroup}
      version={state.version}
      latestVersion={state.latestVersion}
      updateAvailable={state.updateAvailable}
      shellUpdateRequired={state.shellUpdateRequired}
      // 새로고침/언어 전환 실패는 이미 표시 중인 노트를 버리지 않는다. 남은 노트가 있으면
      // Help 진입도 열어 두어 inline 오류를 보고 다시 시도할 수 있어야 한다.
      releaseDisabled={state.releaseNotesLoading || state.releaseNotes.length === 0}
    />
  );
}

/**
 * 집에 서 있는가 — 호스트 칩과 독 아바타가 함께 쓰는 단 하나의 판정이다.
 *
 * 셸이 창을 들고 있는데 아직 집 주소를 못 받았다면 집이 아니다. 셸이 집을 말하지 않으면
 * "이 컴퓨터" 목록에 지금 콘솔이 실렸는지(`nearbyCurrent`)로 대신한다.
 */
function isStandingAtHome(canOpenRemote: boolean, shellHome: DesktopShellHome, currentOrigin: string, nearbyCurrent: boolean): boolean {
  return canOpenRemote && shellHome.pending
    ? false
    : shellHome.origin === null ? nearbyCurrent : currentOrigin === shellHome.origin;
}

/**
 * 이 화면이 집을 떠나 다른 호스트에 서 있는가 — 호스트 칩의 `is-away`와 같은 규칙이다.
 * 제어를 나눠 쓰는 동안은 칩이 공유 표시를 하므로 떠나 있다고 하지 않는다.
 *
 * 칩 밖(피커가 아닌 이 화면 자신)에서 묻는 자리라 서 있는 곳은 `location.origin`이다. 이때
 * `nearbyCurrent`는 루프백 여부와 같다: 루프백이면 목록이 스캔에 없어도 지금 콘솔을 싣고,
 * 루프백이 아니면 스캔 자체를 하지 않아 목록에는 (셸이 집을 말하지 않은) 이 분기에서 아무것도 없다.
 */
export function useStandingAway(): boolean {
  const state = useConsoleState();
  const shellHome = useDesktopHomeOrigin();
  const currentOrigin = location.origin;
  return state.controlHolder === null
    && !isStandingAtHome(isDesktopShell(), shellHome, currentOrigin, isLoopbackOrigin(currentOrigin));
}

/** 루프백 콘솔만 이 창이 주소 그대로 열 수 있다 — 다른 기계의 127.0.0.1은 여기서 우리 기계다. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]");
  } catch {
    return false;
  }
}

// "화면 안내 다시 보기" — 화면에 닻을 건 투어 하나가 아니라 온보딩 전체를 초기화한다. 엔진이 마운트한 모든 기여의
// 엔트리 힌트·투어 시청 기록과 최초 설정 가이드·강도 확인 팁 기록을 함께 지워, 어느 화면에 있든 처음부터 다시 보게 한다.
function forgetAllOnboarding(seen: readonly string[]): readonly string[] {
  const drop = new Set([COMMISSIONING_SEEN_KEY, EFFORT_CONFIRM_TIP_SEEN_KEY]);
  const afterOnboarding = forgetReplayableOnboarding(seen);
  const next = afterOnboarding.filter((key) => !drop.has(key));
  return next.length === afterOnboarding.length ? afterOnboarding : next;
}

function HelpMenu({ releaseDisabled, updateAvailable, shellUpdateRequired, latestVersion, version, menuItem, sideSubmenuGroup }: {
  readonly menuItem?: boolean;
  readonly sideSubmenuGroup?: SideSubmenuGroup;
  readonly releaseDisabled: boolean;
  readonly updateAvailable: boolean;
  /** 새 Console이 있지만 이 셸이 먼저 바뀌어야 받을 수 있다. Console 쪽에서 누를 것은 없다. */
  readonly shellUpdateRequired: boolean;
  readonly latestVersion: string | null;
  readonly version: string;
}) {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const side = useSideSubmenu({
    enabled: menuItem === true,
    open,
    setOpen,
    rootRef,
    triggerRef,
    panelRef: menuRef,
    group: menuItem === true ? sideSubmenuGroup : undefined,
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const globalSettings = useGlobalSettingsStore();
  const seenFeatureTours = globalSettings.state?.seenFeatureTours ?? [];
  // 메뉴가 열릴 때마다 셸 스냅샷을 다시 읽는다 — 느린 핸드오프에서는 버전이 첫 읽기 뒤에 도착한다.
  const [opens, setOpens] = useState(0);
  useEffect(() => { if (open) setOpens((count) => count + 1); }, [open]);
  const shell = useDesktopHomeOrigin(opens);
  const shellUpdate = useDesktopShellUpdate(opens);
  // 점의 뜻은 "이 메뉴 안에 올릴 것이 있다"이다 — Console이든 Desktop이든. 어느 행인지는
  // 메뉴를 열면 칩이 말한다.
  const consoleActionable = updateAvailable && !shellUpdateRequired;
  const updateReady = consoleActionable || shellUpdate.stage === "available" || shellUpdate.stage === "ready";
  /**
   * 셸 재시작 한 번이 Console까지 최신으로 만든다 — 돌아온 셸의 진입 흐름이 새 Console을 조달하기
   * 때문이다. 그래서 셸 갱신이 걸려 있으면 Console 행은 칩을 거두고 그 사실만 말한다.
   *
   * 창이 남의 기계의 콘솔을 보고 있으면 접지 않는다. 그때 두 행은 서로 다른 기계를 가리키고 있어,
   * 접는 순간 남의 호스트 재시작이 내 앱 재시작에 숨는다.
   */
  const onHomeConsole = shell.origin !== null && shell.origin === window.location.origin;
  const consoleFoldsIntoShell = updateAvailable
    && onHomeConsole
    && (shellUpdate.stage === "available" || shellUpdate.stage === "downloading" || shellUpdate.stage === "ready");
  // 셸이 먼저 바뀌어야 하는 Console 갱신은 셸 갱신에 실려 올 때만 알린다 — 따로 알릴 버튼이 없다.
  const notice = useUpdateNotice({ shellUpdate, updateAvailable: shellUpdateRequired ? consoleFoldsIntoShell : updateAvailable, latestVersion, onHomeConsole });
  // 업데이트 결과 배너가 서 있는 동안 말풍선은 물러선다 — 같은 자리에 겹치면 배너가 전하는 사유가 가려진다.
  // 닫기(dismiss)와 달리 기억하지 않으므로, 배너를 확인하면 말풍선이 돌아와 다시 시도할 수 있다.
  const outcomeShowing = useUpdateProgress().outcome !== null;
  // "화면 안내 다시 보기"는 화면에 닻을 건 투어 하나가 아니라 온보딩 전체를 초기화한다 —
  // 카탈로그의 모든 피처 투어 시청 기록과 최초 설정 가이드 기록을 함께 지워, 어느 화면에
  // 있든 온보딩을 처음부터 다시 보게 한다.
  const replayDisabled = forgetAllOnboarding(seenFeatureTours) === seenFeatureTours;

  // 메뉴 항목일 때는 옆 서브메뉴가 키·바깥 누름을 맡는다. 도구모음 칩은 아래로 열리는 판 그대로다.
  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, menuItem === true ? false : open, setOpen);

  const replayScreenGuide = () => {
    const next = forgetAllOnboarding(seenFeatureTours);
    setOpen(false);
    if (next === seenFeatureTours) return;
    void setGlobalSettingsField("seenFeatureTours", next);
  };

  return <span ref={rootRef} className="command-band-system-anchor">
    {/* 표식은 실행 버튼 위에 있어야 한다. 설정에 붙어 있던 동안 그 점을 따라간 사람은
        업데이트가 없는 화면에 도착했다. 색·크기·위치는 그대로 옮겨 온 것이며, 커맨드 밴드에
        같은 뜻의 표식이 둘이 되지 않도록 설정 쪽은 함께 제거했다. */}
    <button ref={triggerRef} type="button" role={menuItem ? "menuitem" : undefined} className="command-band-button command-band-help" onClick={() => { if (!side.openByHand()) setOpen((previous) => !previous); }} onPointerEnter={side.onTriggerPointerEnter} onPointerLeave={side.onTriggerPointerLeave} onKeyDown={side.onTriggerKeyDown} aria-haspopup="menu" aria-expanded={open} aria-label={updateReady ? t("chrome.system.helpUpdateReady") : t("chrome.system.help")} data-tip={updateReady ? t("chrome.system.helpUpdateReady") : t("chrome.system.help")}>
      <HelpGlyph />
      {menuItem ? <><span className="conversation-dock-label">{t("chrome.system.help")}</span><span className="conversation-dock-next" aria-hidden="true">›</span></> : null}
      {updateReady ? <span className="command-band-update-dot" aria-hidden="true" /> : null}
    </button>
    {!open && !outcomeShowing && notice.kind !== null && !notice.dismissed ? (
      <UpdateNoticeBubble
        kind={notice.kind}
        shellUpdate={shellUpdate}
        latestVersion={latestVersion}
        consoleFolds={notice.consoleFolds}
        hasShell={shell.desktopVersion !== null}
        onHomeConsole={onHomeConsole}
        onDismiss={notice.dismiss}
        onEscape={() => { notice.dismiss(); triggerRef.current?.focus(); }}
      />
    ) : null}
    {open ? <div ref={menuRef} className="command-band-system-menu" role="menu" aria-label={t("chrome.system.help")} onPointerEnter={side.onPanelPointerEnter} onPointerLeave={side.onPanelPointerLeave}>
      <button type="button" role="menuitem" disabled={releaseDisabled} onClick={() => { setOpen(false); openWhatsNew(); }}><WhatsNewGlyph /><span>{t("chrome.system.whatsNew")}</span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); setShortcutsOpen(true); }}><KeyboardGlyph /><span>{t("chrome.system.keyboardShortcuts")}</span></button>
      <button type="button" role="menuitem" disabled={replayDisabled} onClick={replayScreenGuide} title={t(replayDisabled ? "chrome.system.replayScreenGuideNone" : "chrome.system.replayScreenGuideTitle")}><ScreenGuideGlyph /><span>{t("chrome.system.replayScreenGuide")}</span></button>
      <div className="command-band-system-menu-divider" role="separator" />
      <ConsoleVersionRow version={version} latestVersion={updateAvailable ? latestVersion : null} foldedIntoShell={consoleFoldsIntoShell} shellUpdateRequired={shellUpdateRequired} onStarted={() => setOpen(false)} />
      {shell.desktopVersion ? <DesktopVersionRow version={shell.desktopVersion} update={shellUpdate} /> : null}
      <div className="command-band-system-menu-divider" role="separator" />
      <GithubLinks />
    </div> : null}
    {shortcutsOpen ? <KeyboardShortcutsDialog onClose={() => { setShortcutsOpen(false); triggerRef.current?.focus(); }} /> : null}
  </span>;
}

/**
 * 지금 서빙 중인 Console. 이름·버전은 늘 서고, 오른쪽 칩은 "더 새로운 버전"이 있을 때만 선다.
 * 칩이 서면 행 자체가 업데이트 버튼이다 — 상태 머신(idle → armed / blocked / error)은
 * 예전 업데이트 행의 것을 그대로 가져왔고, 두 번째 누름이 곧 호스트 재시작 동의라는 문법도 같다.
 * 요청 중인 표시는 이 행의 상태가 아니라 업데이트 store의 preparing이다.
 * 칩이 없으면(최신, 또는 확인 불가) 행은 정보만 말하는 정적 행이다.
 */
function ConsoleVersionRow({ version, latestVersion, foldedIntoShell, shellUpdateRequired, onStarted }: {
  readonly version: string;
  readonly latestVersion: string | null;
  /** 셸 재시작이 이 갱신까지 가져온다 — 누를 것을 두 개 두지 않고, 그 사실만 적는다. */
  readonly foldedIntoShell: boolean;
  readonly shellUpdateRequired: boolean;
  readonly onStarted: () => void;
}) {
  const t = useT();
  const { preparing, copy, apply } = useConsoleUpdateAction(latestVersion, t);
  const body = <><TerminalGlyph /><span className="command-band-version-row-name">Console</span><span className="command-band-version-row-version">v{version}</span></>;
  if (latestVersion !== null && foldedIntoShell) {
    return (
      <div className="command-band-version-row command-band-version-row--static command-band-version-row--blocked" aria-label={t("chrome.system.version.consoleFolded", { version, latest: latestVersion })} title={t("chrome.system.update.foldedTitle")}>
        {body}
        <span className="command-band-version-row-chip">{t("chrome.system.update.folded")}</span>
      </div>
    );
  }
  if (latestVersion !== null && shellUpdateRequired) {
    return (
      <div className="command-band-version-row command-band-version-row--static command-band-version-row--blocked" aria-label={t("chrome.system.version.consoleUpdate", { version, latest: latestVersion })} title={t("chrome.system.update.shellRequiredTitle")}>
        {body}
        <span className="command-band-version-row-chip">{t("chrome.system.update.shellRequired")}</span>
      </div>
    );
  }
  if (latestVersion === null) {
    return (
      <div className="command-band-version-row command-band-version-row--static" aria-label={t("chrome.system.version.console", { version })}>
        {body}
        <VersionRefresh onRefresh={refreshConsole} />
      </div>
    );
  }
  const label = preparing ? t("chrome.system.update.requesting") : copy.label;
  const title = preparing ? t("chrome.system.update.requestingTitle") : copy.title;

  const handleApply = async () => {
    // 수락이든 거절이든 메뉴는 닫아 상단 배너를 가리지 않는다. 409 동의 대기는 메뉴에 남아 두 번째 누름을 받는다.
    if (await apply()) onStarted();
  };

  if (!preparing && copy.tone === "warn") {
    // 묻는 문장은 한 줄 칩에 들어가지 않는다 — 이 상태만 이름·버전 대신 질문이 서고, 답 문장이 아래로 내려선다.
    return (
      <button type="button" role="menuitem" className="command-band-version-row command-band-version-row--warn" onClick={handleApply} title={copy.title} aria-live="polite">
        <TerminalGlyph />
        <span>{copy.label}</span>
        {copy.detail ? <span className="command-band-version-row-detail">{copy.detail}</span> : null}
      </button>
    );
  }
  return (
    <button type="button" role="menuitem" className={`command-band-version-row command-band-version-row--${preparing ? "live" : copy.tone}`} onClick={handleApply} disabled={copy.disabled || preparing} aria-busy={preparing || undefined} title={title} aria-label={t("chrome.system.version.consoleUpdate", { version, latest: latestVersion })} aria-live="polite">
      {body}
      <span className="command-band-version-row-chip">{label}</span>
    </button>
  );
}

/**
 * 이 창을 든 Fleet Desktop. 행은 두 몫으로 나뉜다 — 이름·버전 쪽은 무엇이 바뀌는지 보러 릴리스 페이지로
 * 나가고, 오른쪽 칩은 이 자리에서 갱신을 수행한다. 하나로 합치면 "무엇이 바뀌었나"를 보려던 손이
 * 설치를 시작하게 된다.
 */
function DesktopVersionRow({ version, update }: {
  readonly version: string;
  readonly update: DesktopShellUpdate;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const body = <><MonitorGlyph /><span className="command-band-version-row-name">Desktop</span><span className="command-band-version-row-version">v{version}</span></>;
  const releases = (
    <a
      className="command-band-version-row-main"
      href={GITHUB_LATEST_RELEASE_URL}
      target="_blank"
      rel="noopener noreferrer"
      role="menuitem"
      aria-label={t("chrome.system.version.desktop", { version })}
      title={t("chrome.system.version.desktopReleasesTitle")}
    >
      {body}
    </a>
  );

  if (update.stage === "idle") {
    return (
      <div className="command-band-version-row command-band-version-row--split">
        {releases}
        <VersionRefresh onRefresh={refreshDesktop} />
      </div>
    );
  }

  if (update.stage === "downloading") {
    return (
      <div className="command-band-version-row command-band-version-row--split command-band-version-row--live" aria-live="polite">
        {releases}
        <span className="command-band-version-row-chip" aria-label={t("chrome.system.version.desktopDownloading", { latest: update.version ?? "" })}>
          {t("chrome.system.desktopUpdate.downloading", { percent: update.percent ?? 0 })}
        </span>
      </div>
    );
  }

  // 내려받기는 재시도할 수 있는 실패다 — 칩을 잠그지 않고 같은 자리에서 다시 누르게 둔다.
  const failed = update.stage === "error";
  const ready = update.stage === "ready";
  const command = ready ? "restart" : "download";
  const label = failed
    ? t("common.retry")
    : ready
      ? t("chrome.system.desktopUpdate.restart")
      : t("chrome.system.desktopUpdate.download", { latest: update.version ?? "" });

  return (
    <div className={`command-band-version-row command-band-version-row--split command-band-version-row--${failed ? "error" : "info"}`}>
      {releases}
      <button
        type="button"
        role="menuitem"
        className="command-band-version-row-chip command-band-version-row-chip--action"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void requestDesktopShellUpdate(command).finally(() => setBusy(false));
        }}
        aria-label={t("chrome.system.version.desktopUpdate", { version, latest: update.version ?? "" })}
        title={ready ? t("chrome.system.desktopUpdate.restartTitle") : t("chrome.system.desktopUpdate.downloadTitle")}
        aria-live="polite"
      >
        {label}
      </button>
    </div>
  );
}

/** 지금 확인한다. 셸이 GitHub 릴리스를 다시 묻고, 그 답은 상태로 돌아온다. */
async function refreshDesktop(): Promise<boolean> {
  await requestDesktopShellUpdate("check");
  // 확인 결과는 스트림으로 온다 — 여기서 "새 버전 있음"을 단정하면 아직 오지 않은 답을 지어내는 것이다.
  return false;
}

/**
 * 정적 버전 행의 오른쪽 끝 — hover·포커스에서만 보이는 ↻. 누르면 그 제품의 최신 버전을 지금 확인한다.
 * 결과는 같은 자리에 3초만 선다: 새 버전이면 행 자체가 칩 행으로 바뀌므로 여기서는 「최신」과 「확인 실패」만 말한다.
 */
function VersionRefresh({ onRefresh }: { readonly onRefresh: () => Promise<boolean> }) {
  const t = useT();
  const { state, refresh: handleRefresh } = useVersionRefresh(onRefresh);

  if (state === "current" || state === "failed") {
    return <span className={`command-band-version-row-result command-band-version-row-result--${state}`} role="status">{t(state === "current" ? "chrome.system.version.upToDate" : "chrome.system.version.checkFailed")}</span>;
  }
  return (
    <button type="button" role="menuitem" className="command-band-version-row-refresh" data-state={state} onClick={handleRefresh} disabled={state === "busy"} aria-label={t(state === "busy" ? "chrome.system.version.checking" : "chrome.system.version.check")} title={t("chrome.system.version.check")}>
      <RefreshGlyph />
    </button>
  );
}

function GithubLinks() {
  const t = useT();
  const stars = useGithubStars();
  const hasCount = stars.count !== null;
  return (
    <div className="command-band-github" role="group" aria-label={t("chrome.system.github")}>
      <a className="command-band-github-link" href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" role="menuitem" aria-label={t("chrome.system.openGithub")} title={t("chrome.system.githubRepo")}>
        <GithubMarkIcon />
      </a>
      <a className="command-band-github-stars" href={GITHUB_STARGAZERS_URL} target="_blank" rel="noopener noreferrer" role="menuitem" aria-label={hasCount ? t("chrome.system.githubStars", { count: stars.count!.toLocaleString() }) : t("chrome.system.starOnGithub")} title={t("chrome.system.starOnGithub")}>
        <StarIcon />
        {hasCount ? <span className="command-band-github-stars-count">{formatStarCount(stars.count!)}</span> : null}
      </a>
    </div>
  );
}

function useGithubStars(): GithubStarsState {
  const [state, setState] = useState<GithubStarsState>(() => {
    const cached = readCachedStars();
    return cached === null ? { count: null, status: "idle" } : { count: cached, status: "ready" };
  });

  useEffect(() => {
    if (isStarCacheFresh()) return;
    let cancelled = false;
    setState((previous) => (previous.status === "ready" ? previous : { ...previous, status: "loading" }));
    fetch(GITHUB_STARS_API_URL, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`status ${response.status}`))))
      .then((data: { readonly stargazers_count?: unknown }) => {
        if (cancelled) return;
        const count = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
        if (count === null) {
          setState((previous) => ({ count: previous.count, status: previous.count === null ? "error" : "ready" }));
          return;
        }
        writeCachedStars(count);
        setState({ count, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setState((previous) => ({ count: previous.count, status: previous.count === null ? "error" : "ready" }));
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}

function readCachedStars(): number | null {
  try {
    const raw = window.localStorage.getItem(GITHUB_STARS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { readonly count?: unknown };
    return typeof parsed.count === "number" ? parsed.count : null;
  } catch {
    return null;
  }
}

function isStarCacheFresh(): boolean {
  try {
    const raw = window.localStorage.getItem(GITHUB_STARS_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { readonly at?: unknown };
    return typeof parsed.at === "number" && Date.now() - parsed.at < GITHUB_STARS_TTL_MS;
  } catch {
    return false;
  }
}

function writeCachedStars(count: number): void {
  try {
    window.localStorage.setItem(GITHUB_STARS_CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
  } catch {
    // Public GitHub metadata remains optional when browser storage is unavailable.
  }
}

function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

function HelpGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="11.6" r=".7" fill="currentColor" /></svg>;
}

function WhatsNewGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h12v8H2zM2 5l2-2.5h8L14 5M8 5v8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

// 콘솔 — 둥근 창 안의 프롬프트. "콘솔"이라는 이름을 그대로 그림으로 옮긴 보편 기호.
function TerminalGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 6l2.2 2-2.2 2M8.2 10h3.3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// 데스크톱 — 화면과 받침. 이 기계에 설치된 앱을 기기 실루엣으로 말한다.
function MonitorGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 11v2.5M5.5 13.5h5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

// 새로고침 — 열린 원호와 화살촉. 다른 메뉴 글리프와 같은 1.2px 선.
function RefreshGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.4h-2.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function KeyboardGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4 7h1m2 0h1m2 0h1M5 9.5h6" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

// 화면 안내 — 안내 카드가 화면의 한 지점을 짚는 모양.
function ScreenGuideGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="6" cy="7" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8.4 7h4M5 13.5h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function GithubMarkIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

function StarIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 9.41 6.26 13.71 6.35 10.28 8.94 11.53 13.05 8 10.6 4.47 13.05 5.72 8.94 2.29 6.35 6.59 6.26Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}
