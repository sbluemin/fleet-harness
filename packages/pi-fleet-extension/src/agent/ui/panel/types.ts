/**
 * fleet/panel/types.ts — 패널 도메인 타입 정의
 *
 * 에이전트 패널 칼럼 데이터 등 패널 계층의 핵심 타입을 정의합니다.
 *
 * ⚠️ 이 파일은 런타임 코드가 아닌 순수 타입/인터페이스만 포함합니다.
 */

import type {
  ColBlock,
  CollectedStreamData,
} from "@sbluemin/fleet-core/admiral/agent-runtime";
import type {
  CarrierJobKind,
  CarrierJobStatus,
} from "@sbluemin/fleet-core/admiral/_shared/carrier-job-events";

export type ColStatus = "wait" | "conn" | "stream" | "done" | "err";

export type { ColBlock, CollectedStreamData };

/** 에이전트 패널 칼럼 데이터 */
export interface AgentCol {
  cli: string;
  sessionId?: string;
  /** 순서 있는 이벤트 로그 (도구 호출 + 응답 텍스트 혼합) */
  blocks: ColBlock[];
  /** thinking/추론 텍스트 — 하위 호환용 누적 상태 */
  thinking: string;
  // 하위 호환 및 CollectedStreamData 공급용 (blocks에서 파생)
  text: string;
  toolCalls: { title: string; status: string }[];
  status: ColStatus;
  error?: string;
  scroll: number;
}

export type ColumnTrackKind = "carrier" | "subtask" | "backend";

export interface ColumnTrack {
  trackId: string;
  streamKey: string;
  displayCli: string;
  runId?: string;
  displayName: string;
  subtitle?: string;
  kind: ColumnTrackKind;
  status: ColStatus;
}

export interface PanelJob {
  jobId: string;
  kind: CarrierJobKind;
  ownerCarrierId: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  status: "active" | CarrierJobStatus;
  tracks: ColumnTrack[];
  activeJobToolCallId?: string;
}
