import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { useConsoleState } from "../hooks/use-store.js";
import { createTerminalConnection, type TerminalConnection } from "../terminal-connection.js";
import type { ThemeId } from "../types.js";

interface TerminalProps {
  readonly sessionId: string;
  readonly kind?: "shell";
  readonly onExit?: () => void;
  // 이 터미널이 활성(선택)으로 전환될 때 마우스 클릭 없이 키보드 포커스를 잡아준다(Map 검색 이동 등).
  readonly active?: boolean;
}

const TERMINAL_OPTIONS = {
  // Unicode11Addon은 terminal.unicode(proposed API)를 사용하므로 이 옵션이 true여야 한다.
  // false이면 addon.activate()가 "must set allowProposedApi" 오류를 던져 터미널 마운트가 깨진다.
  allowProposedApi: true,
  convertEol: true,
  cursorBlink: true,
  cursorStyle: "block" as const,
  fontFamily: "\"Cascadia Code\", \"Cascadia Mono\", \"JetBrains Mono Variable\", ui-monospace, \"SF Mono\", Menlo, monospace",
  fontSize: 14,
  lineHeight: 1.2,
};

const RESIZE_DEBOUNCE_MS = 80;

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

export function Terminal({ sessionId, kind, onExit, active }: TerminalProps) {
  const { activeTheme, terminalRenderer } = useConsoleState();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  // onExit는 매 렌더 새 함수일 수 있으므로 ref로 고정해 connection effect의 의존성에서 제외한다.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const terminal = new XtermTerminal({ ...TERMINAL_OPTIONS, theme: terminalThemeFor(activeTheme) });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
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
      terminal.focus();
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
  }, [kind, sessionId]);

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

  // 연결이 'live'면 상태 바를 숨겨 터미널 canvas가 카드를 가득 채우게 하고,
  // connecting/error 등 문제 상황에서만 상태를 노출한다.
  const isLive = status.startsWith("live");

  return (
    <section className="terminal-stage" aria-label={kind === "shell" ? "Shell terminal" : "Fleet terminal"}>
      <div className="terminal-shell">
        {!isLive ? (
          <div className="terminal-status" aria-live="polite">
            <span className="terminal-status-dot" aria-hidden="true" />
            {status}
          </div>
        ) : null}
        <div className="terminal-canvas" ref={containerRef} />
      </div>
    </section>
  );
}

function terminalThemeFor(theme: ThemeId): ITheme {
  return theme === "carbon" ? CARBON_TERMINAL_THEME : MARITIME_TERMINAL_THEME;
}
