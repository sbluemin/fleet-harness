import { useCallback, useEffect, useRef, useState } from "react";

import type { JobLogStatus } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface JobStatusDockProps {
  readonly status: JobLogStatus;
  readonly lines: readonly string[];
  readonly runningLabel: string;
  readonly doneLabel: string;
  readonly errorLabel: string;
  readonly onDismiss: () => void;
  readonly onRetry?: (() => void) | undefined;
}

// ─── constants ───────────────────────────────────────────────────────────────

const DONE_LINGER_MS = 4000;

// ─── JobStatusDock ────────────────────────────────────────────────────────────

export function JobStatusDock({
  status,
  lines,
  runningLabel,
  doneLabel,
  errorLabel,
  onDismiss,
  onRetry,
}: JobStatusDockProps) {
  const [isOpen, setIsOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // collapse when a new job starts
  useEffect(() => {
    if (status === "running") setIsOpen(false);
  }, [status]);

  // auto-scroll log when lines arrive
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // auto-collapse then dismiss after done linger
  useEffect(() => {
    if (status !== "done") return;
    timerRef.current = setTimeout(() => {
      setIsOpen(false);
      onDismiss();
    }, DONE_LINGER_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, onDismiss]);

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsOpen(false);
    onDismiss();
  }, [onDismiss]);

  const toggle = useCallback(() => setIsOpen((o) => !o), []);

  if (status === "idle") return null;

  const dotClass =
    status === "running"
      ? "skills-dock-dot is-live"
      : status === "done"
        ? "skills-dock-dot is-ok"
        : "skills-dock-dot is-err";

  const labelClass =
    status === "done"
      ? "skills-dock-label is-ok"
      : status === "error"
        ? "skills-dock-label is-err"
        : "skills-dock-label";

  const label =
    status === "running" ? runningLabel : status === "done" ? doneLabel : errorLabel;

  return (
    <div className="skills-dock">
      {isOpen && (
        <div ref={logRef} className="skills-dock-log">
          {lines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="skills-dock-log-line">{line}</div>
          ))}
          {status === "done" && (
            <div className="skills-dock-log-line skills-dock-log-done">✓ {doneLabel}</div>
          )}
          {status === "error" && (
            <div className="skills-dock-log-line skills-dock-log-error">✗ {errorLabel}</div>
          )}
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        className={`skills-dock-summary${isOpen ? " is-open" : ""}`}
        aria-expanded={isOpen}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={dotClass} aria-hidden="true" />
        <span className={labelClass} aria-live="polite">{label}</span>
        {status === "running" && lines.length > 0 && (
          <span className="skills-dock-count">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
        )}
        {status === "done" && (
          <button
            type="button"
            className="skills-dock-dismiss"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); dismiss(); }}
          >
            ✕
          </button>
        )}
        {status === "error" && onRetry != null && (
          <button
            type="button"
            className="skills-dock-retry"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
          >
            Retry
          </button>
        )}
        <span className={`skills-dock-chevron${isOpen ? " is-open" : ""}`} aria-hidden="true">▾</span>
      </div>
    </div>
  );
}
