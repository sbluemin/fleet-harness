import type { ConversationSpeaker } from "../../../../shared/conversation/types.js";
import type { ObjectiveRecord } from "../../../../../../core/client/src/integration/types.js";
import * as React from "react";

import { frameCommanderLedger } from "./commander-ledger.js";
import { getGroupT } from "./group-chat-i18n.js";
import { markLedgerSplitPane } from "./ledger-split-panes.js";

/**
 * 데스크톱 원장 분할 화면.
 *
 * 지휘관과 구성원의 기존 본문(채팅·터미널)을 한 그리드에 동시에 세운다. 칸 사이 가로·세로 경계를
 * 끌어 크기를 바꾸며, 그 크기는 이 컴포넌트가 마운트된 동안만 유지한다 — 저장하지 않는다.
 * 칸 머리는 없다 — 칸 주인(아바타·이름)은 칸 안 채팅 바닥 줄 왼쪽이 말한다(`ledger-split-panes`). 최대화·순서 변경·대화로
 * 돌아가기 단추는 없다.
 *
 * 통합자가 그룹 대화 루트의 가운데 칸에, 화면이 원장일 때만 세운다. 폰 경로에는 세우지 않는다.
 * `defaultBody`(단일 슬롯)와 같은 objectiveId 를 같이 세우면 안 된다 — 본문 풀은 objectiveId 당
 * 슬롯이 하나라 한쪽만 붙는다.
 *
 * 지휘관 칸이 서 있는 동안 `frameCommanderLedger` 로 그 본문의 입력 틀을 뺀다(개별 지휘관 원장과
 * 같은 표식). 구성원 본문은 기존 구성원 모드(`parentObjectiveId`)가 입력 틀을 뺀다.
 *
 * ```tsx
 * <GroupLedgerSplit
 *   panes={[commanderPane, ...memberPanes]}
 *   language={language}
 *   renderParticipantBody={context.renderParticipantBody}
 * />
 * ```
 *
 * `panes` 순서가 칸 순서다(행 우선). 지휘관을 첫 칸에 둔다.
 */
export interface GroupLedgerSplitPane {
  /** 이 칸의 Objective. 지휘관이면 그룹 루트 레코드. */
  readonly objectiveRecord: ObjectiveRecord;
  /** 칸 주인의 표식과 이름 — 칸 안 채팅 바닥 줄 왼쪽에 선다. */
  readonly speaker: ConversationSpeaker;
}

export interface GroupLedgerSplitProps {
  readonly panes: readonly GroupLedgerSplitPane[];
  readonly language: "en" | "ko";
  /**
   * 참여자 하나의 기존 본문 슬롯.
   * `ConversationBodyContext.renderParticipantBody` 를 그대로 넘긴다.
   */
  readonly renderParticipantBody: (objectiveRecord: ObjectiveRecord) => React.ReactNode;
}

/** 경계 트랙의 폭·높이(px). 드래그 계산과 그리드 템플릿이 같은 값을 쓴다. */
const GUTTER_PX = 8;
/** 칸이 이보다 좁아지거나 낮아지지 않는다. */
const MIN_PANE_PX = 120;
const KEY_STEP_PX = 32;

export function GroupLedgerSplit({ panes, language, renderParticipantBody }: GroupLedgerSplitProps) {
  const shape = gridShape(panes.length);
  const [colWeights, setColWeights] = React.useState<readonly number[]>(() => ones(shape.cols));
  const [rowWeights, setRowWeights] = React.useState<readonly number[]>(() => ones(shape.rows));
  React.useEffect(() => {
    setColWeights(ones(shape.cols));
    setRowWeights(ones(shape.rows));
  }, [shape.cols, shape.rows]);
  const columns = colWeights.length === shape.cols ? colWeights : ones(shape.cols);
  const rows = rowWeights.length === shape.rows ? rowWeights : ones(shape.rows);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const framedKey = framedCommanderIds(panes).join("\0");
  // 자식 본문보다 늦게 그려지므로 첫 프레임에는 입력 틀이 보였다가 표식이 붙으면 걷힌다 — 개별 원장과 같다.
  React.useLayoutEffect(() => {
    const release = (framedKey.length === 0 ? [] : framedKey.split("\0")).map((id) => frameCommanderLedger(id));
    return () => { for (const stop of release) stop(); };
  }, [framedKey]);
  // 칸 머리 대신 칸 안 바닥 줄이 칸 주인(아바타·이름)을 말한다 — 본문은 포털이라 표식 store 로 잇는다.
  React.useLayoutEffect(() => {
    const release = panes.map((pane) => markLedgerSplitPane(pane.objectiveRecord.id, pane.speaker));
    return () => { for (const stop of release) stop(); };
  }, [panes]);
  const t = getGroupT(language);
  // 마지막 행이 덜 차면 그 행의 마지막 칸이 남는 열까지 늘어난다 — 빈 칸을 두지 않는다. 그 행을 가로지르는 세로 경계는
  // 그 행 앞에서 끊긴다(3명이면 위 행 지휘관|구성원, 아래 행 구성원 한 칸이 전체 폭).
  const lastRowCount = panes.length - (shape.rows - 1) * shape.cols;
  const partialRow = shape.rows > 1 && lastRowCount < shape.cols;
  return (
    <div
      ref={gridRef}
      className="group-ledger-split"
      style={{ gridTemplateColumns: tracks(columns), gridTemplateRows: tracks(rows) }}
    >
      {panes.map((pane, index) => {
        const column = index % shape.cols;
        const row = Math.floor(index / shape.cols);
        const stretch = partialRow && index === panes.length - 1;
        return (
          <section
            key={pane.objectiveRecord.id}
            className="group-ledger-split-pane"
            aria-label={pane.speaker.name}
            style={{ gridColumn: stretch ? `${column * 2 + 1} / -1` : column * 2 + 1, gridRow: row * 2 + 1 }}
          >
            <div className="group-ledger-split-pane-body">
              {renderParticipantBody(pane.objectiveRecord)}
            </div>
          </section>
        );
      })}
      {columns.slice(0, -1).map((_, index) => (
        <SplitGutter
          key={`col-${index}`}
          axis="column"
          index={index}
          rowEnd={partialRow && index >= lastRowCount - 1 ? (shape.rows - 1) * 2 : null}
          label={t("group.ledger.split.resizeColumn")}
          gridRef={gridRef}
          weights={columns}
          onCommit={setColWeights}
        />
      ))}
      {rows.slice(0, -1).map((_, index) => (
        <SplitGutter
          key={`row-${index}`}
          axis="row"
          index={index}
          label={t("group.ledger.split.resizeRow")}
          gridRef={gridRef}
          weights={rows}
          onCommit={setRowWeights}
        />
      ))}
    </div>
  );
}

function SplitGutter({ axis, index, rowEnd = null, label, gridRef, weights, onCommit }: {
  readonly axis: "column" | "row";
  readonly index: number;
  /** 세로 경계가 끝나는 그리드 행 선 — 늘어난 마지막 행 칸을 가로지르지 않게 그 앞에서 끊는다. null 이면 끝까지. */
  readonly rowEnd?: number | null;
  readonly label: string;
  readonly gridRef: React.RefObject<HTMLDivElement | null>;
  readonly weights: readonly number[];
  readonly onCommit: (next: readonly number[]) => void;
}) {
  const drag = React.useRef<{ pointerId: number; start: number; weights: readonly number[] } | null>(null);
  const vertical = axis === "column";
  const apply = (startWeights: readonly number[], delta: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const bounds = grid.getBoundingClientRect();
    const span = vertical ? bounds.width : bounds.height;
    const available = span - (startWeights.length - 1) * GUTTER_PX;
    const next = resizePair(startWeights, index, delta, available);
    if (next) onCommit(next);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    try { handle.setPointerCapture(event.pointerId); } catch { /* 캡처가 없어도 칸 안에서는 따라간다. */ }
    drag.current = { pointerId: event.pointerId, start: vertical ? event.clientX : event.clientY, weights };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    apply(current.weights, (vertical ? event.clientX : event.clientY) - current.start);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_PX * 2 : KEY_STEP_PX;
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    apply(weights, event.key === forward ? step : -step);
  };
  const left = weights[index] ?? 1;
  const right = weights[index + 1] ?? 1;
  return (
    <div
      className={`group-ledger-split-gutter${vertical ? " is-vertical" : " is-horizontal"}`}
      style={vertical ? { gridColumn: index * 2 + 2, gridRow: rowEnd === null ? "1 / -1" : `1 / ${rowEnd}` } : { gridRow: index * 2 + 2, gridColumn: "1 / -1" }}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((left / (left + right)) * 100)}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

/** 참여자 수에 맞춘 열·행. 1 → 1×1, 2 → 2×1, 3·4 → 2×2, 5·6 → 3×2. 덜 찬 마지막 행은 마지막 칸이 남는 열까지 늘어난다. */
function gridShape(count: number): { readonly cols: number; readonly rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}

function ones(length: number): number[] {
  return Array.from({ length }, () => 1);
}

function tracks(weights: readonly number[]): string {
  return weights.map((weight, index) => `${index === 0 ? "" : `${GUTTER_PX}px `}minmax(0, ${weight}fr)`).join(" ");
}

function framedCommanderIds(panes: readonly GroupLedgerSplitPane[]): string[] {
  const ids: string[] = [];
  for (const pane of panes) {
    const id = pane.speaker.objectiveId;
    if (pane.speaker.kind === "commander" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function resizePair(weights: readonly number[], index: number, deltaPx: number, availablePx: number): number[] | null {
  const left = weights[index];
  const right = weights[index + 1];
  if (left === undefined || right === undefined || availablePx <= 0) return null;
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum <= 0) return null;
  const pair = left + right;
  const floor = Math.min(pair / 2, (MIN_PANE_PX / availablePx) * sum);
  const nextLeft = Math.max(floor, Math.min(pair - floor, left + (deltaPx / availablePx) * sum));
  const next = weights.slice();
  next[index] = nextLeft;
  next[index + 1] = pair - nextLeft;
  return next;
}
