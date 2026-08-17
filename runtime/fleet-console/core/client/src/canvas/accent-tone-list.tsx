import { useT } from "../i18n/index.js";
import { buildOperationAccents, normalizeAccentKey } from "./operation-accent.js";

// 정체성 톤 선택 리스트 — 팝오버·칩 메뉴·그룹 메뉴 3곳이 공유하는 단일 피커 표면.
// 스와치 그리드 대신 "플래그 + 이름" 행으로, 색이 아니라 이름으로도 고를 수 있게 한다.
export function AccentToneList({
  accentKey,
  includeNone,
  onSelect,
}: {
  readonly accentKey: string | null;
  readonly includeNone: boolean;
  readonly onSelect: (accentKey: string | null) => void;
}) {
  const t = useT();
  const accents = buildOperationAccents(t);
  const activeKey = normalizeAccentKey(accentKey);
  return (
    <>
      {includeNone ? (
        <button
          type="button"
          className="accent-tone-row accent-tone-row--clear"
          role="menuitem"
          // 키보드 진입점이 accent 섹션을 찾는 근거 — 접근 이름 문구가 바뀌어도 깨지지 않아야 한다.
          data-accent-option="none"
          aria-label={t("canvas.accent.noneAria")}
          aria-pressed={activeKey === null}
          onClick={() => onSelect(null)}
        >
          <span className="accent-tone-flag accent-tone-flag--none" aria-hidden="true" />
          <span className="accent-tone-name">{t("canvas.accent.none")}</span>
        </button>
      ) : null}
      {accents.map((accent) => (
        <button
          key={accent.key}
          type="button"
          className="accent-tone-row"
          role="menuitem"
          data-accent-option={accent.key}
          aria-label={accent.label}
          aria-pressed={activeKey === accent.key}
          onClick={() => onSelect(accent.key)}
        >
          <span className="accent-tone-flag" style={{ background: accent.color }} aria-hidden="true" />
          <span className="accent-tone-name">{accent.label}</span>
        </button>
      ))}
    </>
  );
}
