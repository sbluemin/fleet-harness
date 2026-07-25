import { useCallback, useEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { SkillsMessageKey } from "./i18n/index.js";
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
  readonly t: Translate<SkillsMessageKey>;
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
  t,
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
          // 자식 버튼(Dismiss/Retry)에서 버블링된 키 이벤트가 도크 토글을 삼키지 않도록,
          // 요약 바 자체에 포커스가 있을 때만 Enter/Space를 처리한다.
          if (e.target !== e.currentTarget) return;
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
            {t(lines.length === 1 ? "skills.status.lines_one" : "skills.status.lines_other", {
              count: lines.length,
            })}
          </span>
        )}
        {status === "done" && (
          <button
            type="button"
            className="skills-dock-dismiss"
            aria-label={t("skills.action.dismiss")}
            onClick={(e) => { e.stopPropagation(); dismiss(); }}
          >
            ✕
          </button>
        )}
        {status === "error" && (
          // error는 자동소멸하지 않으므로, Retry(있으면)와 함께 수동 해제용 ✕를 항상 제공한다.
          <>
            {onRetry != null && (
              <button
                type="button"
                className="skills-dock-retry"
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
              >
                {t("skills.action.retry")}
              </button>
            )}
            <button
              type="button"
              className="skills-dock-dismiss"
              aria-label={t("skills.action.dismiss")}
              onClick={(e) => { e.stopPropagation(); dismiss(); }}
            >
              ✕
            </button>
          </>
        )}
        <span className={`skills-dock-chevron${isOpen ? " is-open" : ""}`} aria-hidden="true">▾</span>
      </div>
    </div>
  );
}
