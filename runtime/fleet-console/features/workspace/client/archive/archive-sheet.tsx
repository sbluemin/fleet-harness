import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  previewOperationPurge,
  purgeArchivedOperations,
  restoreOperationCluster,
  readOperationLaunch,
  type OperationDescription,
  type OperationPurgeConfirmation,
} from "@fleet-console/sdk/operations/browser";

import { ArchiveGlyph } from "../../../../core/client/src/chrome/components/archive-glyph.js";
import { formatRelativeTime, useConsoleLocale, useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { closeArchiveSheet, refreshOperationArchive, useOperationArchive } from "../../../../core/client/src/integration/operation-archive.js";
import { fetchOperations } from "../../../../core/client/src/integration/api.js";
import { getState, hydrateOperations, setActiveOperation, setActiveTheater } from "../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";

/**
 * 보관함 — 보관한 Operation을 조회·복원·영구 삭제하는 한 곳. 사이드바 맨 아래 「보관함 N」, Zen 작업 표시줄의
 * 보관함 글리프, ⌘P 명령 모드의 「보관함 열기」, 보관 토스트의 「보관함」이 모두 이 시트를 연다.
 *
 * 항목은 Cluster 하나다: 상위 Operation 아래 하위 Operation을 들여 쓰고, Theater·그룹·보관 시각을 밝힌다.
 * 복원은 늘 Cluster 전체를 휴면으로 돌리고 세션을 자동 실행하지 않는다. 영구 삭제는 여기서만 한다.
 * 이 화면에는 어떤 플러그인의 개념도 나오지 않는다 — Core가 아는 부모·하위 관계만 쓴다.
 */

const DAY_MS = 86_400_000;
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ArchiveCluster {
  readonly rootId: string;
  readonly root: OperationDescription;
  readonly members: readonly { readonly id: string; readonly title: string }[];
  readonly archivedAt: number;
}

function clustersOf(entries: readonly OperationDescription[]): readonly ArchiveCluster[] {
  return entries.map((root) => ({
      rootId: root.operation.id,
      root,
      members: (root.operation.childSessions ?? []).map((child) => ({ id: child.id, title: readOperationLaunch(child.payload).sessionName ?? child.id.slice(0, 8) })),
      archivedAt: root.archivedAt ?? 0,
    }))
    .sort((a, b) => b.archivedAt - a.archivedAt);
}

type Bucket = "today" | "week" | "earlier";
function bucketOf(archivedAt: number, now: number): Bucket {
  const age = now - archivedAt;
  return age < DAY_MS ? "today" : age < 7 * DAY_MS ? "week" : "earlier";
}
const BUCKET_KEY: Readonly<Record<Bucket, CoreMessageKey>> = { today: "archive.bucket.today", week: "archive.bucket.week", earlier: "archive.bucket.earlier" };

export function ArchiveSheet() {
  const archive = useOperationArchive();
  if (!archive.sheetOpen) return null;
  return <ArchiveSheetDialog />;
}

function ArchiveSheetDialog() {
  const t = useT();
  const archive = useOperationArchive();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 방금 영구 삭제한 항목과 그 자리 — 목록을 다시 읽어 항목이 사라진 뒤 포커스를 같은 자리의 다음 항목으로 옮긴다.
  const [purged, setPurged] = useState<{ readonly rootId: string; readonly index: number } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<CoreMessageKey | null>(null);

  // 시트는 모달이다 — 뒤 Console을 inert로 두되, 다른 오버레이가 먼저 걸어 둔 상태를 되돌려 놓는다.
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previousInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    dialogRef.current?.focus();
    return () => {
      if (shell) shell.inert = previousInert;
    };
  }, []);
  useEffect(() => () => {
    const target = returnFocusRef.current;
    if (target?.isConnected) target.focus();
  }, []);

  const clusters = clustersOf(archive.snapshot?.entries ?? []);

  // 영구 삭제한 항목이 목록에서 빠지면 포커스가 사라진 항목과 함께 BODY로 빠지고 Esc가 시트에 닿지 않는다.
  // 같은 자리에 선 다음 항목(마지막이었다면 새 마지막 항목)의 「영구 삭제…」로, 남은 항목이 없으면 시트로 옮긴다.
  useLayoutEffect(() => {
    if (!purged || clusters.some((cluster) => cluster.rootId === purged.rootId)) return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(".archive-sheet-item") ?? [];
    const next = items.length > 0 ? items[Math.min(purged.index, items.length - 1)]?.querySelector<HTMLElement>(".archive-sheet-purge") : null;
    (next ?? dialogRef.current)?.focus();
    setPurged(null);
  });
  const now = Date.now();

  const restore = (cluster: ArchiveCluster) => {
    if (restoring) return;
    setRestoring(cluster.rootId);
    setNotice(null);
    void restoreOperationCluster(cluster.rootId)
      .then(async (result) => {
        await fetchOperations(null).then(hydrateOperations).catch(() => {});
        void refreshOperationArchive();
        // 복원한 결과를 보도록 시트를 닫고 그 Cluster의 상위 Operation으로 간다.
        const restored = getState().operations.find((operation) => operation.id === result.rootOperationId);
        closeArchiveSheet();
        if (restored) {
          if (getState().activeTheaterId !== restored.theaterId) setActiveTheater(restored.theaterId);
          setActiveOperation(restored.id);
        }
      })
      .catch((error: unknown) => {
        const code = error instanceof ApiError ? error.message : "";
        setNotice(code === "restore_parent_missing" ? "archive.notice.restoreParentMissing" : "archive.notice.restoreFailed");
        void refreshOperationArchive();
      })
      .finally(() => setRestoring(null));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeArchiveSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (active === dialogRef.current || !dialogRef.current?.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };

  let lastBucket: Bucket | null = null;
  return createPortal(
    <div className="archive-sheet-scrim" onMouseDown={closeArchiveSheet}>
      <div
        ref={dialogRef}
        className="archive-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-sheet-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="archive-sheet-head">
          <span className="archive-sheet-glyph" aria-hidden="true"><ArchiveGlyph /></span>
          <h2 id="archive-sheet-title">{t("archive.title")}</h2>
          <span className="archive-sheet-count">{archive.total}</span>
          <button type="button" className="archive-sheet-close" onClick={closeArchiveSheet} aria-label={t("archive.closeAria")}>✕</button>
        </header>
        {notice ? <p className="archive-sheet-notice" role="status">{t(notice)}</p> : null}
        <div className="archive-sheet-body">
          {clusters.length === 0 ? (
            <p className="archive-sheet-empty">{archive.loading && archive.snapshot === null ? t("archive.loading") : archive.error && archive.snapshot === null ? t("archive.loadFailed") : t("archive.empty")}</p>
          ) : clusters.map((cluster, index) => {
            const bucket = bucketOf(cluster.archivedAt, now);
            const head = bucket !== lastBucket ? <h3 className="archive-sheet-bucket">{t(BUCKET_KEY[bucket])}</h3> : null;
            lastBucket = bucket;
            return (
              <div key={cluster.rootId} className="archive-sheet-section">
                {head}
                <ArchiveClusterItem
                  cluster={cluster}
                  now={now}
                  restoring={restoring === cluster.rootId}
                  currentRevision={archive.revision}
                  onRestore={() => restore(cluster)}
                  onPurgeStart={() => setNotice(null)}
                  onPurgeRefused={setNotice}
                  onPurged={() => {
                    // 목록이 갱신될 때까지 포커스를 시트에 둔다 — 사라질 항목으로 돌려보내지 않는다.
                    setPurged({ rootId: cluster.rootId, index });
                    dialogRef.current?.focus();
                    void refreshOperationArchive();
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ArchiveClusterItem({ cluster, now, restoring, currentRevision, onRestore, onPurgeStart, onPurgeRefused, onPurged }: {
  readonly cluster: ArchiveCluster;
  readonly now: number;
  readonly restoring: boolean;
  readonly currentRevision: number;
  readonly onRestore: () => void;
  readonly onPurgeStart: () => void;
  readonly onPurgeRefused: (notice: CoreMessageKey) => void;
  readonly onPurged: () => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const rootOperation = cluster.root.operation;
  const title = rootOperation.title;
  const theaterId = rootOperation.theaterId;
  const theaterLabel = state.theaters.find((theater) => theater.id === theaterId)?.label ?? null;
  const groupId = rootOperation?.groupId ?? null;
  const group = groupId ? state.groups.find((candidate) => candidate.id === groupId) ?? null : null;
  const groupLost = groupId !== null && group === null;
  const kids = cluster.members.length;
  const meta = [
    theaterLabel,
    group ? group.name : t("archive.meta.ungrouped"),
    t("archive.meta.archivedAt", { when: formatRelativeTime(cluster.archivedAt, locale, now) }),
    kids > 0 ? t("archive.meta.children", { count: kids }) : null,
  ].filter((part): part is string => !!part).join(" · ");

  // 한 줄 항목 — 왼쪽은 이름과 메타(하위가 있으면 그 목록과 복원 안내), 오른쪽 끝은 복원·영구 삭제가 나란히 선다.
  return (
    <article className="archive-sheet-item" aria-label={title}>
      <div className="archive-sheet-item-main">
        <p className="archive-sheet-item-title" title={title}>{title}</p>
        <p className="archive-sheet-item-meta">{meta}</p>
        {kids > 0 ? (
          <ul className="archive-sheet-members">
            {cluster.members.map((member) => <li key={member.id} className="is-child"><span>{member.title}</span></li>)}
          </ul>
        ) : null}
        {groupLost ? <p className="archive-sheet-note">{t("archive.note.groupLost")}</p> : null}
        {kids > 0 ? <p className="archive-sheet-note">{t("archive.note.withChildren", { count: kids })}</p> : null}
      </div>
      <div className="archive-sheet-actions">
        <button type="button" className="archive-sheet-restore" onClick={onRestore} disabled={restoring}>{t("archive.restore")}</button>
        <ArchivePurgeButton
          targetId={cluster.rootId}
          title={title}
          currentRevision={currentRevision}
          preview={previewOperationPurge}
          purge={purgeArchivedOperations}
          onStart={onPurgeStart}
          onRefused={onPurgeRefused}
          onPurged={onPurged}
        />
      </div>
    </article>
  );
}

/**
 * 영구 삭제 — 한 번 누르면 확인 없이 지운다. 서버에서 대상 집합과 revision을 받아(preview) 그대로 확정 요청에
 * 싣고, 그 사이 보관함이 바뀌었으면(클라이언트가 먼저 알든 서버가 409로 알리든) 아무것도 지우지 않고 알린다.
 */
export function ArchivePurgeButton({ targetId, title, currentRevision, preview, purge, onStart, onRefused, onPurged }: {
  readonly targetId: string;
  readonly title: string;
  readonly currentRevision: number;
  readonly preview: (operationId: string) => Promise<OperationPurgeConfirmation>;
  readonly purge: (confirmation: OperationPurgeConfirmation) => Promise<unknown>;
  readonly onStart: () => void;
  readonly onRefused: (notice: CoreMessageKey) => void;
  readonly onPurged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 요청 중 도착한 최신 revision을 읽는다 — 누른 순간의 값에 묶이면 그 사이의 변경을 놓친다.
  const revisionRef = useRef(currentRevision);
  revisionRef.current = currentRevision;

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onStart();
    let notice: CoreMessageKey | null = null;
    try {
      const confirmation = await preview(targetId);
      // 보관함이 바뀌었다 — 본 적 없는 대상까지 지울 수 있으니 확정하지 않는다.
      if (revisionRef.current >= 0 && revisionRef.current !== confirmation.revision) notice = "archive.notice.purgeStale";
      else await purge(confirmation);
    } catch (error) {
      notice = error instanceof ApiError && error.message === "archive_revision_conflict" ? "archive.notice.purgeStale" : "archive.notice.purgeFailed";
    }
    busyRef.current = false;
    setBusy(false);
    if (notice) onRefused(notice);
    else onPurged();
  };

  return (
    <button
      type="button"
      className="archive-sheet-purge"
      onClick={() => { void run(); }}
      // 지우는 동안에도 disabled로 두지 않는다 — 포커스가 BODY로 빠지면 Esc·Tab이 시트에 닿지 않는다.
      aria-disabled={busy || undefined}
      aria-label={t("archive.purgeAria", { title })}
    >
      {t("archive.purge")}
    </button>
  );
}
