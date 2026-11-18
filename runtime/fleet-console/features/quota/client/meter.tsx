export type MeterSeverity = "normal" | "warning" | "critical";

export interface UsageMeterProps {
  readonly label: string;
  /** 퍼센트를 모르면(예: 예산 없는 지출) 막대와 퍼센트를 그리지 않는다. */
  readonly percent?: number;
  /** 막대·퍼센트의 접근 이름. `percent`가 있을 때만 쓴다. */
  readonly usedText?: string;
  readonly severity?: MeterSeverity;
  readonly labelTitle?: string;
  /** 막대 아래 한 줄 — 창이면 소진 예측, 지출이면 금액. */
  readonly note?: string | null;
  readonly projection?: { readonly left: number; readonly width: number } | null;
  readonly projectionTitle?: string;
  readonly elapsedMark?: number | null;
  readonly elapsedTitle?: string;
  readonly resetText?: string;
  readonly resetTitle?: string;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * 한도 창과 지출이 공유하는 미터 형상 — 라벨·막대·퍼센트·리셋과 그 아래 한 줄.
 *
 * 값의 출처는 다르지만(`QuotaWindow`와 `ProviderSpend`) 읽는 형상이 갈리면 같은 화면의 두 카드가
 * 다른 문법으로 말한다. 값이 없는 쪽(예: 예산 없는 지출)은 `percent`를 비워 막대·퍼센트만 걷는다.
 */
export function UsageMeter(props: UsageMeterProps) {
  const {
    label,
    percent,
    usedText,
    severity = "normal",
    labelTitle,
    note,
    projection,
    projectionTitle,
    elapsedMark,
    elapsedTitle,
    resetText,
    resetTitle,
  } = props;
  return (
    <div className={`quota-meter quota-meter--${severity}`}>
      <div className="quota-meter__top">
        <span className="quota-meter__label" title={labelTitle ?? label}>{label}</span>
        {note != null ? <span className="quota-meter__forecast">{note}</span> : null}
      </div>
      {percent !== undefined ? (
        <div
          className="quota-meter__bar"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          {...(usedText !== undefined && note != null ? { "aria-valuetext": `${usedText} · ${note}` } : {})}
        >
          {projection != null ? (
            <span
              className="quota-meter__projection"
              title={projectionTitle}
              style={{ left: `${projection.left}%`, width: `${projection.width}%` }}
            />
          ) : null}
          <span className="quota-meter__fill" style={{ width: `${clampPercent(percent)}%` }} />
          {elapsedMark != null ? (
            <span
              className="quota-meter__elapsed"
              title={elapsedTitle}
              style={{ left: `${elapsedMark}%` }}
            />
          ) : null}
        </div>
      ) : null}
      <div className="quota-meter__foot">
        {percent !== undefined ? <span className="quota-meter__percent" aria-label={usedText}>{Math.round(percent)}%</span> : null}
        {resetText !== undefined ? (
          <span className="quota-meter__reset" title={resetTitle ?? resetText}>{resetText}</span>
        ) : null}
      </div>
    </div>
  );
}
