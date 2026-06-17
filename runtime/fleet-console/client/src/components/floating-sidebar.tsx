import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { createTheaterTerminalSession, renameTerminalSession, resumeTerminalSession, terminateTerminalSession } from "../api.js";
import { ensureDefaultGeometry, focusPanel, useMaximized } from "../canvas/canvas-store.js";
import { OperationLaunchMenu } from "./operation-launch-menu.js";
import { describeJobStatus, formatCarrierName, sessionDisplayLabel, shortJobId, statusTone } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { applySessionUpdate, beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, failRenameTerminalSession, failResumeTerminalSession, failTerminateTerminalSession, removeTerminalSession, selectJob, selectTerminalSession, sessionJobs, theaterSessionOrder } from "../store.js";
import type { SessionJob } from "../store.js";
import type { AgentCliMetadata, ConsoleState, JobView, SessionInfo } from "../types.js";

interface FloatingSidebarProps {
  readonly state: ConsoleState;
  readonly getViewportSize: () => { readonly width: number; readonly height: number } | null;
}

interface FloatingSessionEntryProps {
  readonly session: SessionInfo;
  readonly active: boolean;
  readonly jobs: readonly SessionJob[];
  readonly selectedJobId: string | null;
  readonly onFocus: (sessionId: string) => void;
}

interface FloatingJobEntryProps {
  readonly job: JobView;
  readonly active: boolean;
}

export function FloatingSidebar({ state, getViewportSize }: FloatingSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const maximized = useMaximized();
  const visibleSessionOrder = theaterSessionOrder(state);

  // 맵 최대화(전체화면) 시 Operations 패널을 자동으로 접고, 해제하면 다시 펼친다.
  useEffect(() => {
    setCollapsed(maximized);
  }, [maximized]);

  const focusSession = async (sessionId: string) => {
    const session = state.sessions[sessionId];
    let focusedSessionId = sessionId;
    if (session?.status === "dormant") {
      try {
        const resumed = await resumeTerminalSession(sessionId);
        applySessionUpdate(resumed);
        focusedSessionId = resumed.sessionId;
      } catch (error) {
        failResumeTerminalSession(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    selectTerminalSession(focusedSessionId);
    ensureDefaultGeometry(focusedSessionId);
    const viewportSize = getViewportSize();
    if (viewportSize) focusPanel(focusedSessionId, viewportSize);
  };

  const launchSession = async (cli: AgentCliMetadata) => {
    if (state.creatingTerminalSession || state.addingTheater || !state.activeTheaterId) return;
    beginCreateTerminalSession();
    try {
      const session = await createTheaterTerminalSession(state.activeTheaterId, cli.id);
      completeCreateTerminalSession(session);
      void focusSession(session.sessionId);
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };

  // 접힘: OPERATIONS 패널 전체를 제거하고, 화면 왼쪽에 고정된 펼치기 버튼만 남긴다.
  if (collapsed) {
    return (
      <aside className="floating-sidebar-layer is-collapsed" data-canvas-blocker>
        <button
          type="button"
          className="floating-sidebar-collapsed-toggle"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label="Operations 목록 펼치기"
          title="Show Operations"
        >
          <ExpandListIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="floating-sidebar-layer" data-canvas-blocker>
      <section className="floating-sidebar" aria-label="Floating operations list">
        <div className="floating-sidebar-heading">
          <p className="sidebar-eyebrow">Operations</p>
          <div className="floating-sidebar-actions">
            <OperationLaunchMenu state={state} onSelect={launchSession} />
            <button
              type="button"
              className="floating-sidebar-toggle"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              aria-label="Operations 목록 접기"
            >
              <CollapseListIcon />
            </button>
          </div>
        </div>
        {visibleSessionOrder.length > 0 ? (
          <ol className="floating-session-list">
            {visibleSessionOrder.map((sessionId) => {
              const session = state.sessions[sessionId];
              if (!session) return null;
              return (
                <FloatingSessionEntry
                  key={sessionId}
                  session={session}
                  active={state.activeTerminalSessionId === sessionId}
                  jobs={sessionJobs(state, session)}
                  selectedJobId={state.selectedJobId}
                  onFocus={focusSession}
                />
              );
            })}
          </ol>
        ) : null}
        {state.terminalSessionError ? <p className="sidebar-error">{state.terminalSessionError}</p> : null}
        {visibleSessionOrder.length === 0 ? (
          <p className="sidebar-empty">
            {state.activeTheaterId ? "No operations in this Theater." : "No Theaters registered."}
            <br />
            {state.activeTheaterId ? "Drag on the canvas or use +." : "Add a Theater from the top bar."}
          </p>
        ) : null}
      </section>
    </aside>
  );
}

const FloatingSessionEntry = memo(function FloatingSessionEntry({ session, active, jobs, selectedJobId, onFocus }: FloatingSessionEntryProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const activeCount = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).length;
  const dormant = session.status === "dormant";
  const live = activeCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  const displayLabel = sessionDisplayLabel(session);
  const orderedJobs = [...jobs].sort((a, b) => Number(isTerminalJobStatus(a.job.status)) - Number(isTerminalJobStatus(b.job.status)));

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const beginRename = () => {
    skipBlurCommitRef.current = false;
    setDraftLabel(displayLabel);
    setRenaming(true);
  };

  const cancelRename = () => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setDraftLabel("");
  };

  const commitRename = async () => {
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      applySessionUpdate(await renameTerminalSession(session.sessionId, draftLabel));
    } catch (error) {
      failRenameTerminalSession(error instanceof Error ? error.message : String(error));
    } finally {
      committingRef.current = false;
      skipBlurCommitRef.current = true;
      setRenaming(false);
    }
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  return (
    <li className={`session-item ${active ? "is-active" : ""}`}>
      <div className="session-row-shell">
        {renaming ? (
          <div className={`session-row session-row-edit ${active ? "is-active" : ""}`}>
            <span className={`tenant-beacon ${live ? "is-live" : dormant ? "is-dormant" : ""}`} aria-hidden="true" />
            <input
              ref={inputRef}
              className="session-rename-input"
              value={draftLabel}
              aria-label={`${displayLabel} 이름 변경`}
              onChange={(event) => setDraftLabel(event.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={() => {
                if (skipBlurCommitRef.current) {
                  skipBlurCommitRef.current = false;
                  return;
                }
                void commitRename();
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`session-row ${active ? "is-active" : ""}`}
            onClick={() => { onFocus(session.sessionId); }}
            onDoubleClick={beginRename}
            aria-current={active || undefined}
            aria-label={`Operation ${displayLabel}`}
          >
            <span className={`tenant-beacon ${live ? "is-live" : dormant ? "is-dormant" : ""}`} aria-hidden="true" />
            <span className="tenant-row-text">
              <span className="tenant-label">{displayLabel}</span>
              {dormant ? <span className="job-row-meta">Dormant</span> : null}
            </span>
            {dormant ? <span className="tenant-count">Open</span> : !active && jobs.length > 0 ? <span className="tenant-count">{jobs.length}</span> : null}
          </button>
        )}
        <button
          type="button"
          className="session-close"
          onClick={() => { void closeSession(session.sessionId); }}
          aria-label={`${dormant ? "Forget" : "Terminate"} operation ${displayLabel}`}
          title={dormant ? "Forget operation" : "Terminate operation"}
        >
          <CloseIcon />
        </button>
      </div>
      {active ? (
        <ol className="session-job-list">
          {orderedJobs.length > 0 ? (
            orderedJobs.map(({ job }) => <FloatingJobEntry key={job.jobId} job={job} active={job.jobId === selectedJobId} />)
          ) : (
            <li className="job-list-empty">No carrier jobs in this session.</li>
          )}
        </ol>
      ) : null}
    </li>
  );
});

const FloatingJobEntry = memo(function FloatingJobEntry({ job, active }: FloatingJobEntryProps) {
  const tone = statusTone(job.status);
  return (
    <li>
      <button
        type="button"
        className={`job-row ${active ? "is-active" : ""}`}
        onClick={() => selectJob(job.jobId)}
        aria-current={active || undefined}
      >
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        <span className="job-row-text">
          <span className="job-row-label">{job.label ?? shortJobId(job.jobId)}</span>
          <span className="job-row-meta">
            {job.ownerCarrierId ? `${formatCarrierName(job.ownerCarrierId)} · ${describeJobStatus(job.status)}` : describeJobStatus(job.status)}
          </span>
        </span>
      </button>
    </li>
  );
});

async function closeSession(sessionId: string): Promise<void> {
  try {
    await terminateTerminalSession(sessionId);
  } catch (error) {
    failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
    return;
  }
  removeTerminalSession(sessionId);
}

function CollapseListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 5h8M4 8h5.5M4 11h8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function ExpandListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 4.6 9 8l-4 3.4M10.5 4.6 14 8l-3.5 3.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  // Operation 종료 — 기존 sidebar X 마크와 같은 stroke 언어를 유지한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
