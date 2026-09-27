import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  previewOperationPurge,
  purgeArchivedOperations,
  restoreOperationCluster,
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
 * 보관함 — 보관한 Operation을 조회·복원·영구 삭제하는 한 곳. 사이드바 맨 아래 「보관함 N」, ⌘K 「보관함 열기」,
 * 보관 토스트의 「보관함」이 모두 이 시트를 연다.
 *
 * 항목은 Cluster 하나다: 상위 Operation 아래 하위 Operation을 들여 쓰고, Theater·그룹·보관 시각을 밝힌다.
 * 복원은 늘 Cluster 전체를 휴면으로 돌리고 세션을 자동 실행하지 않는다. 영구 삭제는 여기서만 한다.
 * 이 화면에는 어떤 플러그인의 개념도 나오지 않는다 — Core가 아는 부모·하위 관계만 쓴다.
 */

const DAY_MS = 86_400_000;
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ArchiveCluster {
  readonly rootId: string;
  /** 보관된 최상위 노드. 상위만 열려 있고 하위만 보관된 부분 보관이면 null. */
  readonly root: OperationDescription | null;
  readonly members: readonly OperationDescription[];
  readonly archivedAt: number;
}

function clustersOf(entries: readonly OperationDescription[]): readonly ArchiveCluster[] {
  const byRoot = new Map<string, OperationDescription[]>();
  for (const entry of entries) {
    const list = byRoot.get(entry.rootOperationId) ?? [];
    list.push(entry);
    byRoot.set(entry.rootOperationId, list);
  }
  return [...byRoot.entries()]
    .map(([rootId, list]) => {
      const root = list.find((entry) => entry.operation.id === rootId) ?? null;
      const members = list.filter((entry) => entry.operation.id !== rootId).sort((a, b) => a.operation.title.localeCompare(b.operation.title));
      return { rootId, root, members, archivedAt: Math.max(...list.map((entry) => entry.archivedAt ?? 0)) };
    })
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
  const [confirmingRoot, setConfirmingRoot] = useState<string | null>(null);
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
      if (confirmingRoot !== null) setConfirmingRoot(null);
      else closeArchiveSheet();
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
          ) : clusters.map((cluster) => {
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
                  confirming={confirmingRoot === cluster.rootId}
                  currentRevision={archive.revision}
                  onRestore={() => restore(cluster)}
                  onAskPurge={() => { setNotice(null); setConfirmingRoot(cluster.rootId); }}
                  onCancelPurge={() => setConfirmingRoot(null)}
                  onPurged={() => { setConfirmingRoot(null); void refreshOperationArchive(); }}
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

function ArchiveClusterItem({ cluster, now, restoring, confirming, currentRevision, onRestore, onAskPurge, onCancelPurge, onPurged }: {
  readonly cluster: ArchiveCluster;
  readonly now: number;
  readonly restoring: boolean;
  readonly confirming: boolean;
  readonly currentRevision: number;
  readonly onRestore: () => void;
  readonly onAskPurge: () => void;
  readonly onCancelPurge: () => void;
  readonly onPurged: () => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const activeRoot = cluster.root === null ? state.operations.find((operation) => operation.id === cluster.rootId) ?? null : null;
  const rootOperation = cluster.root?.operation ?? activeRoot;
  const rootOpen = cluster.root === null;
  const title = rootOperation?.title ?? cluster.members[0]?.operation.title ?? cluster.rootId;
  const theaterId = rootOperation?.theaterId ?? cluster.members[0]?.operation.theaterId ?? null;
  const theaterLabel = state.theaters.find((theater) => theater.id === theaterId)?.label ?? null;
  const groupId = rootOperation?.groupId ?? null;
  const group = groupId ? state.groups.find((candidate) => candidate.id === groupId) ?? null : null;
  const groupLost = groupId !== null && group === null;
  const archivedCount = cluster.members.length + (cluster.root ? 1 : 0);
  const kids = cluster.members.length;
  const meta = [
    theaterLabel,
    group ? group.name : t("archive.meta.ungrouped"),
    t("archive.meta.archivedAt", { when: formatRelativeTime(cluster.archivedAt, locale, now) }),
    rootOpen ? t("archive.meta.childrenOnly", { count: kids }) : kids > 0 ? t("archive.meta.children", { count: kids }) : null,
  ].filter((part): part is string => !!part).join(" · ");

  return (
    <article className={`archive-sheet-item${confirming ? " is-confirming" : ""}`} aria-label={title}>
      <p className="archive-sheet-item-title">{title}</p>
      <p className="archive-sheet-item-meta">{meta}</p>
      {kids > 0 || rootOpen ? (
        <ul className="archive-sheet-members">
          {rootOpen && rootOperation ? <li className="is-open"><span>{rootOperation.title}</span><small>{t("archive.member.open")}</small></li> : null}
          {cluster.members.map((member) => <li key={member.operation.id} className="is-child"><span>{member.operation.title}</span></li>)}
        </ul>
      ) : null}
      {confirming ? (
        <ArchivePurgeConfirm
          targetId={cluster.rootId}
          fallbackCount={archivedCount}
          currentRevision={currentRevision}
          preview={previewOperationPurge}
          purge={purgeArchivedOperations}
          onCancel={onCancelPurge}
          onPurged={onPurged}
        />
      ) : (
        <>
          <div className="archive-sheet-actions">
            <button type="button" className="archive-sheet-restore" onClick={onRestore} disabled={restoring}>{t("archive.restore")}</button>
            <button type="button" className="archive-sheet-purge" onClick={onAskPurge}>{t("archive.purge")}</button>
          </div>
          {groupLost ? <p className="archive-sheet-note">{t("archive.note.groupLost")}</p> : null}
          {rootOpen ? <p className="archive-sheet-note">{t("archive.note.underOpenParent")}</p> : kids > 0 ? <p className="archive-sheet-note">{t("archive.note.withChildren", { count: kids })}</p> : null}
        </>
      )}
    </article>
  );
}

type PurgeStage =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly confirmation: OperationPurgeConfirmation }
  | { readonly kind: "busy"; readonly confirmation: OperationPurgeConfirmation }
  | { readonly kind: "stale" }
  | { readonly kind: "failed" };

/**
 * 영구 삭제 확인 — 되돌릴 수 없는 유일한 동작이라 안전장치를 겹겹이 둔다.
 * - 확인할 대상 집합과 revision을 먼저 서버에서 받아(preview) 그대로 확정 요청에 싣는다.
 * - 초기 포커스는 「취소」다. 「영구 삭제」는 따로 눌러야 하고, 키를 누르고 있어 생기는 반복 입력은 받지 않는다.
 * - 카드를 연 뒤 보관함이 바뀌면(revision이 달라지면) 확정을 거절하고 다시 열게 한다. 서버도 같은 이유로 거절한다.
 * - 지우는 범위는 Console이 가진 것만 밝힌다.
 */
export function ArchivePurgeConfirm({ targetId, fallbackCount, currentRevision, preview, purge, onCancel, onPurged }: {
  readonly targetId: string;
  readonly fallbackCount: number;
  readonly currentRevision: number;
  readonly preview: (operationId: string) => Promise<OperationPurgeConfirmation>;
  readonly purge: (confirmation: OperationPurgeConfirmation) => Promise<unknown>;
  readonly onCancel: () => void;
  readonly onPurged: () => void;
}) {
  const t = useT();
  const [stage, setStage] = useState<PurgeStage>({ kind: "loading" });
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    void preview(targetId)
      .then((confirmation) => { if (alive) setStage({ kind: "ready", confirmation }); })
      .catch(() => { if (alive) setStage({ kind: "failed" }); });
    return () => { alive = false; };
  }, [preview, targetId]);
  useLayoutEffect(() => { cancelRef.current?.focus(); }, []);

  const confirm = () => {
    if (stage.kind !== "ready") return;
    // 확인한 뒤 보관함이 바뀌었다 — 본 적 없는 대상까지 지울 수 있으니 확정하지 않는다.
    if (currentRevision >= 0 && currentRevision !== stage.confirmation.revision) {
      setStage({ kind: "stale" });
      return;
    }
    const confirmation = stage.confirmation;
    setStage({ kind: "busy", confirmation });
    void purge(confirmation)
      .then(() => onPurged())
      .catch((error: unknown) => {
        const code = error instanceof ApiError ? error.message : "";
        setStage(code === "archive_revision_conflict" ? { kind: "stale" } : { kind: "failed" });
      });
  };

  const count = stage.kind === "ready" || stage.kind === "busy" ? stage.confirmation.operationIds.length : fallbackCount;
  return (
    <div className="archive-purge-confirm" role="alertdialog" aria-labelledby={`archive-purge-${targetId}`}>
      <p id={`archive-purge-${targetId}`} className="archive-purge-title">{t("archive.purgeConfirm.title")}</p>
      <p className="archive-purge-label">{t("archive.purgeConfirm.removes")}</p>
      <ul>
        <li>{count > 1 ? t("archive.purgeConfirm.removesOperations", { count }) : t("archive.purgeConfirm.removesOperation")}</li>
        <li>{t("archive.purgeConfirm.removesFiles")}</li>
      </ul>
      <p className="archive-purge-label">{t("archive.purgeConfirm.keeps")}</p>
      <ul>
        <li>{t("archive.purgeConfirm.keepsWork")}</li>
        <li>{t("archive.purgeConfirm.keepsTranscripts")}</li>
      </ul>
      <p className="archive-sheet-note">{t("archive.purgeConfirm.toolsNote")}</p>
      {stage.kind === "stale" ? <p className="archive-purge-error" role="status">{t("archive.purgeConfirm.stale")}</p> : null}
      {stage.kind === "failed" ? <p className="archive-purge-error" role="status">{t("archive.purgeConfirm.failed")}</p> : null}
      <div className="archive-purge-row">
        <button
          type="button"
          className="archive-purge-confirm-button"
          disabled={stage.kind !== "ready"}
          onClick={confirm}
          onKeyDownCapture={(event) => {
            // 키를 누르고 있는 반복 입력은 확정으로 받지 않는다.
            if (event.repeat && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {t("archive.purgeConfirm.confirm")}
        </button>
        <button ref={cancelRef} type="button" className="archive-purge-cancel" onClick={onCancel}>{t("archive.purgeConfirm.cancel")}</button>
      </div>
    </div>
  );
}
