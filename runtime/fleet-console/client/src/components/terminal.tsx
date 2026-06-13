import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { createTerminalConnection, type TerminalConnection } from "../terminal-connection.js";
import { clearTerminalToken } from "../token-storage.js";

interface TerminalProps {
  readonly terminalToken: string;
}

const TERMINAL_OPTIONS = {
  allowProposedApi: false,
  convertEol: true,
  cursorBlink: true,
  cursorStyle: "block" as const,
  fontFamily: "\"JetBrains Mono Variable\", \"JetBrains Mono\", ui-monospace, \"SF Mono\", Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.35,
  theme: {
    background: "oklch(18% 0.045 248)",
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

export function Terminal({ terminalToken }: TerminalProps) {
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

    const connection = createTerminalConnection({
      terminalToken,
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
  }, [terminalToken]);

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
