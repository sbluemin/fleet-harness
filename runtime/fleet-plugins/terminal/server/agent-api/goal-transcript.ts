import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { clampGoalCheckLimit } from "@dotobokuri/fleet-admiral";

import { parseGoalMarkers, projectSessionGoal, type GoalMarker } from "./goal-projection.js";
import type { AgentSessionGoal, OperationGoalRecord } from "./types.js";

interface GoalTranscriptCursor {
  readonly offset: number;
  // 읽기 경계가 다중바이트 문자를 가르면 그 조각은 복구할 수 없는 U+FFFD가 된다. 디코더를
  // 커서에 붙여 미완성 바이트를 다음 읽기까지 보관한다 — 한글 조건문이 깨지면 sentinel 대조가
  // 어긋나 Fleet 소유 목표가 터미널 소유로 잘못 강등된다.
  readonly decoder: StringDecoder;
  readonly partial: string;
  readonly markers: GoalMarker[];
}

export interface BuildAgentSessionGoalArgs {
  readonly goal: OperationGoalRecord | undefined;
  readonly transcriptPath: string | undefined;
  readonly turnRunning: boolean;
  readonly backgroundPending: boolean;
  readonly sessionLive: boolean;
  /**
   * 살아 있는 프로세스가 spawn 시점에 실제로 받은 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
   * 실행 중인 세션에 새 한도를 걸어도 이 값은 바뀌지 않으므로, 눈금이 주장할 수 있는
   * 유일한 한도다. 기록이 없으면 그 프로세스는 기본값으로 떴다는 뜻이다.
   */
  readonly launchCheckLimit: number | undefined;
  /**
   * 사용자가 목표를 해제한 시점의 마커 수. 목표 기록이 없을 때의 기준선이 된다 —
   * sentinel 마커는 트랜스크립트에서 지워지지 않으므로, 이게 없으면 해제한 목표가
   * 곧바로 터미널 소유 목표로 되살아난다.
   */
  readonly clearedBaseline: number | undefined;
}

const cursors = new Map<string, GoalTranscriptCursor>();
const TRANSCRIPT_READ_CHUNK_BYTES = 256 * 1024;

export async function readGoalMarkersFromTranscript(transcriptPath: string): Promise<GoalMarker[]> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    cursors.delete(transcriptPath);
    return [];
  }

  const cached = cursors.get(transcriptPath);
  const cursor: GoalTranscriptCursor = cached && size >= cached.offset
    ? cached
    : { offset: 0, decoder: new StringDecoder("utf8"), partial: "", markers: [] };
  if (size === cursor.offset) return cursor.markers;

  // 트랜스크립트 길이는 Fleet이 정하지 않는다. 첫 스냅샷은 커서가 0에서 시작하므로 파일
  // 전체를 한 번에 담게 되고, handleSessions는 세션마다 이 읽기를 동시에 돌린다 — 할당량이
  // 외부 파일 크기에 비례하지 않도록 청크 단위로만 읽는다.
  const markers = [...cursor.markers];
  let partial = cursor.partial;
  const bytes = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, size - cursor.offset));
  const file = await open(transcriptPath, "r");
  try {
    for (let position = cursor.offset; position < size; position += bytes.length) {
      const read = await readChunk(file, bytes, position, Math.min(bytes.length, size - position));
      if (read === 0) break;
      const lines = `${partial}${cursor.decoder.write(bytes.subarray(0, read))}`.split("\n");
      partial = lines.pop() ?? "";
      markers.push(...parseGoalMarkers(lines));
    }
  } finally {
    await file.close();
  }

  cursors.set(transcriptPath, { offset: size, decoder: cursor.decoder, partial, markers });
  return markers;
}

export async function buildAgentSessionGoal(args: BuildAgentSessionGoalArgs): Promise<AgentSessionGoal | undefined> {
  const markers = args.transcriptPath ? await readGoalMarkersFromTranscript(args.transcriptPath) : [];
  // 목표는 기준선 이후의 마커만 본다. 트랜스크립트는 세션 내내 누적되므로, 기준선이 없으면
  // 이전 목표의 종료 마커가 현재 상태로 읽힌다. 기록이 있으면 요청 시점이, 해제됐으면
  // 해제 시점이 기준선이다.
  const baseline = args.goal ? args.goal.markerBaseline : args.clearedBaseline ?? 0;
  const projectedMarkers = markers.slice(Math.max(0, baseline));
  // 살아 있는 세션의 한도는 프로세스가 들고 뜬 값이고, 휴면 세션의 한도는 다음 재개가 쓸
  // 값이다. 고른 한도가 지금 강제되는 한도와 다르면 그 차이를 `pendingCheckLimit`으로 따로
  // 말한다 — 눈금이 강제되지 않는 숫자를 세면 영수증이 거짓말이 된다.
  const launchLimit = clampGoalCheckLimit(args.launchCheckLimit);
  const chosenLimit = args.goal?.checkLimit;
  const checkLimit = args.sessionLive ? launchLimit : chosenLimit ?? launchLimit;
  const pending = args.sessionLive && chosenLimit !== undefined && chosenLimit !== checkLimit
    ? { pendingCheckLimit: chosenLimit }
    : {};
  const projection = projectSessionGoal({
    markers: projectedMarkers,
    checkLimit,
    turnRunning: args.turnRunning,
    backgroundPending: args.backgroundPending,
    sessionLive: args.sessionLive,
  });
  if (!projection) {
    if (!args.goal) return undefined;
    return {
      state: "requested",
      live: args.sessionLive,
      origin: args.goal.origin,
      checksUsed: 0,
      checkLimit,
      ...pending,
      ...(args.goal.origin === "fleet" && args.goal.condition !== undefined ? { condition: args.goal.condition } : {}),
    };
  }
  // 관측된 sentinel의 조건문이 Fleet이 보관한 문장과 다르면 사용자가 터미널에서 목표를
  // 갈아치운 것이다. 그때는 소유권을 내리고 조건문을 감춘다 — Fleet이 더 이상 소유하지
  // 않는 문장을 현재 목표라고 보여 주면 안 된다.
  const observedCondition = findSentinelCondition(projectedMarkers);
  const fleetOwned = args.goal?.origin === "fleet"
    && args.goal.condition !== undefined
    && observedCondition === args.goal.condition;
  return {
    ...projection,
    ...pending,
    origin: fleetOwned ? "fleet" : "terminal",
    ...(fleetOwned ? { condition: args.goal?.condition } : {}),
  };
}

function findSentinelCondition(markers: readonly GoalMarker[]): string | undefined {
  const index = markers.findLastIndex((marker) => marker.sentinel === true);
  return index === -1 ? undefined : markers[index]?.condition;
}

export function dropGoalTranscriptCache(transcriptPath: string | undefined): void {
  if (transcriptPath) cursors.delete(transcriptPath);
}

async function readChunk(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number,
  length: number,
): Promise<number> {
  let offset = 0;
  while (offset < length) {
    const result = await file.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
