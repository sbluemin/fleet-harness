export type GoalObservedState =
  | "requested"
  | "active"
  | "deferred"
  | "met"
  | "impossible"
  | "capped"
  | "unknown";

// 마커의 `reason`은 모델·사용자 문맥에서 나온 트랜스크립트 본문이다. 브라우저 DTO에
// 트랜스크립트를 실어 보내는 것은 Console 경계가 금지하므로 파싱 단계에서 아예 버린다.
export interface GoalMarker {
  readonly met: boolean;
  readonly sentinel?: boolean;
  readonly failed?: boolean;
  readonly condition: string;
  readonly iterations?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

export interface GoalProjectionInput {
  readonly markers: readonly GoalMarker[];
  readonly checkLimit: number;
  readonly turnRunning: boolean;
  readonly backgroundPending: boolean;
  readonly sessionLive: boolean;
}

export interface GoalProjection {
  readonly state: GoalObservedState;
  readonly live: boolean;
  // 차단된 확인 횟수. CLAUDE_CODE_STOP_HOOK_BLOCK_CAP이 실제로 세는 값이므로
  // 눈금과 한도 비교는 반드시 이 값을 쓴다.
  readonly checksUsed: number;
  readonly checkLimit: number;
  // Claude가 종료 마커에 실어 보내는 자체 평가 횟수. 성공한 마지막 평가를 포함하므로
  // checksUsed보다 1 크다. 완료 요약 줄에만 쓰고, 눈금·한도 비교에는 쓰지 않는다.
  readonly totalChecks?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

export function parseGoalMarkers(lines: readonly string[]): GoalMarker[] {
  const markers: GoalMarker[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      if (!isRecord(record) || record.type !== "attachment" || !isRecord(record.attachment)) continue;
      const attachment = record.attachment;
      if (attachment.type !== "goal_status" || typeof attachment.met !== "boolean" || typeof attachment.condition !== "string") continue;
      markers.push({
        met: attachment.met,
        condition: attachment.condition,
        ...(typeof attachment.sentinel === "boolean" ? { sentinel: attachment.sentinel } : {}),
        ...(typeof attachment.failed === "boolean" ? { failed: attachment.failed } : {}),
        ...(typeof attachment.iterations === "number" && Number.isFinite(attachment.iterations) ? { iterations: attachment.iterations } : {}),
        ...(typeof attachment.durationMs === "number" && Number.isFinite(attachment.durationMs) ? { durationMs: attachment.durationMs } : {}),
        ...(typeof attachment.tokens === "number" && Number.isFinite(attachment.tokens) ? { tokens: attachment.tokens } : {}),
      });
    } catch {
      // 파싱할 수 없는 JSONL 행은 건너뛴다.
    }
  }
  return markers;
}

export function projectSessionGoal(input: GoalProjectionInput): GoalProjection | null {
  const sentinelIndex = input.markers.findLastIndex((marker) => marker.sentinel === true);
  if (sentinelIndex === -1) return null;

  const markers = input.markers.slice(sentinelIndex + 1);
  const lastMarker = markers.at(-1);
  const checksUsed = markers.filter((marker) => marker.met === false && marker.failed !== true).length;
  const common = {
    live: input.sessionLive,
    checksUsed,
    checkLimit: input.checkLimit,
  };

  if (lastMarker?.met === true) return { state: "met", ...common, ...terminalDetails(lastMarker) };
  if (lastMarker?.failed === true) return { state: "impossible", ...common, ...terminalDetails(lastMarker) };
  if (!input.sessionLive) return { state: "unknown", ...common };
  if (input.backgroundPending) return { state: "deferred", ...common };
  if (input.turnRunning) return { state: "active", ...common };
  if (checksUsed >= input.checkLimit) return { state: "capped", ...common };
  return { state: "unknown", ...common };
}

function terminalDetails(
  marker: GoalMarker,
): Pick<GoalProjection, "totalChecks" | "durationMs" | "tokens"> {
  return {
    ...(Number.isFinite(marker.iterations) ? { totalChecks: marker.iterations } : {}),
    ...(marker.durationMs === undefined ? {} : { durationMs: marker.durationMs }),
    ...(marker.tokens === undefined ? {} : { tokens: marker.tokens }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
