import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { useConsoleState } from "../hooks/use-store.js";
import { createTerminalConnection, type TerminalConnection } from "../terminal-connection.js";
import type { ThemeId } from "../types.js";

interface TerminalProps {
  readonly sessionId: string;
  readonly kind?: "shell";
  // theater-shell 패널에서만 지정 — Theater cwd 셸 ticket 발급에 쓰인다.
  readonly theaterId?: string;
  readonly onExit?: () => void;
  // 이 터미널이 활성(선택)으로 전환될 때 마우스 클릭 없이 키보드 포커스를 잡아준다(Map 검색 이동 등).
  readonly active?: boolean;
  // 맵 캔버스의 줌 배율(viewport.zoom). 캔버스 외 셸 패널 사용처는 기본 1.
  // 캔버스가 부모에 transform:scale(zoom)을 걸면 xterm의 마우스 셀 좌표 계산이 scale을 보정하지 못해
  // zoom≠1에서 커서/선택 위치가 어긋난다(분자=scale 반영 화면거리, 분모=scale 미반영 cellWidth). 이를
  // 터미널 마운트 단의 역스케일(scale(1/zoom)) + fontSize×zoom으로 net scale=1을 만들어 좌표를 정정한다.
  readonly zoom?: number;
}

const TERMINAL_OPTIONS = {
  // Unicode11Addon은 terminal.unicode(proposed API)를 사용하므로 이 옵션이 true여야 한다.
  // false이면 addon.activate()가 "must set allowProposedApi" 오류를 던져 터미널 마운트가 깨진다.
  allowProposedApi: true,
  convertEol: true,
  cursorBlink: true,
  cursorStyle: "block" as const,
  lineHeight: 1.2,
};

const RESIZE_DEBOUNCE_MS = 80;
// 줌 보간(rAF tween)이 멈춘 뒤 보정을 1회만 적용하기 위한 디바운스. zoom prop은 보간 중 매 프레임 바뀌므로,
// 마지막 변경 후 이 시간이 지나야(=settle) counter-scale/fontSize/fit을 적용한다. 보간 중에는 부모 transform에
// 맡겨 글자가 부드럽게 확대/축소되고, atlas 재생성을 제스처당 1회로 묶어 WebGL 비용을 억제한다.
const ZOOM_SETTLE_MS = 120;

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

export function Terminal({ sessionId, kind, theaterId, onExit, active, zoom = 1 }: TerminalProps) {
  const { activeTheme, terminalRenderer, terminalFont } = useConsoleState();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  // 줌 보정 effect에서 fit()을 재호출하기 위해 마운트 effect의 지역 FitAddon을 ref로 끌어올린다.
  const fitAddonRef = useRef<FitAddon | null>(null);
  // 실제 보정에 반영된 줌(=settle된 zoom). zoom prop은 보간 중 매 프레임 바뀌므로 디바운스로 이 값에 수렴시킨다.
  // 초기값을 zoom으로 두어 이미 확대된 패널이 마운트될 때 첫 렌더부터 올바른 스타일을 갖게 한다.
  const [appliedZoom, setAppliedZoom] = useState(zoom);
  // onExit는 매 렌더 새 함수일 수 있으므로 ref로 고정해 connection effect의 의존성에서 제외한다.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // 비활성 Map 패널의 마운트 자동 포커스를 억제하기 위해 최신 active를 ref로 들고 있는다(마운트 effect는 재실행하지 않음).
  const activeRef = useRef(active);
  activeRef.current = active;
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const terminal = new XtermTerminal({
      ...TERMINAL_OPTIONS,
      fontFamily: terminalFont.family,
      fontSize: terminalFont.size * appliedZoom,
      theme: terminalThemeFor(activeTheme),
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";

    // Shift+Enter는 개행(LF)으로 처리한다. xterm 기본 동작은 Shift 여부와 무관하게 Enter를
    // CR(\r)로 보내 TUI가 이를 "제출"로 해석하므로, Shift+Enter는 직접 LF(\n)를 입력시키고
    // (input()이 onData를 트리거해 기존 전송 경로를 탄다) 기본 CR 전송을 막는다.
    // 이 핸들러는 keydown뿐 아니라 keypress 이벤트에서도 호출되므로, keydown에서만 LF를 한 번
    // 입력시키되 false 반환은 모든 이벤트 타입에 적용해야 keypress 경로의 CR 전송까지 차단된다.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === "Enter" && event.shiftKey) {
        if (event.type === "keydown") terminal.input("\n");
        return false;
      }
      return true;
    });

    const connection = createTerminalConnection({
      sessionId,
      kind,
      theaterId,
      terminal,
      onExit: () => onExitRef.current?.(),
      onStatus: (nextStatus, message) => {
        setStatus(message ? `${nextStatus}: ${message}` : nextStatus);
      },
    });
    connectionRef.current = connection;

    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    const fitAndResize = () => {
      fitAddon.fit();
      connection.resize(terminal.cols, terminal.rows);
    };
    const fitResizeAndRefresh = () => {
      fitAndResize();
      terminal.refresh(0, terminal.rows - 1);
    };
    const scheduleFitAndResize = () => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        resizeDebounce = null;
        if (!disposed) fitResizeAndRefresh();
      }, RESIZE_DEBOUNCE_MS);
    };

    const runInitialFit = async () => {
      await document.fonts?.ready;
      // 폰트 로딩 대기 중 세션이 전환되면(effect cleanup) 이미 dispose된 터미널에
      // fit/start를 호출하지 않는다 — 그렇지 않으면 빈 화면이나 잘못된 크기로 이어진다.
      if (disposed) return;
      fitAndResize();
      connection.start();
      // 마운트(셸 열기·세션 전환) 직후 xterm에 포커스를 줘 마우스 클릭 없이 바로 입력되게 한다.
      // 단, Map의 비활성 패널(active===false)은 건너뛴다 — 여러 패널이 마운트되며 포커스를 다투지 않게 한다.
      // 단일 셸 터미널(active===undefined)은 기존대로 포커스한다.
      if (activeRef.current !== false) terminal.focus();
    };

    const resizeObserver = new ResizeObserver(scheduleFitAndResize);
    resizeObserver.observe(container);
    void runInitialFit();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      connection.dispose();
      terminalRef.current = null;
      connectionRef.current = null;
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
  }, [kind, sessionId, theaterId]);

  // 활성 전환 시(예: Map 검색으로 이동·확대된 직후) 이미 마운트된 xterm에 포커스를 다시 줘
  // 마우스 클릭 없이 바로 입력되게 한다. 비활성 전환에서는 아무 것도 하지 않는다.
  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

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
  }, [terminalRenderer, kind, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemeFor(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = terminalFont.family;
    fitAndRefreshTerminal(terminal, fitAddonRef.current);
  }, [terminalFont.family]);

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
    terminal.options.fontSize = terminalFont.size * appliedZoom;
    // 여기서 WebglAddon.clearTextureAtlas()를 호출하면 안 된다. xterm WebGL의 글리프 atlas는 동일 설정(폰트·
    // 테마·cell크기) 터미널들이 모듈 레벨 캐시(acquireTextureAtlas)에서 1개를 공유한다. 따라서 한 터미널이
    // atlas를 비우면 형제 터미널이 쓰는 공유 atlas까지 함께 비워지고, 형제에는 재그리기 신호가 가지 않아
    // 다른 터미널 화면이 깨진다(특히 마운트·복원 시 effect가 1회 실행되며 발생). 게다가 fontSize가 실제로
    // 바뀌면 xterm이 옵션 변경 핸들러(_handleOptionsChanged→_refreshCharAtlas→acquireTextureAtlas)에서 새
    // cell크기 키로 atlas를 자동 재획득하므로 수동 무효화는 불필요하다. atlas는 건드리지 않고 이 터미널만
    // fit + refresh로 재배치/재도색한다.
    fitAndRefreshTerminal(terminal, fitAddonRef.current);
  }, [appliedZoom, terminalFont.size]);

  // 연결이 'live'면 상태 바를 숨겨 터미널 canvas가 카드를 가득 채우게 하고,
  // connecting/error 등 문제 상황에서만 상태를 노출한다.
  const isLive = status.startsWith("live");
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
    <section className="terminal-stage" aria-label={kind === "shell" ? "Shell terminal" : "Fleet terminal"}>
      <div className="terminal-shell">
        {!isLive ? (
          <div className="terminal-status" aria-live="polite">
            <span className="terminal-status-dot" aria-hidden="true" />
            {status}
          </div>
        ) : null}
        <div className="terminal-viewport">
          <div className="terminal-canvas" ref={containerRef} style={zoomStyle} />
        </div>
      </div>
    </section>
  );
}

function terminalThemeFor(theme: ThemeId): ITheme {
  return theme === "carbon" ? CARBON_TERMINAL_THEME : MARITIME_TERMINAL_THEME;
}

function fitAndRefreshTerminal(terminal: XtermTerminal, fitAddon: FitAddon | null): void {
  fitAddon?.fit();
  terminal.refresh(0, terminal.rows - 1);
}
