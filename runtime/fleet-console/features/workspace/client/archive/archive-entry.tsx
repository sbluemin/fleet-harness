import { ArchiveGlyph } from "../../../../core/client/src/chrome/components/archive-glyph.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { openArchiveSheet, useOperationArchive } from "../../../../core/client/src/integration/operation-archive.js";

/** 사이드바 맨 아래의 보관함 입구 — 보관한 목록 바로 아래라 「치운 것은 여기 있다」가 한눈에 읽힌다. */
export function ArchiveEntry() {
  const t = useT();
  const { total } = useOperationArchive();
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
        <span className="side-bar-archive-label">{t("archive.title")}</span>
        <span className="side-bar-archive-count">{total}</span>
      </button>
    </div>
  );
}
