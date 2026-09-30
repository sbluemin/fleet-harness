import { useCallback, useSyncExternalStore } from "react";

import type { ArchiveSectionDescriptor } from "@fleet-console/sdk/plugin";

import { ArchiveGlyph } from "../../../../core/client/src/chrome/components/archive-glyph.js";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
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
export function useArchiveSections(): readonly ArchiveSectionCount[] {
  const { archiveSections } = usePluginRegistry();
  const theaterId = useConsoleState().activeTheaterId;
  const subscribe = useCallback((listener: () => void) => {
    const offs = archiveSections.map((section) => section.subscribe(listener));
    return () => { for (const off of offs) off(); };
  }, [archiveSections]);
  const snapshot = useCallback(() => archiveSections.map((section) => section.count(theaterId)).join(","), [archiveSections, theaterId]);
  const counts = useSyncExternalStore(subscribe, snapshot, snapshot);
  const values = counts ? counts.split(",").map(Number) : [];
  return archiveSections.map((section, index) => ({ section, count: values[index] ?? 0 }));
}

/** 보관함 전체 수 — 보관한 Operation과 플러그인 칸의 수를 더한다. */
function useArchiveTotal(): { readonly total: number; readonly sections: readonly ArchiveSectionCount[] } {
  const { total } = useOperationArchive();
  const sections = useArchiveSections();
  return { total: total + sections.reduce((sum, entry) => sum + entry.count, 0), sections };
}

/** 사이드바 맨 아래의 보관함 입구 — 보관한 목록 바로 아래라 「치운 것은 여기 있다」가 한눈에 읽힌다. */
export function ArchiveEntry() {
  const t = useT();
  const locale = useConsoleLocale();
  const { total, sections } = useArchiveTotal();
  // 「보관함 · 완료 1 · 정리된 목표 1」 — 빈 칸은 말하지 않는다.
  const parts = sections.filter((entry) => entry.count > 0).map((entry) => `${entry.section.title(locale)} ${entry.count}`);
  return (
    <div className="side-bar-archive">
      <button
        type="button"
        className="side-bar-archive-button"
        onClick={openArchiveSheet}
        aria-label={t("archive.entryAria", { count: total })}
        aria-haspopup="dialog"
      >
        <span className="side-bar-archive-glyph" aria-hidden="true"><ArchiveGlyph /></span>
        <span className="side-bar-archive-label">
          {t("archive.title")}
          {parts.map((part) => <span key={part} className="side-bar-archive-part"> · {part}</span>)}
        </span>
        <span className="side-bar-archive-count">{total}</span>
      </button>
    </div>
  );
}

/**
 * Zen 작업 표시줄의 보관함 입구 — 캔버스 모드 스위치 바로 오른쪽의 글리프 단독 버튼. Cruise·War Room 막대가 같은 부품을 쓴다.
 * 이름과 수는 title·aria-label이 말한다. 비어 있어도 사이드바 입구처럼 누를 수 있고, 잉크만 한 단계 낮춘다.
 */
export function ArchiveTaskbarEntry() {
  const t = useT();
  const { total } = useArchiveTotal();
  const label = t("archive.entryAria", { count: total });
  return (
    <button
      type="button"
      className={`zen-taskbar-archive${total === 0 ? " is-empty" : ""}`}
      onClick={openArchiveSheet}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
    >
      <ArchiveGlyph strokeWidth={1.125} />
    </button>
  );
}
