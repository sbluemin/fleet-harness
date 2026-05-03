/**
 * fleet/panel/types.ts — 패널 도메인 타입 정의
 *
 * 에이전트 패널 칼럼 데이터 등 패널 계층의 핵심 타입을 정의합니다.
 *
 * ⚠️ 이 파일은 런타임 코드가 아닌 순수 타입/인터페이스만 포함합니다.
 */

import type {
  CarrierJobKind,
  CarrierJobStatus,
} from "@sbluemin/fleet-core/admiral/_shared/carrier-job-events";

export type ColStatus = "wait" | "conn" | "stream" | "done" | "err";

/**
 * 순서가 보존된 정규화 스트림 블록.
 * 도구 호출과 응답 텍스트를 발생 순서대로 기록합니다.
 */
export type ColBlock =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; title: string; status: string; toolCallId?: string };

/** 수집된 정규화 스트리밍 데이터 */
export interface CollectedStreamData {
  text: string;
  thinking: string;
  toolCalls: { title: string; status: string }[];
  blocks: ColBlock[];
  lastStatus: string;
}

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
