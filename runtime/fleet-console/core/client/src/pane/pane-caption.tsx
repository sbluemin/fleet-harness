import { memo, type ReactNode } from "react";

import { CaptionTipHost } from "@fleet-console/sdk/components/caption-actions";

import { useT } from "../i18n/index.js";

/**
 * 페인의 머리 줄.
 *
 * 밴드는 호스트 소유다 — 기하·면·모서리와 이름, 그리고 창을 조작하는 버튼(확대·닫기)은 전부
 * 여기서 그린다. 플러그인이 채우는 것은 `actions` 하나뿐이며, 그 버튼도
 * `@fleet-console/sdk/components/caption-actions`의 프리미티브로 만들어야 한다. 한 줄에 두 벌의
 * 문법이 서지 않게 하려는 것이 이 계약의 전부다.
 *
 * 클래스 이름을 `.pane-caption-*`로 따로 두는 이유는 Operation 프레임의 캡션 밴드와 CSS를
 * 나누기 위해서다. 두 밴드는 같은 문법을 쓰지만 사는 곳이 다르고(캔버스 창 / 표면의 열),
 * `.fleet-caption-*` 규칙은 Operation 밴드 전용을 전제로 잠겨 있다.
 */

export interface PaneCaptionProps {
  readonly title: string;
  readonly paneId: string;
  /** 플러그인이 꽂는 동작 선반. 호스트 버튼 왼쪽에 선다. */
  readonly actions?: ReactNode;
  /** 이 페인을 확대 표면으로 옮길 수 있는가. 없으면 버튼 자체를 그리지 않는다. */
  readonly onExpand?: () => void;
  /** 이 페인을 닫을 수 있는가. primary는 표면과 수명을 같이하므로 보통 없다. */
  readonly onClose?: () => void;
  readonly focused?: boolean;
}

export const PaneCaption = memo(function PaneCaption({
  title,
  paneId,
  actions,
  onExpand,
  onClose,
  focused = false,
}: PaneCaptionProps) {
  const t = useT();

  return (
    <div className={`pane-caption${focused ? " is-focused" : ""}`} data-pane-caption={paneId}>
      <span className="pane-caption-title" id={`pane-caption-${paneId}`} title={title}>{title}</span>
      {actions ? <span className="pane-caption-actions">{actions}</span> : null}
      {onExpand ? (
        <CaptionTipHost label={t("pane.caption.expand")}>
          <button
            type="button"
            className="pane-caption-control"
            aria-label={t("pane.caption.expand")}
            onClick={onExpand}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M9.5 3.5h3v3M6.5 12.5h-3v-3M12.5 3.5 9 7M3.5 12.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </CaptionTipHost>
      ) : null}
      {onClose ? (
        <CaptionTipHost label={t("pane.caption.close")}>
          <button
            type="button"
            className="pane-caption-control"
            aria-label={t("pane.caption.close")}
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>
        </CaptionTipHost>
      ) : null}
    </div>
  );
});
