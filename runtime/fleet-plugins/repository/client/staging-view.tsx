import { useCallback, useEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { CommitResult, DiffFileEntry, StatusResult, WorkstateResult } from "../server/types.js";
import { getT, type RepositoryMessageKey } from "./i18n/index.js";
import { HunkView } from "./hunk-view.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth } from "./rail-layout.js";

type T = Translate<RepositoryMessageKey>;

const LIST_PANE_MIN_WIDTH = 220;
const LIST_PANE_DEFAULT_WIDTH = 248;
const PREFS_LIST_PANE_WIDTH = "fleet-console.diff.listPaneWidth";
// 제품 공용 파괴 동사 무장 시간 — 사이드바 칩·프레임 닫기와 같은 1.5s.
const DISCARD_ARM_MS = 1500;
const NOTICE_MS = 6000;

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly staged: readonly DiffFileEntry[]; readonly unstaged: readonly DiffFileEntry[] }
  | { readonly kind: "error"; readonly message: string };

type Axis = "staged" | "unstaged";
type Selection = { readonly axis: Axis; readonly entry: DiffFileEntry };
export type StagingNotice = { readonly kind: "success" | "error"; readonly text: string };

interface StagingViewProps {
  readonly ctx: RailPanelContext;
  readonly repoRel: string;
  readonly workstate: WorkstateResult | null;
  /** 스테이지·커밋이 저장소를 바꿨을 때 패널 전역(변경 목록·기록·workstate)을 다시 읽게 한다. */
  readonly onMutated: () => void;
}

export function guardMessageOf(workstate: WorkstateResult | null, t: T): string | null {
  if (!workstate) return null;
  if (workstate.indexLock) return t("repository.guard.indexLocked");
  if (workstate.inProgress === "merge") return t("repository.guard.merge");
  if (workstate.inProgress === "rebase") return t("repository.guard.rebase");
  if (workstate.inProgress === "cherry-pick") return t("repository.guard.cherryPick");
  return null;
}

export function stationedMessageOf(workstate: WorkstateResult | null, t: T): string | null {
  const stationed = workstate?.stationedOperations ?? [];
  if (stationed.length === 0) return null;
  return stationed.length === 1
    ? t("repository.guard.stationed_one", { title: stationed[0]!.title })
    : t("repository.guard.stationed_other", { count: stationed.length });
}

function hunkModeOf(selection: Selection): "staged" | "worktree" | "untracked" {
  if (selection.axis === "staged") return "staged";
  return selection.entry.status === "U" ? "untracked" : "worktree";
}

function readListPaneWidth(): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(PREFS_LIST_PANE_WIDTH) ?? "");
    if (Number.isFinite(value) && value > 0) return Math.max(LIST_PANE_MIN_WIDTH, value);
  } catch { /* best-effort preference */ }
  return LIST_PANE_DEFAULT_WIDTH;
}

/**
 * Local Changes 스테이징 뷰 — Fork 문법의 심장부.
 * 왼쪽은 Unstaged/Staged 두 단, 오른쪽은 선택한 축의 diff, 아래는 커밋 상자다.
 */
export function StagingView({ ctx, repoRel, workstate, onMutated }: StagingViewProps) {
  const t = getT(ctx.language);
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [statusRetry, setStatusRetry] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<StagingNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  const guardMessage = guardMessageOf(workstate, t);
  const stationedMessage = stationedMessageOf(workstate, t);
  const writeLocked = guardMessage !== null;

  const showNotice = useCallback((next: StagingNotice) => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    setNotice(next);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, []);
  useEffect(() => () => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
  }, []);

  useEffect(() => {
    if (!ctx.theaterId) { setStatus({ kind: "error", message: "no_theater" }); return; }
    let cancelled = false;
    const seq = ++requestSeqRef.current;
    setStatus((current) => current.kind === "ok" ? current : { kind: "loading" });
    ctx.api.fetch("repository", "status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<StatusResult>;
    }).then((result) => {
      if (cancelled || seq !== requestSeqRef.current) return;
      setStatus({ kind: "ok", staged: result.staged, unstaged: result.unstaged });
      setSelection((current) => {
        if (!current) return current;
        const pool = current.axis === "staged" ? result.staged : result.unstaged;
        const kept = pool.find((entry) => entry.path === current.entry.path);
        return kept ? { axis: current.axis, entry: kept } : null;
      });
    }).catch((error: unknown) => {
      if (cancelled || seq !== requestSeqRef.current) return;
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, repoRel, statusRetry]);

  const reload = useCallback(() => {
    setStatusRetry((value) => value + 1);
    onMutated();
  }, [onMutated]);

  const runVerb = useCallback(async (route: string, body: Record<string, unknown>, mapError?: (code: string) => string | null): Promise<Record<string, unknown> | null> => {
    if (!ctx.theaterId || busy) return null;
    setBusy(true);
    try {
      const response = await ctx.api.fetch("repository", route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...body }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof payload.error === "string" ? payload.error : "git_failed";
        showNotice({ kind: "error", text: mapError?.(code) ?? code });
        return null;
      }
      return payload;
    } catch {
      showNotice({ kind: "error", text: "network" });
      return null;
    } finally {
      setBusy(false);
      reload();
    }
  }, [busy, ctx.api, ctx.theaterId, repoRel, reload, showNotice]);

  const stagePaths = useCallback((paths: readonly string[]) => { void runVerb("stage", { paths }); }, [runVerb]);
  const unstagePaths = useCallback((paths: readonly string[]) => { void runVerb("unstage", { paths }); }, [runVerb]);
  const discardEntry = useCallback((entry: DiffFileEntry) => {
    const body = entry.status === "U" ? { untrackedPaths: [entry.path] } : { paths: [entry.path] };
    void runVerb("discard", body);
  }, [runVerb]);

  const armOrDiscard = useCallback((entry: DiffFileEntry) => {
    if (armedDiscard === entry.path) {
      if (armTimerRef.current !== null) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
      setArmedDiscard(null);
      discardEntry(entry);
      return;
    }
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    setArmedDiscard(entry.path);
    armTimerRef.current = setTimeout(() => {
      armTimerRef.current = null;
      setArmedDiscard(null);
    }, DISCARD_ARM_MS);
  }, [armedDiscard, discardEntry]);

  // Amend를 켜는 순간 HEAD의 제목·본문을 물려받는다 — 빈 칸에서 다시 쓰게 하지 않는 Fork 문법.
  const prefillFromHead = useCallback(() => {
    if (!ctx.theaterId || !workstate?.headSha) return;
    ctx.api.fetch("repository", "commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: workstate.headSha }),
    }).then(async (response) => {
      if (!response.ok) return null;
      return response.json() as Promise<CommitResult>;
    }).then((result) => {
      if (!result) return;
      setSubject((current) => current.trim() === "" ? result.meta.subject : current);
      setBodyText((current) => current.trim() === "" ? result.meta.body : current);
    }).catch(() => undefined);
  }, [ctx.api, ctx.theaterId, repoRel, workstate?.headSha]);

  const toggleAmend = useCallback(() => {
    setAmend((current) => {
      const next = !current;
      if (next) prefillFromHead();
      return next;
    });
  }, [prefillFromHead]);

  const commit = useCallback(async () => {
    const trimmedSubject = subject.trim();
    if (trimmedSubject === "") return;
    const payload = await runVerb("commit-create", {
      subject: trimmedSubject,
      ...(bodyText.trim() ? { message: bodyText.trim() } : {}),
      ...(amend ? { amend: true } : {}),
    }, (code) => code === "identity_missing" ? t("repository.staging.failedIdentity")
      : code === "nothing_to_commit" ? t("repository.staging.failedNothingToCommit")
      : code === "index_locked" ? t("repository.guard.indexLocked")
      : null);
    if (payload) {
      const sha = typeof payload.sha === "string" ? payload.sha.slice(0, 9) : "";
      showNotice({ kind: "success", text: t("repository.staging.committed", { sha }) });
      setSubject("");
      setBodyText("");
      setAmend(false);
    }
  }, [amend, bodyText, runVerb, showNotice, subject, t]);

  const handleDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = listPaneWidthRef.current;
    setIsDragging(true);
    const onMove = (move: PointerEvent) => {
      const next = clampListPaneWidth({ startWidth, dx: move.clientX - startX, containerWidth, listPaneMinWidth: LIST_PANE_MIN_WIDTH, hunkPaneMinWidth: HUNK_PANE_MIN_WIDTH, dividerWidth: DIFF_DIVIDER_WIDTH });
      if (next !== null) {
        listPaneWidthRef.current = next;
        setListPaneWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_LIST_PANE_WIDTH, String(listPaneWidthRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const staged = status.kind === "ok" ? status.staged : [];
  const unstaged = status.kind === "ok" ? status.unstaged : [];
  const commitCount = staged.length;
  const commitDisabled = busy || writeLocked || subject.trim() === "" || (commitCount === 0 && !amend);
  const hunkSelection = selection;

  return <div className="repository-staging">
    {(guardMessage || stationedMessage) && <div className={`repository-staging-guard${guardMessage ? " is-locked" : ""}`} role="status">
      {guardMessage ?? stationedMessage}
    </div>}
    {notice && <div className={`repository-sync-toast is-${notice.kind}`} role="status"><span>{notice.text}</span><button type="button" aria-label={t("repository.sync.dismiss")} onClick={() => setNotice(null)}>✕</button></div>}
    <div ref={rootRef} className={`repository-root repository-staging-root${hunkSelection ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={hunkSelection ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
      <div className="repository-list-pane repository-staging-lists">
        {status.kind === "loading" && <div className="repository-sections-loading">{t("repository.common.loading")}</div>}
        {status.kind === "error" && <div className="repository-sections-error"><span>{status.message}</span><button type="button" className="repository-refresh-btn" onClick={() => setStatusRetry((value) => value + 1)}>{t("repository.common.retry")}</button></div>}
        {status.kind === "ok" && <>
          <StagingSection
            t={t}
            label={t("repository.staging.unstaged")}
            files={unstaged}
            emptyLabel={t("repository.staging.emptyUnstaged")}
            actionLabel={t("repository.staging.stageAll")}
            actionDisabled={busy || writeLocked || unstaged.length === 0}
            onAction={() => stagePaths(unstaged.map((entry) => entry.path))}
            selectedPath={selection?.axis === "unstaged" ? selection.entry.path : null}
            onSelect={(entry) => setSelection({ axis: "unstaged", entry })}
            rowActions={(entry) => <>
              <button
                type="button"
                className={`repository-stage-action repository-discard-action${armedDiscard === entry.path ? " is-armed" : ""}`}
                aria-label={t("repository.staging.discardFile", { path: entry.path })}
                disabled={busy || writeLocked}
                onClick={(event) => { event.stopPropagation(); armOrDiscard(entry); }}
              >{armedDiscard === entry.path ? t("repository.staging.discardArm") : "⌫"}</button>
              <button
                type="button"
                className="repository-stage-action"
                aria-label={t("repository.staging.stageFile", { path: entry.path })}
                disabled={busy || writeLocked}
                onClick={(event) => { event.stopPropagation(); stagePaths([entry.path]); }}
              >+</button>
            </>}
          />
          <StagingSection
            t={t}
            label={t("repository.staging.staged")}
            files={staged}
            emptyLabel={t("repository.staging.emptyStaged")}
            actionLabel={t("repository.staging.unstageAll")}
            actionDisabled={busy || writeLocked || staged.length === 0}
            onAction={() => unstagePaths(staged.map((entry) => entry.path))}
            selectedPath={selection?.axis === "staged" ? selection.entry.path : null}
            onSelect={(entry) => setSelection({ axis: "staged", entry })}
            rowActions={(entry) => <button
              type="button"
              className="repository-stage-action"
              aria-label={t("repository.staging.unstageFile", { path: entry.path })}
              disabled={busy || writeLocked}
              onClick={(event) => { event.stopPropagation(); unstagePaths([entry.path]); }}
            >−</button>}
          />
        </>}
      </div>
      {hunkSelection && <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" />}
      {hunkSelection && <div className="repository-hunk-pane">
        <div className="repository-hunk-head"><span>{hunkSelection.entry.path}</span><button type="button" onClick={() => setSelection(null)}>✕</button></div>
        <HunkView key={`${hunkSelection.axis}:${hunkSelection.entry.path}`} ctx={ctx} repoRel={repoRel} file={hunkSelection.entry} mode={hunkModeOf(hunkSelection)} />
      </div>}
    </div>
    <div className="repository-commit-box">
      <input
        type="text"
        className="repository-commit-subject"
        placeholder={t("repository.staging.subjectPlaceholder")}
        aria-label={t("repository.staging.subjectPlaceholder")}
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !commitDisabled) void commit(); }}
      />
      <textarea
        className="repository-commit-body"
        placeholder={t("repository.staging.bodyPlaceholder")}
        aria-label={t("repository.staging.bodyPlaceholder")}
        rows={2}
        value={bodyText}
        onChange={(event) => setBodyText(event.target.value)}
      />
      <div className="repository-commit-row">
        <label className="repository-commit-amend">
          <input type="checkbox" checked={amend} disabled={busy || writeLocked || !workstate?.headSha} onChange={toggleAmend} />
          {t("repository.staging.amend")}
        </label>
        {workstate?.headBranch && <span className="repository-commit-target">→ {workstate.headBranch}</span>}
        <button type="button" className="repository-commit-button" disabled={commitDisabled} onClick={() => void commit()}>
          {amend ? t("repository.staging.commitAmend") : t(commitCount === 1 ? "repository.staging.commit_one" : "repository.staging.commit_other", { count: commitCount })}
        </button>
      </div>
    </div>
  </div>;
}

function StagingSection({ t, label, files, emptyLabel, actionLabel, actionDisabled, onAction, selectedPath, onSelect, rowActions }: {
  readonly t: T;
  readonly label: string;
  readonly files: readonly DiffFileEntry[];
  readonly emptyLabel: string;
  readonly actionLabel: string;
  readonly actionDisabled: boolean;
  readonly onAction: () => void;
  readonly selectedPath: string | null;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly rowActions: (entry: DiffFileEntry) => React.ReactNode;
}) {
  return <section className="repository-staging-section">
    <div className="repository-staging-head">
      <span>{label}</span>
      <i>{files.length}</i>
      <button type="button" className="repository-staging-bulk" disabled={actionDisabled} onClick={onAction}>{actionLabel}</button>
    </div>
    <div className="repository-staging-rows">
      {files.length === 0
        ? <div className="repository-empty-row">{emptyLabel}</div>
        : files.map((entry) => <StagingFileRow key={`${entry.status}:${entry.path}`} entry={entry} isSelected={entry.path === selectedPath} onSelect={onSelect} actions={rowActions(entry)} />)}
    </div>
  </section>;
}

function StagingFileRow({ entry, isSelected, onSelect, actions }: {
  readonly entry: DiffFileEntry;
  readonly isSelected: boolean;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly actions: React.ReactNode;
}) {
  const trimmed = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
  const lastSlash = trimmed.lastIndexOf("/");
  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : "";
  const name = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed) + (entry.path.endsWith("/") ? "/" : "");
  return <div className={`repository-file-row repository-staging-row${isSelected ? " is-cur" : ""}`}>
    <button type="button" className="repository-staging-row-main" title={entry.path} onClick={() => onSelect(entry)}>
      <span className={`repository-status-glyph repository-status-${entry.status.toLowerCase()}`} aria-hidden="true">{entry.status}</span>
      <span className="repository-file-name">
        <span className="repository-file-fn">{name}</span>
        {dir && <span className="repository-file-dir">{dir}</span>}
      </span>
      <span className="repository-nums">
        {entry.additions > 0 && <span className="repository-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="repository-deletions">−{entry.deletions}</span>}
      </span>
    </button>
    <span className="repository-stage-actions">{actions}</span>
  </div>;
}
