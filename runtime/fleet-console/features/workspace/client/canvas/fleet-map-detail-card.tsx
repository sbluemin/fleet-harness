import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useTheaterLabel } from "../../../../core/client/src/hooks/use-store.js";
import type { OperationNode } from "../../../../core/client/src/integration/types.js";
import { useAgentState } from "../../../execution/client/agent/store.js";
import { readAgentChatSessionCoordinates } from "../../../execution/client/agent/chat/session-coordinates.js";
import type { OperationWorkspace } from "../../../execution/client/agent/types.js";
import { OperationStatusIcon } from "../../../execution/client/components/operation-status-icon.js";
import { locationLine } from "../../../execution/client/components/operation-workspace-context.js";
import type { OperationMarkVisual } from "../../../execution/client/operation-activity.js";

const GAP_PX = 10;
const EDGE_PX = 8;
const MIN_WIDTH_PX = 168;
const MAX_WIDTH_PX = 300;

/** 카드가 말하는 상태 — 지도 점의 마크 축에 "모른다"를 더한다. 점은 모름을 표시 어휘로 접어 그리지만 카드는 접지 않는다. */
export type FleetMapDetailStatus = OperationMarkVisual | "unknown";

interface FleetMapDetailCardProps {
  readonly id: string;
  readonly operation: OperationNode;
  readonly status: FleetMapDetailStatus;
  /** 카드를 띄운 점. 열 때 잰 자리가 기준이고, 지도가 움직이면 카드를 닫는 쪽(지도)이 소유한다. */
  readonly anchor: DOMRect;
  /** 카드가 머물 수 있는 판(지도 영역). 창 안쪽 여백과 교차해 쓴다. */
  readonly bounds: DOMRect;
  /** 가리지 않으려는 이웃 점들의 자리. */
  readonly obstacles: readonly DOMRect[];
}

/**
 * 함대 지도의 점을 겨눴을 때 뜨는 읽기 전용 카드 — 지도 이름표가 줄인 제목 전체와, 점이 색으로만 말하던
 * 상태, 세션이 도는 자리(Theater·폴더·브랜치)와 모델을 말한다. 사이드바 상세 카드와 같은 재료·문법이지만
 * 두 가지가 다르다: 지도의 이름표는 잘리므로 제목을 다시 싣고, 입력 대기와 미확인 완료를 접지 않는다.
 * 시간·출력 조각·조작은 싣지 않는다. 포인터를 받지 않고 초점을 가져가지 않는다.
 */
export function FleetMapDetailCard({ id, operation, status, anchor, bounds, obstacles }: FleetMapDetailCardProps) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);
  // 열린 카드 하나만 세션 스토어를 구독한다 — 점마다 구독하면 지도 전체가 세션 갱신마다 다시 그려진다.
  const workspace: OperationWorkspace | null = useAgentState().sessions[operation.id]?.workspace ?? null;
  const theaterLabel = useTheaterLabel(operation.theaterId);
  const coordinates = readAgentChatSessionCoordinates(operation.payload);
  const location = workspace?.outside
    ? workspace.folder ? t("canvas.fleetMap.detail.outside", { folder: `…/${workspace.folder}` }) : null
    : locationLine(workspace, theaterLabel) ?? theaterLabel;
  const branch = workspace?.branch ?? null;
  // 모델 이름이 없으면 줄 자체를 내린다 — 서버 기본값을 추측해 이름을 채우지 않는다.
  const model = coordinates.model
    ? [
        coordinates.model,
        coordinates.effort,
        operation.payload?.chatMode === true ? t("canvas.fleetMap.detail.chat") : t("canvas.fleetMap.detail.terminal"),
      ].filter(Boolean).join(" · ")
    : null;

  // 자리는 카드 크기를 알아야 정해진다 — 그리기 전 프레임에 재고 한 번에 앉힌다. 내용이 바뀌면 다시 잰다.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const area = {
      left: Math.max(bounds.left, 0) + EDGE_PX,
      top: Math.max(bounds.top, 0) + EDGE_PX,
      right: Math.min(bounds.right, window.innerWidth) - EDGE_PX,
      bottom: Math.min(bounds.bottom, window.innerHeight) - EDGE_PX,
    };
    const measure = (maxWidth: number) => {
      card.style.maxWidth = `${Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, maxWidth))}px`;
      const { width, height } = card.getBoundingClientRect();
      return { width, height };
    };
    const placement = resolveFleetMapDetailPlacement({ anchor, area, measure, obstacles });
    // 후보를 재느라 바꾼 폭을 고른 자리의 폭으로 되돌린다 — 스타일 값이 지난번과 같으면 React가 다시 쓰지 않는다.
    measure(placement.maxWidth);
    setPlaced(placement);
  }, [anchor, bounds, obstacles, status, location, branch, model, operation.title]);

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      className="operation-detail-card fleet-map-detail-card"
      role="tooltip"
      style={placed ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      <p className="fleet-map-detail-title">{operation.title}</p>
      <div className="operation-detail-row">
        <span className="operation-detail-key">{t("sidebar.chip.detail.status")}</span>
        <span className={`operation-detail-value fleet-map-detail-status is-${status}`}>
          {status === "unknown"
            ? <span className="tenant-beacon" aria-hidden="true" />
            : <OperationStatusIcon status={status} decorative />}
          {t(`canvas.fleetMap.detail.status.${status}`)}
        </span>
      </div>
      {location ? (
        <div className="operation-detail-row">
          <span className="operation-detail-key">{t("sidebar.chip.detail.location")}</span>
          <span className="operation-detail-value">
            {location}
            {branch ? (
              <span className="fleet-map-detail-branch">
                <BranchGlyph />
                <span>{branch}</span>
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {model ? (
        <div className="operation-detail-row">
          <span className="operation-detail-key">{t("canvas.fleetMap.detail.model")}</span>
          <span className="operation-detail-value">{model}</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

interface PlacementArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface CardSize {
  readonly width: number;
  readonly height: number;
}

interface Placement {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
}

/**
 * 오른쪽 → 왼쪽 → 위 → 아래 순서로 자리를 본다. 옆자리는 그쪽 여유가 카드 최소 폭 이상이면 여유만큼 폭을
 * 줄여 실제로 다시 재고, 위·아래는 판 폭으로 재서 들어갈 때만 후보가 된다. 판에 온전히 들어가는 후보 가운데
 * 이웃 점을 가리지 않는 첫 자리를 쓰고, 모두 가리면 가장 적게 가리는 자리를 쓴다. 좁은 판에서 폭을 줄인
 * 자리도 같은 비교를 거친다 — 넓은 쪽이라는 이유만으로 피할 수 있는 가림을 고르지 않는다.
 * 트리거 점 자신은 어느 후보도 덮지 않는다(간격 10px 바깥).
 */
function resolveFleetMapDetailPlacement({ anchor, area, measure, obstacles }: {
  readonly anchor: DOMRect;
  readonly area: PlacementArea;
  readonly measure: (maxWidth: number) => CardSize;
  readonly obstacles: readonly DOMRect[];
}): Placement {
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
  const areaWidth = area.right - area.left;
  const areaHeight = area.bottom - area.top;
  const rightRoom = area.right - (anchor.right + GAP_PX);
  const leftRoom = anchor.left - GAP_PX - area.left;

  type Candidate = Placement & CardSize & { readonly fits: boolean };
  const candidates: Candidate[] = [];
  const sideTop = (height: number) => clamp(centerY - height / 2, area.top, area.bottom - height);
  const addSide = (room: number, leftFor: (size: CardSize) => number) => {
    if (room < MIN_WIDTH_PX) return;
    const maxWidth = Math.min(MAX_WIDTH_PX, room);
    const size = measure(maxWidth);
    candidates.push({ left: leftFor(size), top: sideTop(size.height), maxWidth, ...size, fits: size.height <= areaHeight });
  };
  addSide(rightRoom, () => anchor.right + GAP_PX);
  addSide(leftRoom, (size) => anchor.left - GAP_PX - size.width);
  if (areaWidth >= MIN_WIDTH_PX) {
    const maxWidth = Math.min(MAX_WIDTH_PX, areaWidth);
    const size = measure(maxWidth);
    const left = clamp(centerX - size.width / 2, area.left, area.right - size.width);
    const above = anchor.top - GAP_PX - size.height;
    if (above >= area.top) candidates.push({ left, top: above, maxWidth, ...size, fits: true });
    const below = anchor.bottom + GAP_PX;
    if (below + size.height <= area.bottom) candidates.push({ left, top: below, maxWidth, ...size, fits: true });
  }

  const covered = (candidate: Candidate) => obstacles.reduce((sum, rect) => {
    const width = Math.min(candidate.left + candidate.width, rect.right) - Math.max(candidate.left, rect.left);
    const height = Math.min(candidate.top + candidate.height, rect.bottom) - Math.max(candidate.top, rect.top);
    return width > 0 && height > 0 ? sum + width * height : sum;
  }, 0);
  // 판에 온전히 들어가는 자리가 먼저다. 그런 자리가 없을 때만 세로로 넘치는 옆자리끼리 비교한다.
  const fitting = candidates.filter((candidate) => candidate.fits);
  const pool = fitting.length > 0 ? fitting : candidates;
  let best: Candidate | null = null;
  let bestCovered = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const value = covered(candidate);
    if (value < bestCovered) {
      best = candidate;
      bestCovered = value;
      if (value === 0) break;
    }
  }
  if (best) return { left: Math.round(best.left), top: Math.round(best.top), maxWidth: best.maxWidth };

  // 어느 쪽 여유도 최소 폭에 못 미치는 판 — 넓은 쪽에 최소 폭으로 붙이고 판 안으로 끌어들인다.
  const useRight = rightRoom >= leftRoom;
  const size = measure(MIN_WIDTH_PX);
  const left = useRight ? anchor.right + GAP_PX : anchor.left - GAP_PX - size.width;
  return {
    left: Math.round(clamp(left, area.left, area.right - size.width)),
    top: Math.round(sideTop(size.height)),
    maxWidth: MIN_WIDTH_PX,
  };
}

function BranchGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="12.5" r="1.8" />
      <circle cx="11.5" cy="5.5" r="1.8" />
      <path d="M4.5 5.3v5.4M11.5 7.3c0 2.6-7 1.8-7 3.4" />
    </svg>
  );
}
