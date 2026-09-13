import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { OperationWorkspace } from "../agent/types.js";
import { locationLine } from "../components/operation-workspace-context.js";
import { formatRelativeTime, useConsoleLocale, useT } from "../i18n/index.js";
import type { OperationMarkVisual } from "../operation-activity.js";

const GAP_PX = 10;
const EDGE_PX = 8;

export interface OperationDetailProps {
  /** 카드를 띄운 칩의 자리. 열 때 한 번 재고, 목록이 움직이면 카드를 닫는 쪽이 소유한다. */
  readonly anchor: DOMRect;
  /** 열려 있는 동안에도 살아 있는 값을 그대로 받는다 — 카드는 스냅샷을 들고 있지 않는다. */
  readonly activity: OperationMarkVisual | undefined;
  readonly workspace: OperationWorkspace | null;
  readonly createdAt: number;
  /** 칩이 `aria-describedby`로 가리키는 id — 포털로 나간 요소는 자동으로 연결되지 않는다. */
  readonly id: string;
}

/**
 * 칩을 겨눴을 때 뜨는 상세 — 칩이 줄이지 못한 사실만 짧게 세 줄로 말한다. 이름은 이미 칩에 있고
 * 카드를 연 사람은 어느 칩을 겨눴는지 알고 있으므로 제목을 다시 얹지 않는다. 읽기 전용이라
 * 초점을 가져가지 않고, 포인터가 지나가도 반응하지 않는다(pointer-events: none).
 */
export function OperationDetailCard({ anchor, activity, workspace, createdAt, id }: OperationDetailProps) {
  const t = useT();
  const locale = useConsoleLocale();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);
  const location = locationLine(workspace);

  // 자리는 카드 크기를 알아야 정해진다 — 그리기 전 프레임에 재고 나서 한 번에 앉힌다.
  // 열린 채로 내용이 바뀌면 높이도 바뀌므로 그때마다 다시 잰다.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const spillRight = anchor.right + GAP_PX + width > window.innerWidth - EDGE_PX;
    const left = spillRight ? Math.max(EDGE_PX, anchor.left - GAP_PX - width) : anchor.right + GAP_PX;
    const wanted = anchor.top + anchor.height / 2 - height / 2;
    const top = Math.min(Math.max(EDGE_PX, wanted), Math.max(EDGE_PX, window.innerHeight - EDGE_PX - height));
    setPlaced({ left, top });
  }, [anchor, activity, location]);

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      className="operation-detail-card"
      role="tooltip"
      style={placed ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="operation-detail-row">
        <span className="operation-detail-key">{t("sidebar.chip.detail.status")}</span>
        <span className="operation-detail-value">{activityLabel(t, activity)}</span>
      </div>
      {location ? (
        <div className="operation-detail-row">
          <span className="operation-detail-key">{t("sidebar.chip.detail.location")}</span>
          <span className="operation-detail-value">{location}</span>
        </div>
      ) : null}
      <div className="operation-detail-row">
        <span className="operation-detail-key">{t("sidebar.chip.detail.started")}</span>
        <span className="operation-detail-value">{formatRelativeTime(createdAt, locale)}</span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 사이드바 STATUS 칸과 같은 어휘를 쓴다 — background는 거기서처럼 실행 중과 한 칸이고,
 * 미확인 도착(unseen)도 칸으로는 대기다. 카드가 칸과 다른 말을 하면 축이 둘로 갈린다.
 */
function activityLabel(t: ReturnType<typeof useT>, activity: OperationMarkVisual | undefined): string {
  switch (activity) {
    case "running":
    case "background":
      return t("sidebar.status.running");
    case "awaiting":
    case "unseen":
      return t("sidebar.status.awaiting");
    case "ended":
      return t("sidebar.chip.detail.ended");
    default:
      return t("sidebar.status.idle");
  }
}
