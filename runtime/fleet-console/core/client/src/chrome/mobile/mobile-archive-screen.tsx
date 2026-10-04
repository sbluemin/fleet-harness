import { useEffect, useRef, useState } from "react";

import { restoreOperationCluster } from "@fleet-console/sdk/operations/browser";
import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { formatRelativeTime } from "../../i18n/format.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { fetchOperations } from "../../integration/api.js";
import { refreshOperationArchive, useOperationArchive } from "../../integration/operation-archive.js";
import { hydrateOperations, getState } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { setMobileDestination } from "./mobile-store.js";
import { showMobileToast } from "./mobile-toast.js";

/**
 * 보관함(S-40) — 보관한 Operation이 한 줄씩 선다: 끝남 글리프, 제목, 「Theater · 언제 보관」, 복원 알약.
 * 폰에서는 복원만 한다(영구 삭제는 데스크톱). 🔍는 작업 검색으로 간다(D34: 보관함 안 검색은 데스크톱 시트에 남는다).
 */
export function MobileArchiveScreen({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const locale = useConsoleLocale();
  const archive = useOperationArchive();
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(false);

  useEffect(() => { void refreshOperationArchive(); }, []);
  useClaimMobileBar({
    variant: "centered",
    title: t("mobile.drawer.archive"),
    leading: "menu",
    actions: [{ id: "search", icon: <MobileIcon name="search" />, label: t("mobile.archive.search"), run: () => setMobileDestination({ kind: "search" }) }],
  });

  const entries = (archive.snapshot?.entries ?? []).filter((entry) => !restored.has(entry.operation.id));
  const restore = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    try {
      const result = await restoreOperationCluster(id);
      hydrateOperations([...getState().operations.filter((node) => node.id !== id), ...result.operations]);
      setRestored((previous) => new Set(previous).add(id));
      showMobileToast(t("mobile.toast.restored"));
      await fetchOperations(null).then(hydrateOperations).catch(() => undefined);
      await refreshOperationArchive();
    } catch {
      showMobileToast(t("mobile.archive.restoreFailed"));
    } finally { busyRef.current = false; setBusy(null); }
  };

  return (
    <section className="mobile-archive-screen">
      {entries.length === 0 ? <p className="mobile-attention-empty">{archive.loading ? t("common.loading") : t("mobile.archive.empty")}</p> : (
        <div className="mobile-group">
          {entries.map((entry) => {
            const theater = state.theaters.find((item) => item.id === entry.operation.theaterId);
            return (
              <div className="mobile-group-row is-two" key={entry.operation.id}>
                <span className={statusGlyphClassName("ended")} aria-hidden="true" />
                <span className="mobile-group-row-copy">{entry.operation.title}<small>{[theater?.label, entry.archivedAt ? t("mobile.archive.when", { time: formatRelativeTime(entry.archivedAt, locale) }) : null].filter(Boolean).join(" · ")}</small></span>
                <button type="button" className="mobile-pill-secondary" disabled={busy !== null} onClick={() => void restore(entry.operation.id)}>
                  <MobileIcon name="copy" size={16} />{t("mobile.archive.restore")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="mobile-secnote">{t("mobile.archive.note")}</p>
    </section>
  );
}
