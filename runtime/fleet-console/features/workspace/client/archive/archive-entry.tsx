import { useCallback, useSyncExternalStore } from "react";

import type { ArchiveSectionDescriptor } from "@fleet-console/sdk/plugin";

import { ArchiveGlyph } from "@fleet-console/sdk/components/archive-glyph";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { openArchiveSheet, useOperationArchive } from "../../../../core/client/src/integration/operation-archive.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";

export interface ArchiveSectionCount {
  readonly section: ArchiveSectionDescriptor;
  readonly count: number;
}

/**
 * 플러그인 보관함 칸과 활성 Theater에서의 수. 칸마다 자기 저장소를 구독하므로, 수가 바뀔 때만 다시 그린다 —
 * 스냅숏은 수의 나열이라 같은 수면 같은 문자열이다.
 */
export function useArchiveSections(query = "", theaterIds?: readonly string[]): readonly ArchiveSectionCount[] {
  const { archiveSections } = usePluginRegistry();
  const registeredIds = useConsoleState().theaters.map((theater) => theater.id);
  const idsKey = JSON.stringify(theaterIds ?? registeredIds);
  const subscribe = useCallback((listener: () => void) => {
    const offs = archiveSections.map((section) => section.subscribe(listener));
    return () => { for (const off of offs) off(); };
  }, [archiveSections]);
  const snapshot = useCallback(() => {
    const ids = JSON.parse(idsKey) as (string | null)[];
    return archiveSections.map((section) => ids.reduce((sum, id) => sum + section.count(id, query), 0)).join(",");
  }, [archiveSections, idsKey, query]);
  const counts = useSyncExternalStore(subscribe, snapshot, snapshot);
  const values = counts ? counts.split(",").map(Number) : [];
  return archiveSections.map((section, index) => ({ section, count: values[index] ?? 0 }));
}

/** 보관함 전체 수 — 보관한 Operation과 플러그인 칸의 수를 더한다. */
function useArchiveTotal(): { readonly total: number; readonly sections: readonly ArchiveSectionCount[] } {
  const { totalsByTheater } = useOperationArchive();
  const sections = useArchiveSections();
  return { total: Object.values(totalsByTheater).reduce((sum, count) => sum + count, 0) + sections.reduce((sum, entry) => sum + entry.count, 0), sections };
}

/** 아바타 메뉴의 보관함 입구 — 공급자별 보관함을 포함한 전체 수를 배지 없이 오른쪽에 둔다. */
export function ArchiveMenuItem({ onBeforeOpen }: { readonly onBeforeOpen: () => void }) {
  const t = useT();
  const { total } = useArchiveTotal();
  return <button type="button" role="menuitem" className="conversation-dock-archive" aria-label={t("archive.entryAria", { count: total })} aria-haspopup="dialog" onClick={() => { onBeforeOpen(); openArchiveSheet(); }}>
    <ArchiveGlyph />
    <span className="conversation-dock-label">{t("archive.title")}</span>
    <span className="conversation-dock-count" aria-hidden="true">{total}</span>
  </button>;
}
