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

/**
 * Zen 작업 표시줄의 보관함 입구 — 캔버스 모드 스위치 바로 오른쪽의 글리프 단독 버튼. Cruise·War Room 막대가 같은 부품을 쓴다.
 * 이름과 수는 title·aria-label이 말한다. 비어 있어도 사이드바 입구처럼 누를 수 있고, 잉크만 한 단계 낮춘다.
 */
export function ArchiveTaskbarEntry() {
  const t = useT();
  const { total } = useOperationArchive();
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
