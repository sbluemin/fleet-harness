import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { NO_LATCHED_MODIFIERS, TerminalKeyBar, type TerminalKeyBarModifiers } from "./terminal-key-bar.js";
import { applyTerminalModifiers, terminalKeySequence, type TerminalKeyId } from "./terminal-key-sequences.js";
import { createImeShiftEnterHandler } from "./ime-shift-enter.js";
import { createTerminalConnection, type TerminalConnection, type TerminalConnectionStatus } from "./terminal-connection.js";
import { describeTerminalFailure } from "./terminal-failure.js";
import { createTerminalCopyOnSelect } from "./terminal-copy-on-select.js";
import { createTerminalOsc52Clipboard } from "./terminal-osc52-clipboard.js";
import { TERMINAL_OPTIONS } from "./terminal-options.js";
import { dispatchSyntheticTerminalWheel } from "./terminal-synthetic-wheel.js";
import { createTerminalTouchGestures, MIN_FONT_SCALE } from "./terminal-touch-gestures.js";
import { createXtermGestureOriginGuard } from "./terminal-xterm-gesture-origin.js";
import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT } from "../i18n/index.js";
import { terminalInactiveFlushMs, useTerminalPrefs } from "./terminal-preferences.js";
import { createTerminalScrollFollow, type TerminalScrollFollowController } from "./terminal-scroll-follow.js";
import { createTerminalStatusDetailReporter, type TerminalStatusDetailReporter } from "./status-detail.js";
import { createWindowsSelectionCopyHandler } from "./windows-selection-copy.js";
import { waitForSymbolsNerdFontMono } from "./symbols-font.js";
import "./terminal-key-bar.css";

type TerminalThemeId = "instrument" | "maritime" | "carbon" | "whites";

export interface TerminalSurfaceProps {
  /** 이 표면의 클라이언트 식별자 — 재마운트 경계이자 상태 보고 키다. */
  readonly operationId: string;
  /** 티켓 요청 본문. 생략하면 `{ operationId }`. Theater 셸은 `{ theaterId }`를 싣는다. */
  readonly ticketBody?: Readonly<Record<string, string>>;
  readonly ticketPath: string;
  readonly wsPath: string;
  readonly theme?: TerminalThemeId;
  readonly onExit?: () => void;
  // 이 터미널이 활성(선택)으로 전환될 때 마우스 클릭 없이 키보드 포커스를 잡아준다(Map 검색 이동 등).
  readonly active?: boolean;
  readonly keyboardFocusRequestId?: number;
  // 맵 캔버스의 줌 배율(viewport.zoom). 캔버스 외 셸 패널 사용처는 기본 1.
  // 캔버스가 부모에 transform:scale(zoom)을 걸면 xterm의 마우스 셀 좌표 계산이 scale을 보정하지 못해
  // zoom≠1에서 커서/선택 위치가 어긋난다(분자=scale 반영 화면거리, 분모=scale 미반영 cellWidth). 이를
  // 터미널 마운트 단의 역스케일(scale(1/zoom)) + fontSize×zoom으로 net scale=1을 만들어 좌표를 정정한다.
  readonly zoom?: number;
  readonly onStatusDetail?: (detail: string) => void;
  /** 관전 배지 문구용. 넘기지 않으면 영어로 떨어진다 — 배지 외의 동작에는 영향이 없다. */
  readonly locale?: ConsoleLocale;
}

interface TerminalOutputScheduler {
  readonly write: (data: Uint8Array) => void;
  readonly drain: (callback: () => void) => void;
  readonly setActive: (active: boolean) => void;
  readonly setInactiveFlushMs: (inactiveFlushMs: number) => void;
  readonly dispose: () => void;
}

const RESIZE_DEBOUNCE_MS = 80;
const ACTIVE_OUTPUT_FLUSH_MS = 16;
const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;
// 줌 보간(rAF tween)이 멈춘 뒤 보정을 1회만 적용하기 위한 디바운스. zoom prop은 보간 중 매 프레임 바뀌므로,
// 마지막 변경 후 이 시간이 지나야(=settle) counter-scale/fontSize/fit을 적용한다. 보간 중에는 부모 transform에
// 맡겨 글자가 부드럽게 확대/축소되고, atlas 재생성을 제스처당 1회로 묶어 WebGL 비용을 억제한다.
const ZOOM_SETTLE_MS = 120;

const INSTRUMENT_TERMINAL_THEME: ITheme = {
  background: "oklch(16.5% 0.016 245)",
  foreground: "oklch(94% 0.008 90)",
  cursor: "oklch(77% 0.085 200)",
  selectionBackground: "oklch(80% 0.085 78 / 13%)",
  black: "oklch(13% 0.014 245)",
  brightBlack: "oklch(29% 0.018 245)",
  red: "oklch(68% 0.13 25)",
  green: "oklch(76% 0.11 160)",
  yellow: "oklch(75% 0.08 90)",
  blue: "oklch(77% 0.085 200)",
  magenta: "oklch(70% 0.012 245)",
  cyan: "oklch(77% 0.085 200)",
  white: "oklch(94% 0.008 90)",
  brightRed: "oklch(68% 0.13 25)",
  brightGreen: "oklch(76% 0.11 160)",
  brightYellow: "oklch(80% 0.085 78)",
  brightBlue: "oklch(77% 0.085 200)",
  brightMagenta: "oklch(70% 0.012 245)",
  brightCyan: "oklch(77% 0.085 200)",
  brightWhite: "oklch(94% 0.008 90)",
};

const MARITIME_TERMINAL_THEME: ITheme = {
  background: "oklch(23% 0.03 248)",
  foreground: "oklch(86% 0.018 90)",
  cursor: "oklch(82% 0.13 195)",
  selectionBackground: "oklch(78% 0.13 75 / 28%)",
  black: "oklch(18% 0.045 248)",
  brightBlack: "oklch(48% 0.03 248)",
  red: "oklch(72% 0.17 25)",
  green: "oklch(82% 0.13 195)",
  yellow: "oklch(86% 0.16 78)",
  blue: "oklch(70% 0.08 248)",
  magenta: "oklch(75% 0.11 320)",
  cyan: "oklch(82% 0.13 195)",
  white: "oklch(82% 0.018 90)",
  brightRed: "oklch(78% 0.18 25)",
  brightGreen: "oklch(88% 0.14 195)",
  brightYellow: "oklch(90% 0.16 78)",
  brightBlue: "oklch(78% 0.09 248)",
  brightMagenta: "oklch(82% 0.12 320)",
  brightCyan: "oklch(88% 0.14 195)",
  brightWhite: "oklch(96% 0.012 88)",
};

const CARBON_TERMINAL_THEME: ITheme = {
  background: "oklch(19% 0.008 252)",
  foreground: "oklch(85% 0.005 250)",
  cursor: "oklch(80% 0.105 205)",
  selectionBackground: "oklch(76% 0.115 62 / 28%)",
  black: "oklch(16% 0.008 252)",
  brightBlack: "oklch(46% 0.006 250)",
  red: "oklch(72% 0.17 25)",
  green: "oklch(80% 0.11 205)",
  yellow: "oklch(84% 0.14 64)",
  blue: "oklch(68% 0.05 250)",
  magenta: "oklch(75% 0.11 320)",
  cyan: "oklch(80% 0.11 205)",
  white: "oklch(81% 0.005 250)",
  brightRed: "oklch(78% 0.18 25)",
  brightGreen: "oklch(86% 0.13 205)",
  brightYellow: "oklch(88% 0.15 66)",
  brightBlue: "oklch(74% 0.06 250)",
  brightMagenta: "oklch(82% 0.12 320)",
  brightCyan: "oklch(86% 0.13 205)",
  brightWhite: "oklch(95% 0.003 250)",
};

// 라이트 터미널의 bright 계열은 밝히지 않고 더 진하게(L −5%p, C +0.02) 간다 — 밝은 배경에서 '밝은' ANSI는 판독 불능이기 때문.
// 단 brightWhite는 예외로 배경보다 밝게 유지한다(SGR 107 블록이 종이보다 희어야 극성이 산다).
// 라이트 배경은 화면 최명면이어야 한다: 테마의 --canvas-abyss(L 97.8%)보다 밝게 고정 —
// 작업면이 크롬보다 어두워지면 시선이 크롬으로 끌리는 극성 역전이 재발한다(다크는 반대 방향으로 동일 원칙).
// 동시에 chroma는 테마 대기(캔버스~밴드 패밀리)를 따른다 — 최명면 + 최저채도가 겹치면
// 터미널이 테마 밖 백지로 읽힌다(실사용 피드백으로 확인된 과중화 회귀).
// 종이·잉크·흑백 rung은 whites의 오트밀 대기(hue 95~100)를 따르고, 유채 ANSI 6색은 CLI 콘텐츠의
// 의미색이므로 대기 이동과 무관하게 유지한다(cursor=aurora·selection=brass 채널 역할도 불변).
const WHITES_TERMINAL_THEME: ITheme = {
  background: "oklch(98.2% 0.004 100)",
  foreground: "oklch(24% 0.012 95)",
  cursor: "oklch(50% 0.1 210)",
  selectionBackground: "oklch(56% 0.125 82 / 20%)",
  black: "oklch(25% 0.014 95)",
  brightBlack: "oklch(46% 0.012 95)",
  red: "oklch(52% 0.16 25)",
  green: "oklch(50% 0.12 160)",
  yellow: "oklch(55% 0.11 82)",
  blue: "oklch(50% 0.1 250)",
  magenta: "oklch(51% 0.1 318)",
  cyan: "oklch(50% 0.1 210)",
  white: "oklch(89% 0.008 98)",
  brightRed: "oklch(47% 0.18 25)",
  brightGreen: "oklch(45% 0.14 160)",
  brightYellow: "oklch(49% 0.13 80)",
  brightBlue: "oklch(45% 0.11 250)",
  brightMagenta: "oklch(46% 0.12 318)",
  brightCyan: "oklch(45% 0.11 210)",
  brightWhite: "oklch(99.3% 0.003 100)",
};

/* 라이트 터미널은 agent CLI가 직접 찍는 다크용 truecolor(회색 #999/#ccc, 연한 액센트)가 팔레트
   재매핑 밖에서 1.3~2.5:1로 붕괴한다. xterm minimumContrastRatio(4.5)는 WebGL·DOM 렌더러 모두에서
   truecolor를 포함한 전경색을 hue를 보존하며 바닥 대비까지 어둡게 보정하고 box-drawing 글리프는
   제외한다. 한계: dim(SGR 2) 셀은 dim 적용 "전" 색으로 floor/2를 판정한 뒤 알파 0.5를 곱하므로
   색상 dim은 보정을 받지 못한다 — dim 개선은 별도 트랙. 다크 테마는 1(off) 유지. */
const LIGHT_TERMINAL_THEMES: ReadonlySet<TerminalThemeId> = new Set(["whites"]);
const LIGHT_MINIMUM_CONTRAST_RATIO = 4.5;

function terminalContrastFloorFor(theme: TerminalThemeId): number {
  return LIGHT_TERMINAL_THEMES.has(theme) ? LIGHT_MINIMUM_CONTRAST_RATIO : 1;
}

function terminalPolarityFor(theme: TerminalThemeId): "light" | "dark" {
  return LIGHT_TERMINAL_THEMES.has(theme) ? "light" : "dark";
}

export function TerminalSurface({ operationId, ticketBody, ticketPath, wsPath, theme = "instrument", onExit, active, keyboardFocusRequestId, zoom = 1, onStatusDetail, locale }: TerminalSurfaceProps) {
  const activeTheme = theme;
  const { renderer: terminalRenderer, inactiveFlush: terminalInactiveFlush, font: terminalFontSettings } = useTerminalPrefs();
  const inactiveFlushMs = terminalInactiveFlushMs(terminalInactiveFlush);
  const t = getT(locale);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const outputSchedulerRef = useRef<TerminalOutputScheduler | null>(null);
  const statusDetailReporterRef = useRef<TerminalStatusDetailReporter | null>(null);
  const scrollFollowRef = useRef<TerminalScrollFollowController | null>(null);
  // 줌 보정 effect에서 fit()을 재호출하기 위해 마운트 effect의 지역 FitAddon을 ref로 끌어올린다.
  const fitAddonRef = useRef<FitAddon | null>(null);
  // 실제 보정에 반영된 줌(=settle된 zoom). zoom prop은 보간 중 매 프레임 바뀌므로 디바운스로 이 값에 수렴시킨다.
  // 초기값을 zoom으로 두어 이미 확대된 패널이 마운트될 때 첫 렌더부터 올바른 스타일을 갖게 한다.
  const [appliedZoom, setAppliedZoom] = useState(zoom);
  // A pinch scales this surface's font only. It multiplies the settings size rather than writing
  // it back, so one terminal resized by hand does not resize every other one. A touch screen opens
  // at the smallest step, where the most of a session fits; pinching out is how it grows.
  const [touchFontScale, setTouchFontScale] = useState(() => (prefersTouchTerminal() ? MIN_FONT_SCALE : 1));
  const touchFontScaleRef = useRef(touchFontScale);
  touchFontScaleRef.current = touchFontScale;
  // A touch keyboard has no Escape, no arrows, and no Ctrl, so the surface carries them itself.
  // The check is read once at mount: a device does not grow a keyboard mid-session, and re-reading
  // it every render would flip the bar in and out under a hybrid's changing pointer.
  const [keyBarVisible] = useState(prefersTouchTerminal);
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const keyPanelOpenRef = useRef(keyPanelOpen);
  keyPanelOpenRef.current = keyPanelOpen;
  // Ctrl and Alt latch rather than being held — a finger cannot press two keys at once — so they
  // arm the next key and release on it, wherever that key comes from.
  const [latchedModifiers, setLatchedModifiers] = useState<TerminalKeyBarModifiers>(NO_LATCHED_MODIFIERS);
  const latchedModifiersRef = useRef(latchedModifiers);
  latchedModifiersRef.current = latchedModifiers;
  // onExit는 매 렌더 새 함수일 수 있으므로 ref로 고정해 connection effect의 의존성에서 제외한다.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onStatusDetailRef = useRef(onStatusDetail);
  onStatusDetailRef.current = onStatusDetail;
  // 비활성 Map 패널의 마운트 자동 포커스를 억제하기 위해 최신 active를 ref로 들고 있는다(마운트 effect는 재실행하지 않음).
  const activeRef = useRef(active);
  activeRef.current = active;
  // 마운트 effect는 prefs에 의존하지 않으므로(재실행하면 세션이 끊긴다) 최신 주기도 ref로 읽는다.
  const inactiveFlushMsRef = useRef(inactiveFlushMs);
  inactiveFlushMsRef.current = inactiveFlushMs;
  // 상태와 이유를 한 문자열로 이어 붙이면 화면이 그 문자열을 그대로 그리게 된다 — 그러면
  // 사용자는 기계 코드를 읽고, 이유를 사람 문장으로 옮길 자리가 사라진다. 둘은 갈라 둔다.
  const [status, setStatus] = useState<{ readonly kind: TerminalConnectionStatus; readonly code?: string }>({ kind: "connecting" });
  // 서버가 등급을 잠갔으면 되찾기를 제안하지 않는다 — 눌러도 다시 관전으로 돌아오는 버튼은 거짓이다.
  const [controlLocked, setControlLocked] = useState(false);
  // 마운트 effect는 심볼 폰트 선대기 등 await 뒤에 ticket 연결을 만들고 테마 변경에 재실행되지 않으므로,
  // 최신 극성은 ref로 읽는다(activeRef와 같은 이유) — 대기 중 테마가 바뀌어도 첫 ticket이 현재 극성을 싣는다.
  const colorSchemeRef = useRef(terminalPolarityFor(activeTheme));
  colorSchemeRef.current = terminalPolarityFor(activeTheme);
  // 터미널 인스턴스는 심볼 폰트 선대기 때문에 비동기로 생성된다. 같은 커밋에서 이미 실행된
  // WebGL/테마/폰트 effect는 null 터미널을 보고 건너뛰므로, 생성 완료를 epoch로 알려 재실행시킨다.
  const [mountedTerminalEpoch, setMountedTerminalEpoch] = useState(0);
  // 포커스 요청은 xterm 생성만으로는 충분하지 않고 입력 transport가 시작된 뒤에 처리해야 한다.
  const [inputReadyEpoch, setInputReadyEpoch] = useState(0);

  /**
   * Reads the latch and clears it in the same synchronous step. The clear has to land on the ref
   * rather than waiting for the state update, because the very next thing to run is xterm's data
   * listener — a latch still set there would apply the modifier a second time.
   */
  const consumeLatchedModifiers = useCallback((): TerminalKeyBarModifiers => {
    const modifiers = latchedModifiersRef.current;
    if (modifiers.ctrl || modifiers.alt) {
      latchedModifiersRef.current = NO_LATCHED_MODIFIERS;
      setLatchedModifiers(NO_LATCHED_MODIFIERS);
    }
    return modifiers;
  }, []);
  // 마운트 effect는 재실행되지 않으므로(재실행하면 세션이 끊긴다) 최신 콜백을 ref로 읽는다.
  const consumeLatchedModifiersRef = useRef(consumeLatchedModifiers);
  consumeLatchedModifiersRef.current = consumeLatchedModifiers;

  const sendBarKey = useCallback((id: TerminalKeyId) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const { ctrl, alt } = consumeLatchedModifiers();
    const sequence = terminalKeySequence(id, { ctrl, alt, shift: false }, terminal.modes.applicationCursorKeysMode);
    terminal.input(sequence, true);
  }, [consumeLatchedModifiers]);

  const sendBarText = useCallback((text: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const { ctrl, alt } = consumeLatchedModifiers();
    terminal.input(applyTerminalModifiers(text, { ctrl, alt, shift: false }), true);
  }, [consumeLatchedModifiers]);

  const toggleBarModifier = useCallback((modifier: "ctrl" | "alt") => {
    const current = latchedModifiersRef.current;
    const next = { ...current, [modifier]: !current[modifier] };
    latchedModifiersRef.current = next;
    setLatchedModifiers(next);
  }, []);

  const toggleKeyPanel = useCallback(() => {
    const next = !keyPanelOpenRef.current;
    keyPanelOpenRef.current = next;
    setKeyPanelOpen(next);
    // The panel takes the soft keyboard's place instead of stacking above it: a phone showing both
    // leaves the session two or three rows tall, which is no longer a terminal.
    if (next) terminalRef.current?.blur();
    else terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    let cleanupMountedTerminal: (() => void) | null = null;

    const mountTerminal = async () => {
      // WebGL glyph atlas는 첫 open 시점의 폰트 측정을 공유 캐시에 고정하므로, 심볼 폰트만 짧게 선대기한다.
      await waitForSymbolsNerdFontMono();
      if (disposed) return;

      const terminalTheme = terminalThemeFor(activeTheme);
      const terminal = new XtermTerminal({
        ...TERMINAL_OPTIONS,
        fontFamily: terminalFontSettings.family,
        fontSize: terminalFontSettings.size * appliedZoom * touchFontScaleRef.current,
        theme: terminalTheme,
        allowTransparency: terminalFieldIsTranslucent(terminalTheme.background ?? ""),
        minimumContrastRatio: terminalContrastFloorFor(activeTheme),
      });
      terminalRef.current = terminal;
      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      syncTerminalViewportBackground(container, terminalTheme);
      const xtermScreen = container.querySelector<HTMLElement>(".xterm-screen");
      // xterm's own touch inertia emits gesture changes without a client point. Under mouse tracking
      // it serializes those missing coordinates as `NaN` and sends them to the PTY. Guard the private
      // event at the public DOM boundary rather than patching or deep-importing xterm internals.
      const xtermGestureOriginGuard = xtermScreen ? createXtermGestureOriginGuard(xtermScreen) : null;
      const copyOnSelect = createTerminalCopyOnSelect({
        terminal,
        selectionTarget: container,
        windowTarget: window,
        clipboard: navigator.clipboard,
      });
      // 전체 화면 TUI(agent CLI 등)가 마우스 트래킹을 켜면 xterm은 드래그를 애플리케이션에 넘기고 자체
      // 선택을 끈다. 그때부터 선택 하이라이트도 복사도 애플리케이션이 수행하며, 복사 결과는 OSC 52로만
      // 터미널에 전달된다 — copy-on-select가 읽는 xterm 선택은 그 상태에서 항상 비어 있다.
      // 단 scrollback 재생 구간은 제외한다: 재생 청크에는 과거 복사의 OSC 52가 그대로 들어 있어,
      // 패널을 다시 열거나 재연결하는 것만으로 지금 클립보드가 낡은 내용으로 덮인다. connection이
      // 재생 시작/종료를 알려줄 때까지는 억제해 둔다.
      let replayingScrollback = true;
      const osc52Clipboard = createTerminalOsc52Clipboard({
        parser: terminal.parser,
        clipboard: navigator.clipboard,
        isReplayingScrollback: () => replayingScrollback,
      });
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";

      // Shift+Enter를 LF(\n)로 처리한다. xterm 기본 동작은 Shift 무관하게 Enter를 CR(\r)로 보내
      // TUI가 "제출"로 해석하므로, Shift+Enter는 LF를 직접 전송하고 기본 CR 전송을 막는다.
      // IME composition 중에는 xterm helper textarea의 compositionend 뒤 setTimeout(0)으로 LF를 예약해
      // xterm CompositionHelper의 최종 한글 전송(compositionend→setTimeout(0)) 뒤에 LF가 붙게 한다.
      const imeHandler = createImeShiftEnterHandler(() => terminal.input("\n"));
      const imeEventTarget = container.querySelector<HTMLElement>("textarea.xterm-helper-textarea, textarea") ?? container;
      imeEventTarget.addEventListener("compositionstart", imeHandler.onCompositionStart);
      imeEventTarget.addEventListener("compositionend", imeHandler.onCompositionEnd);
      imeEventTarget.addEventListener("focusout", imeHandler.onCompositionCancel);
      const windowsSelectionCopyHandler = createWindowsSelectionCopyHandler({
        getPlatform: () => navigator.platform,
        getSelection: () => terminal.getSelection(),
        writeText: (text) => navigator.clipboard.writeText(text),
      });
      terminal.attachCustomKeyEventHandler((event) => (
        windowsSelectionCopyHandler.handleKeyEvent(event) && imeHandler.handleKeyEvent(event)
      ));

      const scrollFollow = createTerminalScrollFollow({
        getViewport: () => terminal.buffer.active,
        scrollToBottom: () => scrollTerminalToBottom(terminal),
        scrollToLine: (line) => scrollTerminalToLine(terminal, line),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      });
      scrollFollowRef.current = scrollFollow;
      const scrollGesture = createTerminalScrollGestureTracker(
        container,
        imeEventTarget,
        scrollFollow.recordUserViewportChange,
      );
      const touchGestures = createTerminalTouchGestures(container, {
        // The wheel is the input xterm already routes correctly for whatever is running, so a pan
        // arrives as one rather than as a buffer scroll this surface chose on its own. The finger's
        // client point must travel with it: a coordinate-less WheelEvent encodes as `NaN` under
        // mouse tracking and Claude Code types that literal into the prompt.
        scrollByPixels: (deltaY, origin) => {
          const target = container.querySelector(".xterm-screen") ?? container.querySelector(".xterm") ?? container;
          dispatchSyntheticTerminalWheel(target, deltaY, origin);
        },
      }, {
        onFontScale: setTouchFontScale,
        readFontScale: () => touchFontScaleRef.current,
      });
      const outputScheduler = createTerminalOutputScheduler(
        terminal,
        activeRef.current !== false,
        inactiveFlushMsRef.current,
        scrollFollow.restoreAfterOutputParsing,
      );
      outputSchedulerRef.current = outputScheduler;
      const statusDetailReporter = createTerminalStatusDetailReporter({
        report: (detail) => onStatusDetailRef.current?.(detail),
      });
      statusDetailReporterRef.current = statusDetailReporter;
      const connection = createTerminalConnection({
        operationId,
        ...(ticketBody ? { ticketBody } : {}),
        ticketPath,
        wsPath,
        // spawn env COLORFGBG 힌트 — 연결 생성 시점의 최신 극성으로 고정된다(PTY는 최초 spawn 시 env 확정).
        colorScheme: colorSchemeRef.current,
        terminal: {
          onData: (listener) => terminal.onData((data) => {
            // xterm's normal scrollOnUserInput behavior resumes follow for every local input,
            // not only Enter. Keep the explicit follow state in lockstep with it.
            scrollFollow.resumeFollowing();
            // A latched Ctrl or Alt applies to whatever arrives next, and on a phone that is
            // usually a letter from the soft keyboard — which is the only way Ctrl+C exists there.
            // Keys sent from the bar clear the latch before calling input(), so they arrive here
            // already carrying their modifier and pass through untouched.
            const { ctrl, alt } = consumeLatchedModifiersRef.current();
            listener(ctrl || alt ? applyTerminalModifiers(data, { ctrl, alt, shift: false }) : data);
          }),
          write: (data) => {
            statusDetailReporter.push(data);
            outputScheduler.write(data);
          },
          drain: outputScheduler.drain,
        },
        onReplayStateChange: (replaying) => {
          replayingScrollback = replaying;
        },
        onExit: () => onExitRef.current?.(),
        onControlLockChange: (lock) => { setControlLocked(lock === "locked"); },
        onStatus: (nextStatus, message) => {
          setStatus({ kind: nextStatus, code: message });
        },
      });
      connectionRef.current = connection;

      // 여기에 terminal.refresh(0, rows-1)를 두지 않는다. 격자가 바뀌었으면 xterm이 resize 경로에서
      // 이미 전체 refresh를 예약했고(RenderService가 bufferService.onResize와 handleResize 양쪽에서),
      // 바뀌지 않았으면 다시 그릴 내용이 없다. 어느 쪽이든 이 호출은 같은 rAF로 합쳐지는 낭비이고,
      // WebGL 경로에서는 커서 blink 애니메이션까지 되감는다. 스크롤 복원은 아래 wrapper가 소유한다.
      const fitAndResize = () => {
        scrollFollow.preserveAfterGeometryChange(() => {
          fitAddon.fit();
          connection.resize(terminal.cols, terminal.rows);
        });
      };
      const scheduleFitAndResize = () => {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
          resizeDebounce = null;
          if (!disposed) fitAndResize();
        }, RESIZE_DEBOUNCE_MS);
      };

      const runInitialFit = async () => {
        await document.fonts?.ready;
        // 폰트 로딩 대기 중 세션이 전환되면(effect cleanup) 이미 dispose된 터미널에
        // fit/start를 호출하지 않는다 — 그렇지 않으면 빈 화면이나 잘못된 크기로 이어진다.
        if (disposed) return;
        fitAndResize();
        connection.start();
        setInputReadyEpoch((epoch) => epoch + 1);
        // 마운트(셸 열기·세션 전환) 직후 xterm에 포커스를 줘 마우스 클릭 없이 바로 입력되게 한다.
        // 단, Map의 비활성 패널(active===false)은 건너뛴다 — 여러 패널이 마운트되며 포커스를 다투지 않게 한다.
        // 단일 셸 터미널(active===undefined)은 기존대로 포커스한다.
        // 확장 패널이 열려 있을 때도 건너뛴다: 패널은 소프트 키보드를 대체한 것이라, 여기서 포커스를
        // 돌려주면 패널 아래에서 키보드가 다시 열려 터미널이 몇 줄로 줄어든다. 터미널 마운트는 폰트
        // 대기 뒤에 끝나므로 그 사이에 패널을 연 경우가 실제로 이 경로를 밟는다.
        if (activeRef.current !== false && !keyPanelOpenRef.current) terminal.focus();
      };

      resizeObserver = new ResizeObserver(scheduleFitAndResize);
      resizeObserver.observe(container);
      void runInitialFit();

      cleanupMountedTerminal = () => {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        imeEventTarget.removeEventListener("compositionstart", imeHandler.onCompositionStart);
        imeEventTarget.removeEventListener("compositionend", imeHandler.onCompositionEnd);
        imeEventTarget.removeEventListener("focusout", imeHandler.onCompositionCancel);
        imeHandler.dispose();
        connection.dispose();
        copyOnSelect.dispose();
        osc52Clipboard.dispose();
        scrollGesture.dispose();
        touchGestures.dispose();
        xtermGestureOriginGuard?.dispose();
        outputScheduler.dispose();
        statusDetailReporter.dispose();
        scrollFollow.dispose();
        terminalRef.current = null;
        connectionRef.current = null;
        outputSchedulerRef.current = null;
        statusDetailReporterRef.current = null;
        scrollFollowRef.current = null;
        fitAddonRef.current = null;
        // xterm WebglAddon(0.19.0)은 terminal.dispose() 시 AddonManager가 addon을 자동 정리하는
        // 경로에 내부 버그가 있어 TypeError(reading "_isDisposed")를 던질 수 있다. 이 예외가
        // useEffect cleanup 밖으로 전파되면 error boundary가 없는 React 트리가 통째로 언마운트되어
        // (빈 화면) 새로고침 전까지 복구되지 않는다. 정리 단계의 예외이므로 컴포넌트 경계에서
        // 격리해 트리를 보호한다 — DOM 노드는 key 재마운트로 어차피 교체된다.
        try {
          terminal.dispose();
        } catch {
          // xterm 내부 dispose 버그(위 주석)를 흡수한다.
        }
      };

      // 비동기 생성 완료 신호 — null 터미널을 보고 건너뛴 effect들을 재실행시킨다.
      setMountedTerminalEpoch((epoch) => epoch + 1);
    };

    void mountTerminal();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      cleanupMountedTerminal?.();
    };
  }, [operationId, ticketPath, wsPath]);

  // 활성 전환 시 이미 마운트된 xterm에 포커스를 다시 주고 기존 contract대로 bottom following을 재개한다.
  // keyboard request는 동일 Operation 재선택 시 active 불변을, input-ready epoch는 비동기 마운트 갭을 대응한다.
  // 비활성 전환에서는 scheduler 속도만 낮추며 focus 요청도 소비하지 않는다.
  useEffect(() => {
    outputSchedulerRef.current?.setActive(active !== false);
    if (!active) return;
    // 포커스만 패널 상태를 존중한다 — 출력 따라가기는 패널 개폐와 무관하게 이어져야 한다.
    if (!keyPanelOpenRef.current) terminalRef.current?.focus();
    scrollFollowRef.current?.resumeFollowing();
  }, [active, keyboardFocusRequestId, inputReadyEpoch]);

  // 갱신 주기 변경도 렌더러 전환처럼 세션을 끊지 않고 살아 있는 터미널에 바로 적용된다.
  // mountedTerminalEpoch는 비동기 마운트가 끝난 뒤 새 스케줄러에 현재 설정을 다시 흘려보내기 위한 것이다.
  useEffect(() => {
    outputSchedulerRef.current?.setInactiveFlushMs(inactiveFlushMs);
  }, [inactiveFlushMs, mountedTerminalEpoch]);

  // 리퀴드 글래스 게이트의 실효 상태 — 채널 계산값이 단일 진실이다(설정·@supports·
  // prefers-reduced-transparency 세 게이트를 모두 통과했을 때만 backdrop 채널이 none이 아니다).
  const [liquidGlassPane, setLiquidGlassPane] = useState(() => readLiquidGlassPaneActive());
  useEffect(() => {
    const sync = () => setLiquidGlassPane(readLiquidGlassPaneActive());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-glass", "data-theme"] });
    // OS 접근성 설정(prefers-reduced-transparency)은 속성 변이 없이 채널을 닫는다 —
    // 미디어쿼리 변화도 같은 sync로 받아야 열린 터미널이 즉시 불투명 계약으로 돌아간다.
    // jsdom에는 matchMedia가 없으므로 기능 검사로 가드한다(테스트 환경 크래시 방지).
    const reducedTransparency = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-transparency: reduce)")
      : null;
    reducedTransparency?.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      reducedTransparency?.removeEventListener("change", sync);
    };
  }, []);

  // Renderer changes only attach/detach the WebGL addon; the live terminal and websocket stay intact.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    let disposed = false;

    if (terminalRenderer === "webgl") {
      try {
        const webglAddon = new WebglAddon();
        webglAddonRef.current = webglAddon;
        // 런타임 중 실제 GPU 컨텍스트가 손실되면 addon을 정리해 DOM 렌더러로 폴백한다. 단,
        // 언마운트(세션 전환)로 인한 terminal.dispose()는 addon을 이미 정리하므로, 그때 발생하는
        // 컨텍스트 손실 콜백에서 또 dispose하지 않도록 disposed로 가드해 중복 정리를 막는다.
        webglAddon.onContextLoss(() => {
          if (disposed) return;
          try {
            webglAddon.dispose();
          } catch {
            // xterm WebglAddon dispose 버그를 렌더러 폴백 경로에서도 흡수한다.
          }
          if (webglAddonRef.current === webglAddon) webglAddonRef.current = null;
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL 컨텍스트 생성 실패 — DOM 렌더러 유지
        try {
          webglAddonRef.current?.dispose();
        } catch {
          // xterm WebglAddon dispose 버그를 WebGL 초기화 실패 경로에서도 흡수한다.
        }
        webglAddonRef.current = null;
      }
    }

    return () => {
      disposed = true;
      const webglAddon = webglAddonRef.current;
      if (!webglAddon) return;
      webglAddonRef.current = null;
      try {
        webglAddon.dispose();
      } catch {
        // xterm 내부 dispose 버그(메인 cleanup의 terminal.dispose 경로 포함)를 흡수한다.
      }
    };
  }, [terminalRenderer, operationId, mountedTerminalEpoch]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    const applyTerminalTheme = () => {
      const terminalTheme = terminalThemeFor(activeTheme);
      // 뷰포트 인라인 배경이 allowTransparency보다 먼저 자리를 잡아야 한다 — 이 옵션이 꺼지면
      // xterm이 `.xterm:not(.allow-transparency)` 클래스를 떼고, 그 규칙의 background-color:#000이
      // 인라인 값 없이 드러난다. 두 줄의 순서가 곧 그 검은 프레임을 막는 계약이다.
      syncTerminalViewportBackground(container, terminalTheme);
      terminal.options.allowTransparency = terminalFieldIsTranslucent(terminalTheme.background ?? "");
      terminal.options.theme = terminalTheme;
      terminal.options.minimumContrastRatio = terminalContrastFloorFor(activeTheme);
    };
    applyTerminalTheme();
    // liquidGlassPane 의존이 곧 리로드 없는 즉시 전환이다 — 설정 토글이 data-glass 속성을
    // 바꾸면 위 옵저버가 상태를 올리고, 이 효과가 terminal 채널 계산값을 다시 읽는다.
  }, [activeTheme, mountedTerminalEpoch, liquidGlassPane]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = terminalFontSettings.family;
    fitResizeAndRefreshTerminal(terminal, fitAddonRef.current, connectionRef.current, scrollFollowRef.current);
  }, [terminalFontSettings.family, mountedTerminalEpoch]);

  // 줌 settle 감지: zoom prop은 rAF 보간 중 매 프레임 바뀌므로, 마지막 변경 후 ZOOM_SETTLE_MS가 지나야
  // appliedZoom에 반영한다(타이머가 매 변경마다 리셋됨). 보간 중에는 부모 transform에 맡겨 글자가 부드럽게
  // 확대/축소되고, 보정(아래 effect)은 제스처당 1회만 발생한다.
  useEffect(() => {
    if (zoom === appliedZoom) return;
    const timer = setTimeout(() => setAppliedZoom(zoom), ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [zoom, appliedZoom]);

  // appliedZoom 반영: 마운트 단(.terminal-canvas)의 역스케일은 인라인 style(아래 zoomStyle)로 선언적으로
  // 적용되고, 여기서는 fontSize×zoom과 1회 refit만 명령형으로 수행한다. fontSize를 zoom배로 키워 부모
  // scale(zoom)과 합쳐도 painted 글자 크기가 동일하고(=base×parentZoom), cols/rows는 zoom에 불변이라
  // 그리드/픽셀 외형은 그대로 유지되며 xterm 좌표만 정정된다.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = terminalFontSettings.size * appliedZoom * touchFontScale;
    // 여기서 WebglAddon.clearTextureAtlas()를 호출하면 안 된다. xterm WebGL의 글리프 atlas는 동일 설정(폰트·
    // 테마·cell크기) 터미널들이 모듈 레벨 캐시(acquireTextureAtlas)에서 1개를 공유한다. 따라서 한 터미널이
    // atlas를 비우면 형제 터미널이 쓰는 공유 atlas까지 함께 비워지고, 형제에는 재그리기 신호가 가지 않아
    // 다른 터미널 화면이 깨진다(특히 마운트·복원 시 effect가 1회 실행되며 발생). 게다가 fontSize가 실제로
    // 바뀌면 xterm이 옵션 변경 핸들러(_handleOptionsChanged→_refreshCharAtlas→acquireTextureAtlas)에서 새
    // cell크기 키로 atlas를 자동 재획득하므로 수동 무효화는 불필요하다. atlas는 건드리지 않고 이 터미널만
    // fit + refresh로 재배치/재도색한다.
    fitResizeAndRefreshTerminal(terminal, fitAddonRef.current, connectionRef.current, scrollFollowRef.current);
  }, [appliedZoom, touchFontScale, terminalFontSettings.size, mountedTerminalEpoch]);

  // 연결이 'live'면 상태 바를 숨겨 터미널 canvas가 카드를 가득 채우게 하고,
  // connecting/error 등 문제 상황에서만 상태를 노출한다.
  const isLive = status.kind === "live";
  /**
   * 관전 중에는 출력이 계속 흐르므로 화면을 가리지 않는다 — 상태 줄 대신 배지를 얹어
   * "보이지만 칠 수 없다"만 말한다. 이 구분이 없으면 반응 없는 키보드가 연결 장애로 읽힌다.
   */
  const isViewing = status.kind === "viewer";
  /**
   * 실패는 상태 줄이 아니라 알림으로 나간다. 한 줄짜리 상태는 "무슨 일"까지만 실을 수 있어
   * 왜와 할 일을 담을 자리가 없고, 그 자리를 기계 코드가 대신 차지해 왔다.
   */
  const failure = status.kind === "failed" ? describeTerminalFailure(status.code, t) : null;
  // 줌 보정: 마운트 단을 레이아웃상 zoom배로 키운 뒤 scale(1/zoom)으로 되돌려 부모 scale(zoom)과 net 1로 상쇄한다.
  // %는 position:relative인 .terminal-viewport 기준이라 별도 측정 없이 inner 크기에 정확히 맞춰진다. zoom=1이면
  // 기본 스타일(.terminal-canvas의 inset:0)을 그대로 써 캔버스 외 셸 패널 사용처에 영향이 없다.
  const zoomStyle: CSSProperties | undefined = appliedZoom === 1
    ? undefined
    : {
        width: `${appliedZoom * 100}%`,
        height: `${appliedZoom * 100}%`,
        transform: `scale(${1 / appliedZoom})`,
        transformOrigin: "0 0",
      };

  return (
    <section className="terminal-stage" aria-label={t("terminal.aria")}>
      <div className="terminal-shell">
        {failure ? (
          <div className="terminal-failure">
            <FailureNotice {...failure} />
          </div>
        ) : !isLive && !isViewing ? (
          <div className="terminal-status" aria-live="polite">
            <span className="terminal-status-dot" aria-hidden="true" />
            {t(status.kind === "closed" ? "terminal.connection.closed" : "terminal.connection.connecting")}
          </div>
        ) : null}
        {isViewing ? (
          <div className="terminal-viewer-badge" role="status">
            <span className="terminal-viewer-badge-dot" aria-hidden="true" />
            <span className="terminal-viewer-badge-text">{t(controlLocked ? "terminal.viewer.remoteControlled" : "terminal.viewer.readOnly")}</span>
            {controlLocked ? null : (
              <button type="button" className="terminal-viewer-badge-action" onClick={() => connectionRef.current?.takeBackControl()}>
                {t("terminal.viewer.takeBack")}
              </button>
            )}
          </div>
        ) : null}
        <div className="terminal-viewport">
          <div className="terminal-canvas" ref={containerRef} style={zoomStyle} />
        </div>
        {/* A read-only session takes no input, so the bar stays away rather than offering keys that
            would go nowhere. */}
        {keyBarVisible && !isViewing ? (
          <TerminalKeyBar
            locale={locale}
            modifiers={latchedModifiers}
            expanded={keyPanelOpen}
            onToggleModifier={toggleBarModifier}
            onToggleExpanded={toggleKeyPanel}
            onKey={sendBarKey}
            onText={sendBarText}
          />
        ) : null}
      </div>
    </section>
  );
}

function baseTerminalThemeFor(theme: TerminalThemeId): ITheme {
  switch (theme) {
    case "instrument": return INSTRUMENT_TERMINAL_THEME;
    case "maritime": return MARITIME_TERMINAL_THEME;
    case "carbon": return CARBON_TERMINAL_THEME;
    case "whites": return WHITES_TERMINAL_THEME;
  }
}

/* 터미널 필드의 단일층 규약 — xterm 필드(cols×rows 격자)는 패널 본문을 꽉 채우지 못하므로,
   필드와 남는 거터가 서로 다른 층을 칠하면 경계 띠가 어긋난다(실측). 그래서:
   - 다크 + 게이트 열림: xterm 배경은 알파 0으로 비우고(RGB는 아래 glassFieldClearColor 참조),
     필드·거터를 컨테이너(.canvas-operation-terminal/.terminal-shell)의 --glass-tint-terminal
     한 겹이 칠한다. 다크는 minimumContrastRatio=1이라 투명 배경이 대비 보정에 관여하지 않는다.
   - 라이트(Whites)와 게이트 닫힘: mCR이 배경 실색을 요구하므로 xterm은 채널 계산값
     (라이트 유리=불투명 종이, 게이트 닫힘=불투명 --surface-panel)을 그대로 받는다 —
     컨테이너도 같은 채널을 칠해 필드·거터가 같은 값으로 만난다.
   xterm은 CSS 변수를 못 받으므로 계산값을 읽고, 압축 CSS의 oklch 변형(`.022` 선행 0
   생략·% 알파)을 xterm 파서가 검정으로 낙하시키므로(실측) canvas로 rgba() 정규화해 넘긴다.
   위 ITheme의 background 리터럴은 토큰을 읽을 수 없는 환경(jsdom·SSR)의 폴백이다. */
export function resolvePanelSurface(theme: TerminalThemeId, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  if (!LIGHT_TERMINAL_THEMES.has(theme) && readLiquidGlassPaneActive()) return glassFieldClearColor();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue("--glass-tint-terminal").trim();
  if (!resolved) return fallback;
  return normalizeCssColorToRgba(resolved) ?? fallback;
}

/* 다크 유리에서 필드를 비우는 값 — 알파는 0이지만 RGB는 검정이 아니라 유리 톤이어야 한다.
   xterm은 dim(SGR 2)을 `BgFlags.DIM`, 즉 **배경 워드의 비트**로 싣는다. WebGL RectangleRenderer는
   배경 사각형을 그릴지를 `bg !== 0` 하나로 판정하므로(updateBackgrounds), 배경이 default인 dim 셀도
   사각형 대상이 되고, 그 사각형은 테마 배경색을 쓰면서 알파를 상수 1로 덮어쓴다(_updateRectangle).
   화면 전체를 지우는 뷰포트 사각형만 알파를 보존하므로, 필드는 투명한데 dim 셀만 불투명해진다.
   `rgba(0,0,0,0)`을 넘기면 그 셀이 순수 검정으로 칠해진다 — Claude Code가 diff 거터를 dim으로
   찍는 것이 실측으로 확인됐고(PTY 원시 바이트), 유리 위에 검정 블록으로 드러났다.
   그래서 RGB에는 유리 유효색의 불투명 근사(--glass-tint-terminal-floor)를 싣는다: 알파 0이라
   필드 자체는 그대로 유리를 통과시키고, 알파가 1로 강제되는 dim 사각형만 필드와 같은 색이 된다.
   유리는 뒤에 오는 것에 따라 유효색이 흔들리므로 이 값은 일치가 아니라 근사다. */
function glassFieldClearColor(): string {
  const floor = getComputedStyle(document.documentElement).getPropertyValue("--glass-tint-terminal-floor").trim();
  // 빈 값을 프로브에 넘기면 fillStyle 할당이 무시되어 직전 색이 그대로 읽힌다 — 여기서 끊는다.
  if (!floor) return "rgba(0, 0, 0, 0)";
  const channels = /^rgba?\(([^)]+)\)$/i.exec(normalizeCssColorToRgba(floor) ?? "")?.[1]?.split(",");
  if (!channels || channels.length < 3) return "rgba(0, 0, 0, 0)";
  return `rgba(${channels[0]?.trim()}, ${channels[1]?.trim()}, ${channels[2]?.trim()}, 0)`;
}

let colorProbeCtx: CanvasRenderingContext2D | null | undefined;

function normalizeCssColorToRgba(color: string): string | null {
  if (colorProbeCtx === undefined) {
    try {
      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      colorProbeCtx = probe.getContext("2d", { willReadFrequently: true });
      if (colorProbeCtx) colorProbeCtx.globalCompositeOperation = "copy";
    } catch {
      colorProbeCtx = null;
    }
  }
  if (!colorProbeCtx) return color;
  try {
    colorProbeCtx.fillStyle = color;
    colorProbeCtx.fillRect(0, 0, 1, 1);
    const d = colorProbeCtx.getImageData(0, 0, 1, 1).data;
    // noUncheckedIndexedAccess: 픽셀 인덱스 접근은 undefined 후보라 기본값으로 좁힌다.
    return `rgba(${d[0] ?? 0}, ${d[1] ?? 0}, ${d[2] ?? 0}, ${((d[3] ?? 255) / 255).toFixed(3)})`;
  } catch {
    return color;
  }
}

/* xterm의 allowTransparency는 "필드가 실제로 반투명한가" 하나에서만 파생된다 — 테마도
   게이트도 여기서 다시 판정하지 않고, resolvePanelSurface가 이미 정한 배경의 알파를 읽는다.

   상수 true로 두면 안 된다. 이 옵션은 투명도 지원 여부가 아니라 글리프 래스터 경로를 고른다:
   false면 TextureAtlas의 임시 캔버스가 {alpha:false}라 배경을 아는 상태에서 감마 보정된 텍스트가
   구워지고, clearColor()가 배경과 일치하는 픽셀만 비워 AA 경계까지 알파 255의 사전합성 RGB로
   아틀라스에 남는다(GPU는 복사만 한다). true면 글리프가 투명 위에 선형 커버리지 알파로만 그려지고
   GlyphRenderer가 sRGB 바이트 공간에서 다시 합성한다 — 감마 미보정 lerp는 밝은 바탕 위 어두운
   잉크의 커버리지를 과소 표현한다. 라이트(불투명 종이) 터미널에서 획 잉크가 18.2% 사라지고
   가장자리가 거칠어지는 것이 dpr=2 실측으로 확인됐다(다크는 반대 부호로 +2.6%라 드러나지 않았다).
   즉 불투명 배경에서 true는 이득이 없고 비용만 있다. */
export function terminalFieldIsTranslucent(background: string): boolean {
  const channels = /^rgba?\(([^)]+)\)$/i.exec(background.trim())?.[1]?.split(",");
  // rgba()가 아니면 resolvePanelSurface가 정규화를 못 한 환경이다(ITheme 폴백, 또는 canvas 프로브
  // 부재로 되돌아온 원문 oklch). 둘 다 xterm 자신도 알파를 파싱하지 못하는 환경이므로 불투명으로
  // 읽는다. 알파가 실제로 필요한 유일한 경로(다크+게이트 열림)는 glassFieldClearColor()가 폴백까지
  // 포함해 언제나 rgba() 형태로 돌려주므로 여기서 항상 검출된다.
  if (!channels) return false;
  return channels.length > 3 && Number.parseFloat(channels[3] ?? "1") < 1;
}

/* 게이트가 열려 있을 때만 backdrop 채널이 none이 아니다 — 세 게이트(설정·@supports·
   reduced-transparency)를 개별로 다시 판정하지 않고 채널 계산값 하나를 진실로 삼는다. */
export function readLiquidGlassPaneActive(): boolean {
  if (typeof document === "undefined") return false;
  const backdrop = getComputedStyle(document.documentElement).getPropertyValue("--glass-backdrop-strong").trim();
  return backdrop !== "" && backdrop !== "none";
}

function terminalThemeFor(theme: TerminalThemeId): ITheme {
  const base = baseTerminalThemeFor(theme);
  return { ...base, background: resolvePanelSurface(theme, base.background ?? "") };
}

export function syncTerminalViewportBackground(container: HTMLElement, theme: ITheme): void {
  const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
  if (!viewport) return;
  if (theme.background) {
    // xterm 6은 테마 배경을 새 scroll host에만 적용하므로, 남는 viewport 영역도 같은 색으로 맞춘다.
    viewport.style.backgroundColor = theme.background;
  } else {
    viewport.style.removeProperty("background-color");
  }
}

function scrollTerminalToBottom(terminal: XtermTerminal | null): void {
  if (!terminal) return;
  terminal.scrollToBottom();
  if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
}

function scrollTerminalToLine(terminal: XtermTerminal | null, line: number): void {
  if (!terminal) return;
  terminal.scrollToLine(line);
  if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
}

interface TerminalScrollGestureTracker {
  readonly dispose: () => void;
}

export function createTerminalScrollGestureTracker(
  container: HTMLElement,
  keyboardTarget: HTMLElement,
  recordUserViewportChange: () => void,
): TerminalScrollGestureTracker {
  const scrollHost = container.querySelector<HTMLElement>(".xterm-scrollable-element")
    ?? container.querySelector<HTMLElement>(".xterm-viewport");
  if (!scrollHost) return { dispose: () => undefined };

  let pointerScrolling = false;
  let gestureFrame: number | null = null;

  const scheduleUserViewportRecord = () => {
    if (gestureFrame !== null) window.cancelAnimationFrame(gestureFrame);
    // xterm synchronizes its DOM viewport on the frame after key/wheel handling. Read the public
    // buffer position after that synchronization instead of trying to correlate onScroll timing.
    gestureFrame = window.requestAnimationFrame(() => {
      gestureFrame = window.requestAnimationFrame(() => {
        gestureFrame = null;
        recordUserViewportChange();
      });
    });
  };
  const onWheel = () => scheduleUserViewportRecord();
  const onTouchStart = () => { pointerScrolling = true; };
  const onPointerDown = (event: PointerEvent) => {
    // 구형 네이티브 스크롤바와 xterm 6 커스텀 스크롤바, 터치 패닝을 모두 사용자 제스처로 분류한다.
    pointerScrolling = isTerminalScrollPointer(event, scrollHost);
  };
  const onViewportScroll = () => {
    if (pointerScrolling) scheduleUserViewportRecord();
  };
  const onPointerEnd = () => {
    const shouldRecord = pointerScrolling;
    pointerScrolling = false;
    if (shouldRecord) scheduleUserViewportRecord();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isTerminalScrollbackKey(event)) scheduleUserViewportRecord();
  };

  // xterm 핸들러보다 먼저 제스처 경계를 포착하고, xterm 동기화 뒤의 public viewport를 기록한다.
  scrollHost.addEventListener("wheel", onWheel, { capture: true, passive: true });
  scrollHost.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  scrollHost.addEventListener("touchend", onPointerEnd);
  scrollHost.addEventListener("touchcancel", onPointerEnd);
  scrollHost.addEventListener("pointerdown", onPointerDown, true);
  scrollHost.addEventListener("scroll", onViewportScroll);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  keyboardTarget.addEventListener("keydown", onKeyDown, true);

  return {
    dispose: () => {
      scrollHost.removeEventListener("wheel", onWheel, true);
      scrollHost.removeEventListener("touchstart", onTouchStart, true);
      scrollHost.removeEventListener("touchend", onPointerEnd);
      scrollHost.removeEventListener("touchcancel", onPointerEnd);
      scrollHost.removeEventListener("pointerdown", onPointerDown, true);
      scrollHost.removeEventListener("scroll", onViewportScroll);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      keyboardTarget.removeEventListener("keydown", onKeyDown, true);
      if (gestureFrame !== null) window.cancelAnimationFrame(gestureFrame);
    },
  };
}

export function isTerminalScrollPointer(event: PointerEvent, scrollHost: HTMLElement): boolean {
  if (event.pointerType === "touch" || event.target === scrollHost) return true;
  return event.composedPath().some((target) => {
    const classList = (target as { readonly classList?: { contains: (token: string) => boolean } }).classList;
    return classList?.contains("scrollbar") === true;
  });
}

function isTerminalScrollbackKey(event: KeyboardEvent): boolean {
  return event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End";
}

export function createTerminalOutputScheduler(
  terminal: XtermTerminal,
  initiallyActive: boolean,
  initialInactiveFlushMs: number,
  afterOutputParsing: () => void,
): TerminalOutputScheduler {
  let active = initiallyActive;
  let inactiveFlushMs = initialInactiveFlushMs;
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBytes = 0;
  let pending: Uint8Array[] = [];
  // drain은 "호출 시점 이전에 write된 바이트"의 파싱 완료만 기다린다(시퀀스 비교). 정지(quiescence)
  // 대기로 구현하면 재접속 직후 PTY가 연속 출력 중일 때 pendingBytes가 계속 차서 입력 구독이
  // 무기한 지연된다 — 폭주 프로세스에 Ctrl+C를 보내야 하는 순간에 입력이 잠기는 회귀가 된다.
  let writeSeq = 0;
  let parsedSeq = 0;
  let pendingDrains: Array<{ readonly seq: number; readonly callback: () => void }> = [];

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const runPendingDrains = () => {
    if (disposed || pendingDrains.length === 0) return;
    const ready = pendingDrains.filter((drain) => drain.seq <= parsedSeq);
    if (ready.length === 0) return;
    pendingDrains = pendingDrains.filter((drain) => drain.seq > parsedSeq);
    for (const drain of ready) drain.callback();
  };

  const flush = () => {
    clearFlushTimer();
    if (disposed || pendingBytes === 0) return;
    const output = concatTerminalOutput(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    writeSeq += 1;
    const seq = writeSeq;
    terminal.write(output, () => {
      parsedSeq = seq;
      runPendingDrains();
      if (!disposed) afterOutputParsing();
    });
  };

  const scheduleFlush = () => {
    if (disposed || flushTimer || pendingBytes === 0) return;
    flushTimer = setTimeout(flush, active ? ACTIVE_OUTPUT_FLUSH_MS : inactiveFlushMs);
  };

  return {
    write: (data) => {
      if (disposed || data.byteLength === 0) return;
      pending.push(data);
      pendingBytes += data.byteLength;
      if (pendingBytes >= MAX_BUFFERED_OUTPUT_BYTES) {
        flush();
        return;
      }
      scheduleFlush();
    },
    drain: (callback) => {
      if (disposed) return;
      flush();
      if (parsedSeq === writeSeq) {
        callback();
        return;
      }
      pendingDrains.push({ seq: writeSeq, callback });
    },
    setActive: (nextActive) => {
      if (active === nextActive) return;
      active = nextActive;
      clearFlushTimer();
      if (active) {
        flush();
        return;
      }
      scheduleFlush();
    },
    // 설정 변경을 살아 있는 터미널에 즉시 적용한다(렌더러 전환과 같은 계약). 대기 중인 타이머는
    // 새 주기로 다시 건다 — 그렇게 하지 않으면 절약에서 즉시로 옮긴 직후 한 번은 옛 주기로 늦게 그려진다.
    setInactiveFlushMs: (nextInactiveFlushMs) => {
      if (inactiveFlushMs === nextInactiveFlushMs) return;
      inactiveFlushMs = nextInactiveFlushMs;
      if (active) return;
      clearFlushTimer();
      scheduleFlush();
    },
    dispose: () => {
      pendingDrains = [];
      flush();
      disposed = true;
      pending = [];
      pendingBytes = 0;
      clearFlushTimer();
    },
  };
}

function concatTerminalOutput(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fitResizeAndRefreshTerminal(
  terminal: XtermTerminal,
  fitAddon: FitAddon | null,
  connection: TerminalConnection | null,
  scrollFollow: TerminalScrollFollowController | null,
): void {
  const fitResizeAndRefresh = () => {
    fitAddon?.fit();
    connection?.resize(terminal.cols, terminal.rows);
    terminal.refresh(0, terminal.rows - 1);
  };
  if (scrollFollow) {
    scrollFollow.preserveAfterGeometryChange(fitResizeAndRefresh);
    return;
  }
  fitResizeAndRefresh();
}

/** A coarse pointer means fingers, and a finger-sized terminal starts at its smallest step. */
function prefersTouchTerminal(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}
