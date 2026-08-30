import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { Translate } from "@fleet-console/sdk/i18n";

import { ApiError, applyConsoleUpdate } from "../api.js";
import { beginUpdateWatch, markUpdateDelegated } from "../update-progress-store.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { isDesktopShell, useDesktopHomeOrigin } from "../desktop-shell.js";
import { fetchLocalConsoles, probeRemoteHost, refreshRemoteHosts, useRemoteHosts, type LocalConsole, type RemoteHost, type RemoteHostReach } from "../remote-hosts.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import { openPane } from "../pane/pane-store.js";
import { openRailPanel, setRailChromeExpanded } from "../rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { COMMISSIONING_SEEN_KEY, openWhatsNew } from "../store.js";
import { AddHostDialog } from "./add-host-dialog.js";
import { EFFORT_CONFIRM_TIP_SEEN_KEY, forgetAllFeatureTours } from "./feature-tour.js";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog.js";
import { ENABLED_MENU_ITEM_SELECTOR, useMenuButtonKeyboard } from "./use-menu-button-keyboard.js";

type UpdateApplyState = "idle" | "applying" | "armed" | "blocked" | "error";

interface UpdateApplyCopy {
  readonly label: string;
  /** 행 안에서 라벨 뒤에 붙는 두 번째 줄. 버전 델타나 확인 문구가 여기 온다. */
  readonly detail?: string;
  readonly title: string;
  readonly tone: "info" | "warn" | "live" | "blocked" | "error";
  readonly disabled: boolean;
}

interface GithubStarsState {
  readonly count: number | null;
  readonly status: "idle" | "loading" | "ready" | "error";
}

const GITHUB_REPO_URL = "https://github.com/sbluemin/fleet-harness";
const GITHUB_STARGAZERS_URL = "https://github.com/sbluemin/fleet-harness/stargazers";
const GITHUB_STARS_API_URL = "https://api.github.com/repos/sbluemin/fleet-harness";
const GITHUB_STARS_CACHE_KEY = "fleet-console.github-stars";
const GITHUB_STARS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Desktop 셸과의 계약 리터럴 — 셸이 이 항해를 가로채므로 요청은 기계를 떠나지 않는다.
 * 같은 값이 fleet-desktop/src/remote-bridge.ts에도 선언되어 있다(Console 내부를 import하지
 * 않는다는 규칙 때문이며, DESKTOP_SHELL_PATH와 같은 방식이다). 한쪽만 고치면 목록이 열리지
 * 않고 창이 집으로 돌아가 버리므로, 양쪽을 함께 고친다.
 */
const PICKER_SURFACE_PARAM = "desktop-surface";
const PICKER_SURFACE_OPEN = "host-picker";
const PICKER_SURFACE_DISMISS = "host-picker-dismiss";
/** 목록을 펼칠 때 실려 가는 유일한 값: 지금 사용자가 서 있는 콘솔. 남의 기계는 실리지 않는다. */
const PICKER_AT_PARAM = "at";

export interface HostPickerContext {
  /** 이 목록을 부른 콘솔. 현재 줄을 표시하는 데만 쓴다. */
  readonly at: string | null;
}

/**
 * 이 화면이 "집의 목록만 펼치는 표면"으로 서빙됐는가.
 *
 * 부른 쪽이 실어 보낸 origin은 그대로 믿지 않는다 — 화면에 그릴 값이므로 모양을 먼저 본다.
 */
export function readHostPickerSurface(search: string): HostPickerContext | null {
  const params = new URLSearchParams(search);
  if (params.get(PICKER_SURFACE_PARAM) !== PICKER_SURFACE_OPEN) return null;
  const at = params.get(PICKER_AT_PARAM);
  return { at: at !== null && isConsoleOriginShape(at) ? at : null };
}

function isConsoleOriginShape(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

function pickerUrl(homeOrigin: string, surface: string, at?: string): string {
  const url = new URL("/console/", `${homeOrigin}/`);
  url.searchParams.set(PICKER_SURFACE_PARAM, surface);
  if (at !== undefined) url.searchParams.set(PICKER_AT_PARAM, at);
  return url.toString();
}

// 시스템 클러스터는 커맨드 밴드 우측에 상주한다 — 사이드바 접힘·라우트 전환과 무관하게
// 도움말(메뉴)이 항상 도달 가능해야 한다는 배치 계약의 소유자다. 설정 버튼은 여기 없다:
// 설정의 문은 레일의 톱니 하나이고, 페이지가 은퇴하며 history 진입 마커도 함께 은퇴했다.
export function CommandBandSystemCluster() {
  const state = useConsoleState();
  return (
    <div className="command-band-system-cluster">
      <HostSwitcher />
      <HelpMenu
        version={state.version}
        latestVersion={state.latestVersion}
        updateAvailable={state.updateAvailable}
        // 새로고침/언어 전환 실패는 이미 표시 중인 노트를 버리지 않는다. 남은 노트가 있으면
        // Help 진입도 열어 두어 inline 오류를 보고 다시 시도할 수 있어야 한다.
        releaseDisabled={state.releaseNotesLoading || state.releaseNotes.length === 0}
      />
    </div>
  );
}

/**
 * 호스트 스위처. 목록은 이 콘솔이 들고 있고, 고른 호스트의 `/console/`로 그냥 항해한다 —
 * 각 콘솔이 자기 UI를 서빙하므로 프록시가 없고, 그래서 목록 자체가 호스트마다 다를 수 있다.
 *
 * 그래서 "이 컴퓨터" 한 줄만은 콘솔이 아니라 셸에게서 온다. 원격 콘솔이 서빙한 화면은 자기가
 * 떠나온 곳을 알 수 없으므로, 그 줄이 없으면 돌아갈 길이 사라진다.
 *
 * 닿는지 여부는 열어 볼 때 확인한다. 목록에 든 것만으로 매번 남의 기계를 두드리면, 보지도
 * 않는 화면 때문에 조용한 네트워크 소음이 계속 흐른다.
 */
export function HostSwitcher({ picker }: { readonly picker?: HostPickerContext } = {}) {
  const t = useT();
  const state = useConsoleState();
  const hosts = useRemoteHosts();
  const shellHome = useDesktopHomeOrigin();
  const homeOrigin = shellHome.origin;
  // 원격으로 건너가는 일은 셸의 인증서 배관을 거쳐야 한다. 브라우저 단독에서는 내주지 않는다.
  const canOpenRemote = isDesktopShell();
  const navigate = useNavigate();
  /** 집이 펼친 목록으로 서빙된 화면. 칩은 없고, 판은 처음부터 열려 있다. */
  const inPicker = picker !== undefined;
  const [open, setOpen] = useState(inPicker);
  const [addOpen, setAddOpen] = useState(false);
  const [local, setLocal] = useState<readonly LocalConsole[]>([]);
  const [reach, setReach] = useState<Readonly<Record<string, RemoteHostReach>>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuItems = () => Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR) ?? []);
  /**
   * 목록을 접는 일. 집이 펼친 판은 이 화면의 상태가 아니라 셸이 얹은 덮개라, 접겠다는 말도
   * 셸에게 가야 한다 — 여기서 state만 내리면 빈 덮개가 콘솔을 가린 채 남는다.
   */
  const dismiss = () => {
    if (inPicker) location.assign(pickerUrl(location.origin, PICKER_SURFACE_DISMISS));
    else setOpen(false);
  };

  /**
   * 이 화면을 내주는 콘솔에게 목록을 물어도 되는가.
   *
   * 원격 콘솔에게는 묻지 않는다. 그 두 경로는 루프백 전용이라 어차피 401이지만, 답이 없다는
   * 것과 묻지 않는다는 것은 다르다 — 남의 기계에 내 목록을 묻는 요청 자체가 남지 않아야 한다.
   * 집이 펼친 목록(피커)은 집이 서빙하므로 이 판정이 참이고, 평소대로 묻는다.
   */
  const servedFromLoopback = isLoopbackOrigin(location.origin);

  useEffect(() => {
    if (!servedFromLoopback) return;
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal).catch(() => undefined);
    void fetchLocalConsoles(controller.signal).then(setLocal).catch(() => undefined);
    return () => controller.abort();
  }, [servedFromLoopback]);

  useEffect(() => {
    if (!open || !servedFromLoopback) return;
    const controller = new AbortController();
    // 열 때마다 다시 본다 — 이 기계의 콘솔은 조용히 뜨고 진다.
    void fetchLocalConsoles(controller.signal).then(setLocal).catch(() => undefined);
    for (const host of hosts) {
      void probeRemoteHost(host.id, controller.signal)
        .then((result) => setReach((previous) => ({ ...previous, [host.id]: result })))
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [open, hosts, servedFromLoopback]);

  // 판을 닫는 길은 목록을 어디서 읽어 왔는지와 무관하다 — 묻지 않는 콘솔에서도 판은 닫혀야 한다.
  // 열리면 현재 행(없으면 첫 행)으로 포커스를 옮기고, 같은 밴드의 Theater 메뉴와 같은 방향키
  // 문법을 쓴다. 현재 행은 선택 대상은 아니어도 위치 기준이므로 focus 목록에는 남는다.
  useEffect(() => {
    // Add Host는 자기 모달·키 문법을 소유한다. 덮개 picker는 그 뒤에서도 open이므로 여기서
    // 명시적으로 물러나지 않으면 입력의 Home/End와 모달의 Escape를 메뉴가 가로챈다.
    if (!open || addOpen) return;
    const panel = panelRef.current;
    if (panel === null) return;
    let initialFocusPending = true;
    let fallbackFocus: HTMLButtonElement | null = null;
    let focusedCurrent: HTMLButtonElement | null = null;
    const focusInitialItem = () => {
      const items = menuItems();
      const current = items.find((item) => item.getAttribute("aria-checked") === "true");
      // 목록 응답이 늦으면 임시 current 행이 실제 저장 행으로 교체된다. 사용자가 아직 움직이지
      // 않았다면 끊긴 기준점을 새 current로 이어 주되, 한 번 직접 이동한 포커스는 덮어쓰지 않는다.
      if (current && (initialFocusPending || (focusedCurrent !== null && !focusedCurrent.isConnected))) {
        initialFocusPending = false;
        fallbackFocus = null;
        focusedCurrent = current;
        current.focus();
        return;
      }
      if (!current && initialFocusPending && items[0] && !panel.contains(document.activeElement)) {
        fallbackFocus = items[0];
        fallbackFocus.focus();
      }
    };
    const frame = window.requestAnimationFrame(focusInitialItem);
    const observer = new MutationObserver(focusInitialItem);
    observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "disabled"] });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.contains(target)) {
        initialFocusPending = false;
        fallbackFocus = null;
        focusedCurrent = null;
        return;
      }
      if (!triggerRef.current?.contains(target)) dismiss();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (target === fallbackFocus || target === focusedCurrent) return;
      initialFocusPending = false;
      fallbackFocus = null;
      focusedCurrent = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      if (!panel.contains(document.activeElement) && !panel.contains(event.target as Node)) return;
      const items = menuItems();
      if (items.length === 0) return;
      event.preventDefault();
      initialFocusPending = false;
      fallbackFocus = null;
      focusedCurrent = null;
      const current = items.findIndex((item) => item === document.activeElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : current <= 0 ? items.length - 1 : current - 1;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen, open]);

  /**
   * 어느 콘솔에 서 있는가. 집이 펼친 목록에서는 이 화면(집)이 아니라 목록을 부른 콘솔이
   * 그 답이다 — 아니면 사용자가 지금 보고 있는 콘솔에 현재 표시가 서지 않는다.
   */
  const currentOrigin = (inPicker ? picker.at : null) ?? location.origin;
  const currentIsLoopback = isLoopbackOrigin(currentOrigin);
  /**
   * 집을 떠나 있는가. 셸이 말한 집과 지금 서 있는 콘솔이 다르면 그렇다.
   *
   * 주소 모양은 이 질문에 답하지 못한다. WSL 안의 콘솔은 `127.0.0.1`로 열리지만 그 콘솔이
   * 도는 곳은 이 기계의 콘솔을 원리적으로 찾지 못하는 다른 기계다 — 루프백이라는 사실은
   * 같은 기계라는 뜻이 아니다. 셸은 창을 옮길 때마다 집 주소를 게시하므로, 그 값과의 비교
   * 하나가 원격·WSL·이웃 콘솔을 한 규칙으로 가른다.
   */
  const awayFromHome = homeOrigin !== null && currentOrigin !== homeOrigin;
  /**
   * "이 컴퓨터"에 실릴 수 있는 것은 이 창이 실제로 닿을 수 있는 콘솔뿐이다.
   *
   * 스캔은 루프백 리스너에서만 답하므로, 원격 콘솔을 보고 있으면 비어 있다. 그때 돌아갈 곳을
   * 아는 것은 셸뿐이라 셸의 말을 그대로 쓴다. 반대로 스캔이 답했는데 셸이 말한 집이 거기 없으면
   * 그 콘솔은 이미 죽은 것이므로 줄을 세우지 않는다.
   *
   * 단 이 화면을 서빙한 곳이 곧 집이라면 그 추정을 쓰지 않는다 — 화면 자체가 생존 증거이기
   * 때문이다. 스캔은 정규 슬롯 두 곳만 보므로 데이터 루트를 재지정한 콘솔(격리 실행 등)은
   * 설계상 자기 목록에도 잡히지 않는다. 그 추정을 그대로 두면 집이 살아 있는데도 집 줄이
   * 사라지고, 원격에서 펼친 목록에는 돌아갈 길이 아예 남지 않는다.
   *
   * 이 추정이 서는 곳은 이 콘솔이 직접 그리는 판뿐이다. 셸이 창을 들고 있으면 목록은 집이
   * 그리므로(아래 `pickerHome`), 이 스캔이 무엇을 못 봤는지는 그 동선을 가로막지 못한다.
   */
  const homeIsLive = homeOrigin !== null
    && (homeOrigin === location.origin || local.length === 0 || local.some((entry) => entry.origin === homeOrigin));
  const home = homeIsLive ? homeOrigin : null;
  const placeholder = (origin: string): LocalConsole => ({ origin, version: "", owner: null, distro: null });
  const nearby: readonly { readonly entry: LocalConsole; readonly home: boolean }[] = [
    ...(home !== null ? [{ entry: local.find((item) => item.origin === home) ?? placeholder(home), home: true }] : []),
    // 지금 서 있는 루프백 콘솔은 스캔에 안 잡혀도(격리 실행 등) 목록에 있어야 한다 — 눈앞에 있으니까.
    ...(currentIsLoopback && currentOrigin !== home && !local.some((entry) => entry.origin === currentOrigin)
      ? [{ entry: placeholder(currentOrigin), home: false }]
      : []),
    ...local.filter((entry) => entry.origin !== home).map((entry) => ({ entry, home: false })),
  ];
  const savedCurrent = hosts.find((host) => host.origin === currentOrigin) ?? null;
  const nearbyCurrent = nearby.some(({ entry }) => entry.origin === currentOrigin);
  /**
   * 지금 서 있는 콘솔의 이름은 한 번만 정한다 — 칩과 목록이 서로 다른 규칙으로 지으면
   * 같은 콘솔이 두 이름으로 보인다. 사용자가 고쳐 부른 이름이 있으면 그것이 우선이다.
   *
   * 집이 펼친 목록에서는 이 화면의 이름도 주소도 빌려 오지 않는다. 거기서 도는 콘솔은 집이라,
   * 그 이름을 손님 줄에 붙이면 집과 손님이 같은 이름으로 읽힌다. 사용자가 지어 준 이름이 없으면
   * 비워 두고 각 줄이 자기 폴백을 쓰게 한다 — 주소는 이미 그 줄의 상세가 말한다.
   */
  const currentLabel = savedCurrent?.label || (inPicker ? "" : state.consoleName || currentHost(currentOrigin));
  /**
   * 집에 서 있을 때만 "여기"라고 말한다. 집을 떠나 있으면 어느 콘솔인지가 답이다 — 칩을
   * 누르면 집의 목록이 펼쳐지므로, 칩까지 "여기"라고 하면 어디에 서 있었는지가 사라진다.
   *
   * 셸이 창을 들고 있는데 아직 집 주소를 못 받았다면 아무 말도 하지 않는다. 그 순간 "여기"라고
   * 하면 손님 콘솔이 집 행세를 하게 되고, 사용자는 그 말을 믿고 누른다. 셸이 아예 없을 때만
   * 스캔에 든 사실로 대신한다 — 그때는 답이 늦는 것이 아니라 답할 셸이 없는 것이다.
   */
  const standingAtHome = canOpenRemote && shellHome.pending
    ? false
    : homeOrigin === null ? nearbyCurrent : currentOrigin === homeOrigin;
  const chipLabel = state.controlHolder !== null
    ? t("chrome.control.shared")
    : standingAtHome
      ? t("chrome.hosts.local")
      : currentLabel;

  /**
   * 집을 떠나 있을 때 칩을 누르면 이 콘솔의 목록을 펴는 대신 집에게 목록을 펴 달라고 한다.
   * 셸이 그 항해를 가로채 집의 화면을 이 위에 얹으므로, 이 콘솔은 남의 기계 주소를 받지 않는다.
   *
   * 목적지는 `home`이 아니라 셸이 말한 값 그대로다. `home`은 이 콘솔의 스캔이 확인해 준 집이고,
   * WSL처럼 스캔이 닿지 못하는 곳에서는 비어 있다 — 그 침묵이 돌아가는 길까지 지워서는 안 된다.
   */
  const pickerHome = !inPicker && canOpenRemote && awayFromHome ? homeOrigin : null;

  /**
   * 집 주소는 늦게 도착할 수 있고, 그 전에 누른 칩은 이 콘솔의 판을 편다. 주소가 도착해 이
   * 콘솔이 목록의 주인이 아니게 되면 그 판은 남의 목록이다 — 걷고, 사용자가 누른 뜻대로 집에게
   * 목록을 청한다. 걷기만 하면 그 누름은 아무 일도 일어나지 않은 채 사라진다.
   *
   * 이 자리에 닿는 길은 그 어긋남 하나뿐이다. 주소를 알고 있었다면 칩이 처음부터 여기로 보냈고,
   * 집이 펼친 목록에서는 `pickerHome`이 서지 않는다.
   */
  useEffect(() => {
    if (pickerHome === null || !open) return;
    setOpen(false);
    location.assign(pickerUrl(pickerHome, PICKER_SURFACE_OPEN, currentOrigin));
  }, [pickerHome, open, currentOrigin]);

  // 집을 떠나 있으면 목록이 비어 보여도 칩은 남는다 — 그 칩이 돌아가는 유일한 문이다.
  if (!inPicker && pickerHome === null && nearby.length === 0 && hosts.length === 0) return null;
  const openSettings = () => {
    // 관리는 집의 설정 표면에서 한다. 덮개는 목록만 들고 있으므로 창째로 집에 보낸다 —
    // 옛 주소는 라우트 어댑터가 받아 같은 표면으로 번역한다.
    if (inPicker) {
      location.assign(new URL("/console/settings?section=remote-access", `${location.origin}/`).toString());
      return;
    }
    setOpen(false);
    // 레일은 /operations에만 마운트된다 — 표면을 부르기 전에 캔버스로 돌아간다.
    navigate("/operations");
    openRailPanel(SETTINGS_RAIL_ENTRY_ID);
    openPane({ paneId: SETTINGS_PANE_ID, params: { section: "connectivity" } });
    setRailChromeExpanded(true);
  };
  const openAdd = () => {
    // 덮개에서는 판을 접지 않는다 — 접으면 팝업이 닫힌 뒤 빈 덮개만 남는다.
    if (!inPicker) setOpen(false);
    setAddOpen(true);
  };
  const go = (origin: string) => {
    setOpen(false);
    if (origin !== currentOrigin) location.assign(new URL("/console/", `${origin}/`).toString());
  };

  return (
    <div className={`host-switcher${inPicker ? " is-picker-surface" : ""}`}>
      {inPicker ? null : (
        <button
          ref={triggerRef}
          type="button"
          className={`host-switcher-chip${state.controlHolder !== null ? " is-shared" : ""}`}
          aria-haspopup="menu"
          aria-expanded={pickerHome === null && open}
          data-open={pickerHome === null && open ? "true" : undefined}
          aria-label={`${t("chrome.hosts.aria")}: ${chipLabel}`}
          title={chipLabel}
          onClick={() => {
            if (pickerHome !== null) { location.assign(pickerUrl(pickerHome, PICKER_SURFACE_OPEN, currentOrigin)); return; }
            setOpen((previous) => !previous);
          }}
        >
          <span className={`host-switcher-dot ${state.controlHolder !== null ? "is-shared" : "is-live"}`} aria-hidden="true" />
          <span className="host-switcher-name">{chipLabel}</span>
          <ChevronGlyph />
        </button>
      )}
      {open ? (
        <div ref={panelRef} className="host-switcher-panel" role="menu" aria-label={t("chrome.hosts.aria")}>
          {nearby.length > 0 ? (
            <>
              <p className="host-switcher-heading">{t("chrome.hosts.nearby")}</p>
              {nearby.map(({ entry, home }) => (
                <HostRow
                  key={entry.origin}
                  live
                  name={nearbyName(home, entry.origin === currentOrigin, currentLabel, t)}
                  detail={nearbyDetail(entry, home)}
                  badge={home || entry.origin === currentOrigin ? undefined : t("chrome.hosts.discovered")}
                  current={entry.origin === currentOrigin}
                  compact={home}
                  onOpen={() => go(entry.origin)}
                />
              ))}
            </>
          ) : null}
          {hosts.length > 0 ? (
            <>
              {nearby.length > 0 ? <div className="host-switcher-divider" role="separator" /> : null}
              {/* 실험 표시는 저장된 호스트에만 붙인다 — 위의 "이 컴퓨터" 목록은 원격 접속을 켜지
                  않아도 늘 있는 로컬 콘솔이라 실험 기능이 아니다. */}
              <p className="host-switcher-heading">
                {t("chrome.hosts.saved")}
                <span className="experimental-badge">{t("common.experimental")}</span>
              </p>
              {hosts.map((host) => (
                <HostRow
                  key={host.id}
                  live={Boolean(reach[host.id]?.trusted)}
                  name={host.label}
                  detail={canOpenRemote ? hostDetail(host, reach[host.id], t) : `${host.hostname}:${host.port} · ${t("chrome.hosts.desktopOnly")}`}
                  current={host.origin === currentOrigin}
                  disabled={!canOpenRemote || reach[host.id]?.reachable === false}
                  onOpen={() => go(host.origin)}
                />
              ))}
            </>
          ) : null}
          {/* 목록 어디에도 없는 콘솔에 서 있다면 그 사실을 숨기지 않는다. */}
          {!nearbyCurrent && savedCurrent === null ? (
            <>
              <div className="host-switcher-divider" role="separator" />
              <HostRow live name={currentLabel || t("chrome.hosts.console")} detail={`${currentHost(currentOrigin)} · ${t("chrome.hosts.notSaved")}`} current />
            </>
          ) : null}
          <div className="host-switcher-divider" role="separator" />
          {/* 콘솔을 더하는 일은 목록을 고르는 자리에서 시작된다 — 링크 한 줄 때문에 설정으로
              건너가지 않도록 여기서 팝업을 연다. 관리(설정)는 그 아래에 남는다. */}
          <button type="button" role="menuitem" className="host-switcher-link" onClick={openAdd}>
            {t("chrome.hosts.add")}
          </button>
          <button type="button" role="menuitem" className="host-switcher-link" onClick={openSettings}>
            {t("chrome.hosts.manage")}
          </button>
        </div>
      ) : null}
      {addOpen ? <AddHostDialog openerRef={triggerRef} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function HostRow({
  live,
  name,
  detail,
  badge,
  current,
  disabled,
  compact,
  onOpen,
}: {
  readonly live: boolean;
  readonly name: string;
  readonly detail: string;
  readonly badge?: string;
  readonly current: boolean;
  readonly disabled?: boolean;
  /** 이 앱이 띄운 콘솔은 한 줄로 접어 강조한다 — 목록에서 유일하게 언제나 거기 있는 기준점이다. */
  readonly compact?: boolean;
  readonly onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      className={`${current ? "is-current" : ""} ${compact ? "is-home" : ""}`.trim()}
      disabled={!current && (disabled === true || onOpen === undefined)}
      aria-disabled={current || disabled === true || onOpen === undefined}
      onClick={current || disabled === true ? undefined : onOpen}
    >
      <span className={`host-switcher-dot ${live ? "is-live" : ""}`} aria-hidden="true" />
      <span className="host-switcher-entry">
        <span className="host-switcher-name">{name}</span>
        <small>{detail}</small>
      </span>
      {badge ? <span className="host-switcher-badge">{badge}</span> : null}
      {current ? <CheckGlyph /> : null}
    </button>
  );
}

/**
 * 이름은 "누가 이 콘솔을 들고 있는가"로 가른다. 락에 적힌 owner는 어느 앱이 락을 썼는지일 뿐이라,
 * 이 앱이 띄운 콘솔과 우연히 같은 기계에 떠 있는 콘솔이 둘 다 desktop으로 나온다 — 그것으로
 * 이름을 지으면 두 줄이 똑같이 읽힌다.
 */
/** 루프백 콘솔만 이 창이 주소 그대로 열 수 있다 — 다른 기계의 127.0.0.1은 여기서 우리 기계다. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * 지금 서 있는 콘솔의 주소. 집이 펼친 목록에서는 이 화면을 서빙한 곳(집)이 아니라 목록을
 * 부른 콘솔이 그 답이므로, `location.host`를 그대로 쓰면 손님 줄에 집 주소가 선다.
 */
function currentHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** 같은 루프백 주소라도 어디에 사는지가 다르다 — WSL 안의 콘솔은 그 배포판 이름을 달고 선다. */
function nearbyDetail(entry: LocalConsole, home: boolean): string {
  const parts = [new URL(entry.origin).host];
  if (entry.distro) parts.push(entry.distro);
  if (entry.version && !home) parts.push(`v${entry.version}`);
  return parts.join(" · ");
}

function nearbyName(home: boolean, current: boolean, currentName: string, t: ReturnType<typeof useT>): string {
  if (home) return t("chrome.hosts.managedConsole");
  // 지금 쓰고 있는 콘솔은 "발견"된 것이 아니다 — 자기 이름으로 부른다.
  if (current && currentName) return currentName;
  return t("chrome.hosts.console");
}


function hostDetail(host: RemoteHost, state: RemoteHostReach | undefined, t: ReturnType<typeof useT>): string {
  const address = `${host.hostname}:${host.port}`;
  if (state === undefined) return address;
  if (!state.reachable) {
    return host.lastOpenedAt === null
      ? `${address} · ${t("chrome.hosts.unreachable")}`
      : `${address} · ${t("chrome.hosts.unreachable")} · ${t("chrome.hosts.seen")} ${formatSeen(host.lastOpenedAt)}`;
  }
  return state.trusted ? address : `${address} · ${t("chrome.hosts.untrusted")}`;
}

function formatSeen(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function ChevronGlyph() {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CheckGlyph() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.3 4.8 8.6 9.5 3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// "화면 안내 다시 보기" — 화면에 닻을 건 투어 하나가 아니라 온보딩 전체를 초기화한다.
// 카탈로그의 모든 피처 투어 시청 기록(walkthrough·spotlight)·최초 설정 가이드·강도 확인 팁
// 기록을 함께 지워, 어느 화면에 있든 온보딩을 처음부터 다시 보게 한다.
function forgetAllOnboarding(seen: readonly string[]): readonly string[] {
  const drop = new Set([COMMISSIONING_SEEN_KEY, EFFORT_CONFIRM_TIP_SEEN_KEY]);
  const afterTours = forgetAllFeatureTours(seen);
  const next = afterTours.filter((key) => !drop.has(key));
  return next.length === afterTours.length ? afterTours : next;
}

function HelpMenu({ releaseDisabled, updateAvailable, latestVersion, version }: {
  readonly releaseDisabled: boolean;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly version: string;
}) {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const globalSettings = useGlobalSettingsStore();
  const seenFeatureTours = globalSettings.state?.seenFeatureTours ?? [];
  // "화면 안내 다시 보기"는 화면에 닻을 건 투어 하나가 아니라 온보딩 전체를 초기화한다 —
  // 카탈로그의 모든 피처 투어 시청 기록과 최초 설정 가이드 기록을 함께 지워, 어느 화면에
  // 있든 온보딩을 처음부터 다시 보게 한다.
  const replayDisabled = forgetAllOnboarding(seenFeatureTours) === seenFeatureTours;

  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, open, setOpen);

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
    <button ref={triggerRef} type="button" className="command-band-button command-band-help" onClick={() => setOpen((previous) => !previous)} aria-haspopup="menu" aria-expanded={open} aria-label={updateAvailable ? t("chrome.system.helpUpdateReady") : t("chrome.system.help")} title={updateAvailable ? t("chrome.system.helpUpdateReady") : t("chrome.system.help")}>
      <HelpGlyph />
      {updateAvailable ? <span className="command-band-update-dot" aria-hidden="true" /> : null}
    </button>
    {open ? <div ref={menuRef} className="command-band-system-menu" role="menu" aria-label={t("chrome.system.help")}>
      <button type="button" role="menuitem" disabled={releaseDisabled} onClick={() => { setOpen(false); openWhatsNew(); }}><WhatsNewGlyph /><span>{t("chrome.system.whatsNew")}</span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); setShortcutsOpen(true); }}><KeyboardGlyph /><span>{t("chrome.system.keyboardShortcuts")}</span></button>
      <button type="button" role="menuitem" disabled={replayDisabled} onClick={replayScreenGuide} title={t(replayDisabled ? "chrome.system.replayScreenGuideNone" : "chrome.system.replayScreenGuideTitle")}><ScreenGuideGlyph /><span>{t("chrome.system.replayScreenGuide")}</span></button>
      {updateAvailable ? <UpdateApplyControl latestVersion={latestVersion} version={version} onStarted={() => setOpen(false)} /> : null}
      <div className="command-band-system-menu-divider" role="separator" />
      <GithubLinks version={version} />
    </div> : null}
    {shortcutsOpen ? <KeyboardShortcutsDialog onClose={() => { setShortcutsOpen(false); triggerRef.current?.focus(); }} /> : null}
  </span>;
}

function UpdateApplyControl({ latestVersion, version, onStarted }: {
  readonly latestVersion: string | null;
  readonly version: string;
  readonly onStarted: () => void;
}) {
  const t = useT();
  const [applyState, setApplyState] = useState<UpdateApplyState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const copy = resolveUpdateApplyCopy(applyState, errorCode, latestVersion, t);

  const handleApply = async () => {
    if (copy.disabled) return;
    // 두 번째 누름이 곧 동의다. 첫 누름에서 서버가 확인을 요구했고, 그 문장은 이 버튼이
    // 이미 화면에 띄워 두었다 — 별도 대화 상자를 세우지 않는 것은 커맨드 밴드의 다른
    // 두-번-누름 컨트롤과 같은 문법이다.
    const acknowledgeHostRestart = applyState === "armed";
    setApplyState("applying");
    setErrorCode(null);
    try {
      const result = await applyConsoleUpdate(acknowledgeHostRestart ? { acknowledgeHostRestart: true } : {});
      // 여기서 "완료"라고 말하지 않는다. 202는 시작됐다는 뜻일 뿐이고, 결과를 아는 것은
      // 재기동을 겪고 돌아온 콘솔이다. 그때까지의 화면은 커튼이 소유한다.
      if (result.status === "delegated") markUpdateDelegated(latestVersion);
      else beginUpdateWatch(latestVersion);
      onStarted();
    } catch (error) {
      const code = error instanceof ApiError ? error.message : "network_error";
      setErrorCode(code);
      if (code === "host_restart_confirmation_required") {
        setApplyState("armed");
        return;
      }
      setApplyState(isBlockedUpdateApplyError(code) ? "blocked" : "error");
    }
  };

  return (
    <button
      type="button"
      role="menuitem"
      className={`command-band-update command-band-update--${copy.tone}`}
      onClick={handleApply}
      disabled={copy.disabled}
      title={copy.title}
      aria-live="polite"
    >
      <span>{copy.label}</span>
      {copy.detail ? <span className="command-band-update-detail">{copy.detail}</span> : null}
    </button>
  );

  function resolveUpdateApplyCopy(
    state: UpdateApplyState,
    code: string | null,
    latest: string | null,
    translate: Translate<CoreMessageKey>,
  ): UpdateApplyCopy {
    const base = resolveUpdateApplyCopyFor(state, code, latest, translate);
    if (base.detail !== undefined || state !== "idle" || latest === null) return base;
    // 최신 버전이 툴팁 안에만 있으면 호버해야 읽힌다. 행 자체가 말하게 한다.
    return { ...base, detail: translate("chrome.system.update.versionDelta", { from: version, to: latest }) };
  }
}

function GithubLinks({ version }: { readonly version: string }) {
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
      <span className="command-band-github-version">v{version}</span>
    </div>
  );
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
  if (applyState === "applying") return { label: t("chrome.system.update.requesting"), title: t("chrome.system.update.requestingTitle"), tone: "live", disabled: true };
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
  if (applyState === "error") return { label: t("common.retry"), title: t("chrome.system.update.retryTitle"), tone: "error", disabled: false };
  // 대기 중 업데이트 안내는 정보다(중립 잉크). 신호 채널은 확인 대기(warn)·진행(live)·실패(error)만 쓴다.
  return { label: t("chrome.system.update.update"), title: latest, tone: "info", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null, t: Translate<CoreMessageKey>): UpdateApplyCopy {
  if (errorCode === "local_channel") return { label: t("chrome.system.update.local"), title: t("chrome.system.update.localTitle"), tone: "blocked", disabled: true };
  // 이 콘솔이 스스로 갈아 끼울 수 없는 레이아웃은 이제 셸에게 넘어간다. 이 문구는 그
  // 위임을 모르는 옛 서버에 붙었을 때만 남는 마지막 안내다.
  if (errorCode === "managed_runtime_update_requires_relaunch") return { label: t("chrome.system.update.updateAndRestart"), title: t("chrome.system.update.managedTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_already_in_progress") return { label: t("chrome.system.update.busy"), title: t("chrome.system.update.busyTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_not_available") return { label: t("chrome.system.update.current"), title: t("chrome.system.update.currentTitle"), tone: "blocked", disabled: true };
  return { label: t("chrome.system.update.blocked"), title: t("chrome.system.update.blockedTitle"), tone: "error", disabled: false };
}

function isBlockedUpdateApplyError(code: string): boolean {
  return code === "local_channel" || code === "managed_runtime_update_requires_relaunch" || code === "update_already_in_progress" || code === "update_not_available";
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
