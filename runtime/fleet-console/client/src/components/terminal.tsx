import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { createTerminalConnection, type TerminalConnection } from "../terminal-connection.js";
import { clearTerminalToken } from "../token-storage.js";

interface TerminalProps {
  readonly terminalToken: string;
  readonly sessionId: string;
}

const TERMINAL_OPTIONS = {
  allowProposedApi: false,
  convertEol: true,
  cursorBlink: true,
  cursorStyle: "block" as const,
  fontFamily: "\"Cascadia Code\", \"Cascadia Mono\", \"JetBrains Mono Variable\", ui-monospace, \"SF Mono\", Menlo, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  theme: {
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
  },
};

export function Terminal({ terminalToken, sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new XtermTerminal(TERMINAL_OPTIONS);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

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

    // WebGL 렌더러: GPU 가속으로 더 선명하고 빠른 렌더링. 컨텍스트 손실 시 스스로 정리해 DOM 렌더러로 폴백한다.
    // open() 이후에만 로드할 수 있으며, WebGL 미지원 환경에서는 기본 DOM 렌더러를 그대로 사용한다.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL 컨텍스트 생성 실패 — DOM 렌더러 유지
    }

    const connection = createTerminalConnection({
      terminalToken,
      sessionId,
      terminal,
      onAuthInvalid: clearTerminalToken,
      onStatus: (nextStatus, message) => {
        setStatus(message ? `${nextStatus}: ${message}` : nextStatus);
      },
    });
    connectionRef.current = connection;

    const fitAndResize = () => {
      fitAddon.fit();
      connection.resize(terminal.cols, terminal.rows);
    };

    const runInitialFit = async () => {
      await document.fonts?.ready;
      fitAndResize();
      connection.start();
    };

    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);
    void runInitialFit();

    return () => {
      resizeObserver.disconnect();
      connection.dispose();
      connectionRef.current = null;
      terminal.dispose();
    };
  }, [sessionId, terminalToken]);

  return (
    <section className="terminal-stage" aria-label="Fleet terminal">
      <div className="terminal-shell">
        <div className="terminal-status" aria-live="polite">
          <span className={`terminal-status-dot ${status.startsWith("live") ? "is-live" : ""}`} aria-hidden="true" />
          {status}
        </div>
        <div className="terminal-canvas" ref={containerRef} />
      </div>
    </section>
  );
}
