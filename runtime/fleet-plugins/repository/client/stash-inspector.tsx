import { useCallback, useEffect, useRef, useState } from "react";

import type { RepositoryContext } from "./repository-context.js";

import type { DiffFileEntry } from "../server/types.js";
import { FileRow } from "./changed-files.js";
import { getT, readErrorSentence } from "./i18n/index.js";

// 제품 공용 파괴 동사 무장 시간 — 스테이징 버리기·프레임 닫기와 같은 1.5s.
const DROP_ARM_MS = 1500;

/** show가 돌려준 원시 상태 문자를 목록 행의 상태 축으로 좁힌다 — 복사(C)는 새 경로 추가로 읽는다. */
function readShownStatus(raw: string): DiffFileEntry["status"] {
  return raw === "A" || raw === "D" || raw === "R" || raw === "T" || raw === "U" ? raw : raw === "C" ? "A" : "M";
}

type StashShowState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly files: readonly DiffFileEntry[]; readonly truncated?: boolean }
  | { readonly kind: "error"; readonly message: string };

export interface StashInspectorTarget {
  readonly name: string;
  readonly sha: string;
  readonly subject: string;
}

/**
 * 스태시 전용 카드 — 커밋 인스펙터가 untracked 스태시를 "변경된 파일 0"으로 보여 주던 함정(M3)의
 * 대체 표면이다. 치워 둔 파일(untracked 포함)과 출구(적용/적용 후 제거/삭제)를 한 카드에 붙인다.
 */
export function StashInspector({ ctx, repoRel, stash, workspace, onAction, onClose }: {
  readonly ctx: RepositoryContext;
  readonly repoRel: string;
  readonly stash: StashInspectorTarget;
  readonly workspace: boolean;
  readonly onAction?: ((action: "apply" | "pop" | "drop", name: string, sha: string) => Promise<boolean>) | undefined;
  readonly onClose: () => void;
}) {
  const t = getT(ctx.language);
  const [state, setState] = useState<StashShowState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [dropArmed, setDropArmed] = useState(false);
  const dropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ctx.theaterId) { setState({ kind: "error", message: "no_theater" }); return; }
    let cancelled = false;
    setState({ kind: "loading" });
    // 오류 코드(stash_moved 등)를 읽어야 하는 경로는 raw fetch — api.fetch는 비2xx payload를 버린다.
    fetch("/plugins/repository/stash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, action: "show", name: stash.name, sha: stash.sha }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { readonly files?: readonly { readonly status: string; readonly path: string }[]; readonly truncated?: boolean; readonly error?: string };
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "git_failed");
      // 카드 목록은 상태·경로만 그린다 — show는 수치를 세지 않으므로 0을 "수치 없음"으로 쓴다(FileRow는 0을 숨긴다).
      const files: DiffFileEntry[] = (payload.files ?? []).map((entry) => ({ path: entry.path, status: readShownStatus(entry.status), additions: 0, deletions: 0 }));
      return { files, truncated: payload.truncated === true };
    }).then(({ files, truncated }) => {
      if (cancelled) return;
      setState({ kind: "ok", files, ...(truncated ? { truncated: true } : {}) });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.theaterId, repoRel, stash.name, stash.sha]);
  useEffect(() => () => { if (dropTimerRef.current !== null) clearTimeout(dropTimerRef.current); }, []);

  const run = useCallback(async (action: "apply" | "pop" | "drop") => {
    if (!onAction || busy) return;
    setBusy(true);
    try {
      const succeeded = await onAction(action, stash.name, stash.sha);
      // 스태시가 목록에서 사라지는 동사만 카드를 접는다 — apply는 스태시가 남으므로 계속 볼 수 있어야 한다.
      if (succeeded && action !== "apply") onClose();
    } finally {
      setBusy(false);
    }
  }, [busy, onAction, onClose, stash.name, stash.sha]);

  const handleDrop = useCallback(() => {
    if (dropArmed) {
      if (dropTimerRef.current !== null) { clearTimeout(dropTimerRef.current); dropTimerRef.current = null; }
      setDropArmed(false);
      void run("drop");
      return;
    }
    setDropArmed(true);
    if (dropTimerRef.current !== null) clearTimeout(dropTimerRef.current);
    dropTimerRef.current = setTimeout(() => {
      dropTimerRef.current = null;
      setDropArmed(false);
    }, DROP_ARM_MS);
  }, [dropArmed, run]);

  return <div className={`history-inspector repository-stash-inspector${workspace ? " repository-ws-inspector" : ""}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div className="history-segmented repository-stash-inspector-head">
      <span className="repository-stash-inspector-title">{t("repository.stash.cardTitle")}</span>
      <span className="repository-stash-inspector-name">{stash.name}</span>
      <button type="button" className="history-detail-close history-inspector-close" aria-label={t("repository.history.closeInspector")} title={t("repository.history.closeInspector")} onClick={onClose}>✕</button>
    </div>
    <div className="repository-stash-inspector-body">
      <div className="repository-stash-inspector-subject" title={stash.subject}>{stash.subject}</div>
      <div className="history-files-title">
        <span className="history-files-label">{t("repository.stash.cardFiles")}</span>
        {state.kind === "ok" && <span className="history-files-stats">{state.files.length}</span>}
      </div>
      <div className="history-files-scroll">
        {state.kind === "loading" && <div className="history-inspector-empty">{t("repository.common.loading")}</div>}
        {state.kind === "error" && <div className="history-inspector-empty history-inspector-error">{state.message === "stash_moved" ? t("repository.stash.moved") : `${t("repository.stash.showFailed")} ${readErrorSentence(t, state.message)}`}</div>}
        {state.kind === "ok" && state.files.length === 0 && <div className="history-inspector-empty">{t("repository.history.noChangedFiles")}</div>}
        {state.kind === "ok" && state.files.map((file) => <FileRow key={file.path} entry={file} isSelected={false} onSelect={() => undefined} t={t} />)}
        {state.kind === "ok" && state.truncated && <div className="history-truncated">{t("repository.commit.capped")}</div>}
      </div>
      {onAction && <div className="repository-stash-inspector-actions">
        <button type="button" className="repository-refresh-btn" disabled={busy} onClick={() => void run("apply")}>{t("repository.stash.apply")}</button>
        <button type="button" className="repository-refresh-btn" disabled={busy} onClick={() => void run("pop")}>{t("repository.stash.pop")}</button>
        <button type="button" className={`repository-refresh-btn repository-stash-inspector-drop${dropArmed ? " is-armed" : ""}`} disabled={busy} onClick={handleDrop}>{dropArmed ? t("repository.stash.dropArm") : t("repository.stash.drop")}</button>
      </div>}
    </div>
  </div>;
}
