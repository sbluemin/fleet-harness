import { React } from "../react/browser.js";

/**
 * 사용자에게 도달하는 실패의 공통 형태.
 *
 * 실패는 세 조각을 갖는다 — 무슨 일이 있었나(`title`), 왜(`cause`), 지금 할 수 있는 일(`actions`).
 * 기계 코드와 HTTP 상태는 그 셋 중 어느 것도 아니므로 `diagnostic`으로 내려가고, 문장 자리를
 * 차지하지 않는다. 코드를 이 형태로 옮기는 매핑은 그 코드를 아는 쪽(호스트 또는 플러그인)이
 * 소유한다 — SDK는 형태와 외양만 고정한다.
 */
export interface FailureNoticeAction {
  readonly label: string;
  readonly onSelect: () => void;
  /** 사용자가 이 실패에서 벗어나는 가장 곧은 길. 표면당 하나만 둔다. */
  readonly primary?: boolean;
}

export interface FailureNoticeProps {
  readonly title: string;
  readonly cause?: string;
  readonly actions?: readonly FailureNoticeAction[];
  /** 기계 코드·HTTP 상태처럼 사람이 읽는 문장이 아닌 근거. 지원 문의에만 쓰인다. */
  readonly diagnostic?: string;
  /** 상태 채널만 탄다 — 되돌릴 수 있으면 warn, 진행이 막혔으면 coral. */
  readonly tone?: "warn" | "coral";
  readonly className?: string;
}

export function FailureNotice({
  title,
  cause,
  actions,
  diagnostic,
  tone = "warn",
  className,
}: FailureNoticeProps): React.ReactElement {
  const rootClassName = ["fc-failure", `fc-failure--${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={rootClassName} role="alert">
      <p className="fc-failure__title">{title}</p>
      {cause ? <p className="fc-failure__cause">{cause}</p> : null}
      {actions && actions.length > 0 ? (
        <div className="fc-failure__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.primary ? "fc-failure__action fc-failure__action--primary" : "fc-failure__action"}
              onClick={action.onSelect}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {diagnostic ? <p className="fc-failure__diagnostic">{diagnostic}</p> : null}
    </div>
  );
}
