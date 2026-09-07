import { useState, type CSSProperties } from "react";

import { useT } from "../i18n/index.js";
import { buildOperationAccents, normalizeAccentKey } from "./operation-accent.js";

// 정체성 톤 피커 — 칩 메뉴·그룹 헤더 메뉴가 공유하는 단일 표면.
// 아홉 색을 한 줄의 스와치로 놓아 한눈에 비교하게 하되, "이름으로도 고른다"는 계약은 버리지 않는다:
// 라벨 오른쪽의 읽기가 겨눈(hover·포커스) 스와치의 이름을 말하고, 각 스와치는 그 이름을 접근 이름으로 진다.
export function AccentToneList({
  label,
  accentKey,
  includeNone,
  onSelect,
}: {
  readonly label: string;
  readonly accentKey: string | null;
  readonly includeNone: boolean;
  readonly onSelect: (accentKey: string | null) => void;
}) {
  const t = useT();
  const accents = buildOperationAccents(t);
  const activeKey = normalizeAccentKey(accentKey);
  const [aimedKey, setAimedKey] = useState<string | null | undefined>(undefined);
  const readoutKey = aimedKey === undefined ? activeKey : aimedKey;
  const readout = readoutKey === null
    ? t("canvas.accent.none")
    : accents.find((accent) => accent.key === readoutKey)?.label ?? "";
  const aim = (key: string | null) => () => setAimedKey(key);
  const unaim = () => setAimedKey(undefined);
  return (
    <>
      <div className="group-context-menu-section-label">
        <span>{label}</span>
        {/* 읽기는 aria-live로 두지 않는다 — 스와치 자신이 이름을 말하므로 두 번 읽힌다. */}
        <span className="group-context-menu-section-readout" aria-hidden="true">{readout}</span>
      </div>
      <div className="accent-swatch-row" role="group" aria-label={label} onPointerLeave={unaim}>
        {includeNone ? (
          <button
            type="button"
            className="accent-swatch accent-swatch--none"
            role="menuitemradio"
            // 키보드 진입점이 accent 섹션을 찾는 근거 — 접근 이름 문구가 바뀌어도 깨지지 않아야 한다.
            data-accent-option="none"
            aria-label={t("canvas.accent.noneAria")}
            aria-checked={activeKey === null}
            onPointerEnter={aim(null)}
            onFocus={aim(null)}
            onBlur={unaim}
            onClick={() => onSelect(null)}
          >
            <span className="accent-swatch__dot" aria-hidden="true" />
          </button>
        ) : null}
        {accents.map((accent) => (
          <button
            key={accent.key}
            type="button"
            className="accent-swatch"
            role="menuitemradio"
            data-accent-option={accent.key}
            aria-label={accent.label}
            aria-checked={activeKey === accent.key}
            style={{ "--accent-swatch-color": accent.color } as CSSProperties}
            onPointerEnter={aim(accent.key)}
            onFocus={aim(accent.key)}
            onBlur={unaim}
            onClick={() => onSelect(accent.key)}
          >
            <span className="accent-swatch__dot" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}
