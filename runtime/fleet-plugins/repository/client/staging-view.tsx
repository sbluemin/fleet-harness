import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RepositoryContext } from "./repository-context.js";

import type { CommitResult, DiffFileEntry, StatusResult, WorkstateResult } from "../server/types.js";
import { getT, readErrorSentence, type RepositoryMessageKey } from "./i18n/index.js";
import { readCommitDraft, writeCommitDraft } from "./repository-state.js";
import { FilesViewToggle, readFilesViewMode, saveFilesViewMode, type FilesViewMode } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";
import { DiffTreeView } from "./repository-tree.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, clampListPaneWidth } from "./rail-layout.js";

type T = Translate<RepositoryMessageKey>;

const LIST_PANE_MIN_WIDTH = 220;
const LIST_PANE_DEFAULT_WIDTH = 248;
const PREFS_LIST_PANE_WIDTH = "fleet-console.diff.listPaneWidth";
// 제품 공용 파괴 동사 무장 시간 — 사이드바 칩·프레임 닫기와 같은 1.5s.
const DISCARD_ARM_MS = 1500;
const NOTICE_MS = 6000;

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly staged: readonly DiffFileEntry[]; readonly unstaged: readonly DiffFileEntry[]; readonly truncated?: boolean }
  | { readonly kind: "error"; readonly message: string };

type Axis = "staged" | "unstaged";
type Selection = { readonly axis: Axis; readonly entry: DiffFileEntry };
export type StagingNotice = { readonly kind: "success" | "error"; readonly text: string };

interface StagingViewProps {
  readonly ctx: RepositoryContext;
  readonly repoRel: string;
  readonly workstate: WorkstateResult | null;
  /** workstate 읽기가 실패한 상태 — 울타리를 모르는 채로 쓰기를 열어 두지 않는다. */
  readonly stateUnknown?: boolean;
  /** 패널이 로컬 상태를 다시 읽을 때 함께 오르는 토큰 — 이 값이 바뀌면 스테이징 목록도 다시 읽는다. */
  readonly reloadToken?: number;
  readonly onReturnToHistory: () => void;
  readonly onBusyChange: (busy: boolean) => void;
  /** 변이 후 패널 전역 갱신 — history:true는 커밋처럼 기록 축이 실제로 움직인 변이에만 쓴다. */
  readonly onMutated: (options: { readonly history: boolean }) => void;
}

export function guardMessageOf(workstate: WorkstateResult | null, t: T): string | null {
  if (!workstate) return null;
  if (workstate.indexLock) return t("repository.guard.indexLocked");
  if (workstate.inProgress === "merge") return t("repository.guard.merge");
  if (workstate.inProgress === "rebase") return t("repository.guard.rebase");
  if (workstate.inProgress === "cherry-pick") return t("repository.guard.cherryPick");
  return null;
}

function stationedMessageOf(workstate: WorkstateResult | null, t: T): string | null {
  const stationed = workstate?.stationedOperations ?? [];
  if (stationed.length === 0) return null;
  return stationed.length === 1
    ? t("repository.guard.stationed_one", { title: stationed[0]!.title })
    : t("repository.guard.stationed_other", { count: stationed.length });
}

function hunkModeOf(selection: Selection): "staged" | "worktree" | "untracked" {
  if (selection.axis === "staged") return "staged";
  // 충돌 항목은 U를 공유하지만 tracked다 — untracked 축으로 읽으면 전체-추가 허위 diff가 된다.
  if (selection.entry.conflicted) return "worktree";
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
export function StagingView({ ctx, repoRel, workstate, stateUnknown = false, reloadToken = 0, onMutated, onReturnToHistory, onBusyChange }: StagingViewProps) {
  const t = getT(ctx.language);
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [statusRetry, setStatusRetry] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initialDraft] = useState(() => readCommitDraft(ctx.theaterId ?? "", repoRel));
  const [subject, setSubject] = useState(initialDraft?.subject ?? "");
  const [bodyText, setBodyText] = useState(initialDraft?.body ?? "");
  const [amend, setAmend] = useState(initialDraft?.amend ?? false);
  useEffect(() => {
    writeCommitDraft(ctx.theaterId ?? "", repoRel, { subject, body: bodyText, amend });
  }, [ctx.theaterId, repoRel, subject, bodyText, amend]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const [notice, setNotice] = useState<StagingNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 커밋 인스펙터와 같은 선호 키를 읽는다 — 목록/트리는 화면마다 다른 취향이 아니라 한 문법이다.
  const [filesView, setFilesView] = useState<FilesViewMode>(() => readFilesViewMode());
  const chooseFilesView = useCallback((mode: FilesViewMode) => {
    setFilesView(mode);
    saveFilesViewMode(mode);
  }, []);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  // 울타리를 읽지 못한 상태는 "울타리 없음"이 아니다 — 읽기 실패는 닫힌 쪽으로 넘어진다.
  const guardMessage = stateUnknown ? t("repository.guard.stateUnknown") : guardMessageOf(workstate, t);
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
    // api.fetch(assertSafeResponse)는 비2xx에서 payload를 버리고 throw한다 — 오류 코드를 읽어야
    // 하는 경로는 raw fetch를 유지한다(rail-panel의 changed 로더와 같은 결).
    fetch("/plugins/repository/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<StatusResult>;
    }).then((result) => {
      if (cancelled || seq !== requestSeqRef.current) return;
      // 상한에 걸린 상태 목록을 전체로 그리면 "모두 스테이지"가 보이지 않는 나머지를 건드리지 않는다는
      // 사실이 사라진다 — 사용자가 실제로 행동하는 표면이 여기이므로 잘림은 여기서 말해야 한다.
      setStatus({ kind: "ok", staged: result.staged, unstaged: result.unstaged, ...(result.truncated ? { truncated: true } : {}) });
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
  }, [ctx.api, ctx.theaterId, repoRel, reloadToken, statusRetry]);

  const reloadStatus = useCallback(() => {
    setStatusRetry((value) => value + 1);
  }, []);

  // 실패한 동사는 저장소를 바꾸지 않았다 — 상태 목록만 다시 읽고, 전역 갱신(기록·refs 재적재)은
  // 성공한 변이에만 지불한다. 오류 코드는 raw fetch로 읽는다(assertSafeResponse는 payload를 버린다).
  const runVerb = useCallback(async (route: string, body: Record<string, unknown>, mutation: "local" | "history", mapError?: (code: string) => string | null): Promise<Record<string, unknown> | null> => {
    if (!ctx.theaterId || busy) return null;
    setBusy(true);
    try {
      const response = await fetch(`/plugins/repository/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...body }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof payload.error === "string" ? payload.error : "git_failed";
        showNotice({ kind: "error", text: mapError?.(code) ?? code });
        reloadStatus();
        return null;
      }
      reloadStatus();
      onMutated({ history: mutation === "history" });
      return payload;
    } catch {
      showNotice({ kind: "error", text: t("repository.verb.failedNetwork") });
      reloadStatus();
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, ctx.theaterId, onMutated, reloadStatus, repoRel, showNotice, t]);

  const stagePaths = useCallback((paths: readonly string[]) => { void runVerb("stage", { paths }, "local"); }, [runVerb]);
  const stageAll = useCallback(() => { void runVerb("stage", { all: true }, "local"); }, [runVerb]);
  // 리네임(R)은 새 경로만 내리면 옛 경로의 스테이지된 삭제가 남는다 — oldPath를 함께 내린다.
  const unstageEntries = useCallback((entries: readonly DiffFileEntry[]) => {
    const paths = entries.flatMap((entry) => entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]);
    void runVerb("unstage", { paths }, "local");
  }, [runVerb]);
  const unstageAll = useCallback(() => { void runVerb("unstage", { all: true }, "local"); }, [runVerb]);
  const discardEntry = useCallback((entry: DiffFileEntry) => {
    const body = entry.status === "U" && !entry.conflicted ? { untrackedPaths: [entry.path] } : { paths: [entry.path] };
    void runVerb("discard", body, "local");
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
    }, "history", (code) => code === "identity_missing" ? t("repository.staging.failedIdentity")
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
  const clean = status.kind === "ok" && !status.truncated && staged.length === 0 && unstaged.length === 0;
  const showComposer = !clean || amend || subject !== "" || bodyText !== "";

  return <div className="repository-staging">
    {(guardMessage || stationedMessage) && <div className={`repository-staging-guard${guardMessage ? " is-locked" : ""}`} role="status">
      {guardMessage ?? stationedMessage}
    </div>}
    {notice && <div className={`repository-sync-toast is-${notice.kind}`} role="status"><span>{notice.text}</span><button type="button" aria-label={t("repository.sync.dismiss")} onClick={() => setNotice(null)}>✕</button></div>}
    {/* 끌어서 정한 목록 폭은 인라인 grid-template-columns가 아니라 변수로 들어온다 — 인라인 값은
        좁은 폭에서 세로로 쌓는 컨테이너 쿼리를 이겨, 실측에서 본 목록 82px·파일명 폭 0px 붕괴를
        되살린다(독이 이미 같은 이유로 변수를 쓴다). */}
    {clean && !amend ? <div className="repository-staging-empty">
      <span className="repository-staging-clean-mark" aria-hidden="true">✓</span>
      <strong>{t("repository.staging.cleanTitle")}</strong>
      <p>{t("repository.staging.cleanHint")}</p>
      <button type="button" className="repository-refresh-btn" onClick={onReturnToHistory}>{t("repository.staging.viewHistory")}</button>
      {workstate?.headSha && <button type="button" className="repository-staging-amend-entry" disabled={busy || writeLocked} onClick={toggleAmend}>{t("repository.staging.editLastCommit")}</button>}
    </div> : <div ref={rootRef} className={`repository-root repository-staging-root${hunkSelection ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={hunkSelection ? ({ "--staging-list-width": `${listPaneWidth}px` } as CSSProperties) : undefined}>
      <div className="repository-list-pane repository-staging-lists">
        {status.kind === "loading" && <div className="repository-sections-loading">{t("repository.common.loading")}</div>}
        {status.kind === "error" && <div className="repository-sections-error"><span>{readErrorSentence(t, status.message)}</span><button type="button" className="repository-refresh-btn" onClick={() => setStatusRetry((value) => value + 1)}>{t("repository.common.retry")}</button></div>}
        {/* 한 파일이 스테이지·미스테이지 양쪽에 걸리면 parseStatusV2가 두 배열 모두에 넣는다 —
            길이를 더하면 사용자가 찾을 수 있는 파일 수보다 큰 값을 말하게 된다. 경로로 센다. */}
        {status.kind === "ok" && status.truncated && <div className="repository-truncated-note">{t("repository.status.capped", { count: new Set([...staged, ...unstaged].map((entry) => entry.path)).size })}</div>}
        {status.kind === "ok" && <>
          <div className="repository-staging-viewbar">
            <FilesViewToggle mode={filesView} onMode={chooseFilesView} t={t} />
          </div>
          <StagingSection
            t={t}
            view={filesView}
            label={t("repository.staging.unstaged")}
            files={unstaged}
            emptyLabel={t("repository.staging.emptyUnstaged")}
            actionLabel={t("repository.staging.stageAll")}
            actionDisabled={busy || writeLocked || unstaged.length === 0}
            onAction={stageAll}
            selectedPath={selection?.axis === "unstaged" ? selection.entry.path : null}
            onSelect={(entry) => setSelection({ axis: "unstaged", entry })}
            rowActions={(entry) => <>
              {/* 충돌 파일의 discard는 서버에서 무음 no-op이 된다 — 동사를 숨기고 충돌 표식으로 안내한다. */}
              {/* 추적되지 않는 파일의 ⌫는 되돌리기가 아니라 삭제다 — 같은 글리프·같은 문구로 두면
                  두 번째 클릭이 파일을 지운다는 사실이 어디에도 적혀 있지 않다. */}
              {!entry.conflicted && <button
                type="button"
                className={`repository-stage-action repository-discard-action${armedDiscard === entry.path ? " is-armed" : ""}`}
                aria-label={entry.status === "U"
                  ? t("repository.staging.deleteUntracked", { path: entry.path })
                  : t("repository.staging.discardFile", { path: entry.path })}
                title={entry.status === "U"
                  ? t("repository.staging.deleteUntracked", { path: entry.path })
                  : t("repository.staging.discardFile", { path: entry.path })}
                disabled={busy || writeLocked}
                onClick={(event) => { event.stopPropagation(); armOrDiscard(entry); }}
              >{armedDiscard === entry.path
                ? t(entry.status === "U" ? "repository.staging.deleteArm" : "repository.staging.discardArm")
                : <><span aria-hidden="true">⌫</span><span className="repository-stage-action-text">{t(entry.status === "U" ? "repository.staging.actionDelete" : "repository.staging.actionDiscard")}</span></>}</button>}
              <button
                type="button"
                className="repository-stage-action"
                aria-label={t("repository.staging.stageFile", { path: entry.path })}
                title={t("repository.staging.stageFile", { path: entry.path })}
                disabled={busy || writeLocked}
                onClick={(event) => { event.stopPropagation(); stagePaths([entry.path]); }}
              ><span aria-hidden="true">+</span><span className="repository-stage-action-text">{t("repository.staging.actionStage")}</span></button>
            </>}
          />
          <StagingSection
            t={t}
            view={filesView}
            label={t("repository.staging.staged")}
            files={staged}
            emptyLabel={t("repository.staging.emptyStaged")}
            actionLabel={t("repository.staging.unstageAll")}
            actionDisabled={busy || writeLocked || staged.length === 0}
            onAction={unstageAll}
            selectedPath={selection?.axis === "staged" ? selection.entry.path : null}
            onSelect={(entry) => setSelection({ axis: "staged", entry })}
            rowActions={(entry) => <button
              type="button"
              className="repository-stage-action"
              aria-label={t("repository.staging.unstageFile", { path: entry.path })}
                title={t("repository.staging.unstageFile", { path: entry.path })}
              disabled={busy || writeLocked}
              onClick={(event) => { event.stopPropagation(); unstageEntries([entry]); }}
            ><span aria-hidden="true">−</span><span className="repository-stage-action-text">{t("repository.staging.actionUnstage")}</span></button>}
          />
        </>}
      </div>
      {hunkSelection && <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" />}
      {hunkSelection && <div className="repository-hunk-pane">
        {/* 이 머리는 파일명/닫기 클래스를 쓰지 않아 긴 경로가 줄어들지 않고 ✕를 머리 밖으로 밀어냈다
            — 실측에서 ✕는 폭 11px로 오른쪽 경계 142px 바깥에 서 있었다(누를 수 없다). */}
        <div className="repository-hunk-head">
          <span className="repository-hunk-filename" title={hunkSelection.entry.path}>{hunkSelection.entry.path}</span>
          <button type="button" className="repository-hunk-close" aria-label={t("repository.hunk.close")} title={t("repository.hunk.close")} onClick={() => setSelection(null)}>✕</button>
        </div>
        <HunkView key={`${hunkSelection.axis}:${hunkSelection.entry.path}`} ctx={ctx} repoRel={repoRel} file={hunkSelection.entry} mode={hunkModeOf(hunkSelection)} />
      </div>}
    </div>}
    {showComposer && <div className="repository-commit-box">
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
    </div>}
  </div>;
}

function StagingSection({ t, view, label, files, emptyLabel, actionLabel, actionDisabled, onAction, selectedPath, onSelect, rowActions }: {
  readonly t: T;
  readonly view: FilesViewMode;
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
        : view === "tree"
          ? <DiffTreeView files={files} selectedPath={selectedPath} onSelect={onSelect} renderActions={rowActions} conflictLabel={t("repository.staging.conflict")} />
          : files.map((entry) => <StagingFileRow key={`${entry.status}:${entry.path}`} t={t} entry={entry} isSelected={entry.path === selectedPath} onSelect={onSelect} actions={rowActions(entry)} />)}
    </div>
  </section>;
}

function StagingFileRow({ t, entry, isSelected, onSelect, actions }: {
  readonly t: T;
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
        {entry.conflicted && <span className="repository-conflict-chip">{t("repository.staging.conflict")}</span>}
        {entry.additions > 0 && <span className="repository-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="repository-deletions">−{entry.deletions}</span>}
      </span>
    </button>
    <span className="repository-stage-actions">{actions}</span>
  </div>;
}
