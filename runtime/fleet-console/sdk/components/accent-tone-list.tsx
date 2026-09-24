import { useState, type CSSProperties } from "react";

import { IDENTITY_TONES, normalizeIdentityTone, type IdentityTone } from "../operations/identity-tones.js";

/**
 * 정체성 톤 피커 — Operation 강조색과 그룹 색을 고르는 한 줄의 스와치.
 *
 * 사이드바의 칩·그룹 메뉴와 플러그인(목표 표면의 그룹 메뉴)이 **같은 모듈에서** 가져다 써서, 같은 조작이 두 벌의 모양으로
 * 태어나지 않게 한다. 클래스 이름은 이 모듈이 고정하고 실제 규칙은 코어 `components.css` 가 적는다.
 *
 * 여덟 색을 한 줄에 놓아 한눈에 비교하게 하되 「이름으로도 고른다」는 계약은 버리지 않는다: 라벨 오른쪽의 읽기가 겨눈
 * (hover·포커스) 스와치의 이름을 말하고, 각 스와치는 그 이름을 접근 이름으로 진다. 문구는 호출자의 언어로 받는다.
 */
export interface AccentToneListLabels {
  /** 톤 이름 — 스와치의 접근 이름이자 읽기. */
  readonly tone: (key: IdentityTone) => string;
  /** 「없음」의 읽기와 접근 이름 — `includeNone` 일 때만 쓴다. */
  readonly none?: string;
  readonly noneAria?: string;
}

export function AccentToneList({
  label,
  accentKey,
  includeNone,
  labels,
  onSelect,
}: {
  readonly label: string;
  /** 지금 값 — 저장된 구키는 가장 가까운 톤으로 읽는다. */
  readonly accentKey: string | null;
  readonly includeNone: boolean;
  readonly labels: AccentToneListLabels;
  readonly onSelect: (accentKey: IdentityTone | null) => void;
}) {
  const activeKey = normalizeIdentityTone(accentKey);
  const [aimedKey, setAimedKey] = useState<IdentityTone | null | undefined>(undefined);
  const readoutKey = aimedKey === undefined ? activeKey : aimedKey;
  const readout = readoutKey === null ? labels.none ?? "" : labels.tone(readoutKey);
  const aim = (key: IdentityTone | null) => () => setAimedKey(key);
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
            aria-label={labels.noneAria ?? labels.none ?? ""}
            aria-checked={activeKey === null}
            onPointerEnter={aim(null)}
            onFocus={aim(null)}
            onBlur={unaim}
            onClick={() => onSelect(null)}
          >
            <span className="accent-swatch__dot" aria-hidden="true" />
          </button>
        ) : null}
        {IDENTITY_TONES.map((key) => (
          <button
            key={key}
            type="button"
            className="accent-swatch"
            role="menuitemradio"
            data-accent-option={key}
            aria-label={labels.tone(key)}
            aria-checked={activeKey === key}
            style={{ "--accent-swatch-color": `var(--id-${key})` } as CSSProperties}
            onPointerEnter={aim(key)}
            onFocus={aim(key)}
            onBlur={unaim}
            onClick={() => onSelect(key)}
          >
            <span className="accent-swatch__dot" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}
