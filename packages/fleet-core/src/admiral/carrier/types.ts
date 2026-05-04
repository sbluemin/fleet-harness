/**
 * fleet/carrier/types.ts — Carrier 프레임워크 타입 정의
 *
 * 외부 확장이 커스텀 Carrier를 등록할 때 사용하는
 * 공개 타입 및 내부 상태 타입을 정의합니다.
 */

import type { CliType } from "@sbluemin/unified-agent";
export type {
  BatchCliChoice,
  CarrierCliType,
  CarrierOverlayCallbacks,
  CarrierStatusEntry,
  CliModelInfo,
  CliTypeChangeSettledResult,
  CliServiceSnapshot,
  CliTypeChangeResult,
  CliTypeChoice,
  ModelSelection,
  OverlayState,
  ResolvedCliSelection,
} from "./overlay-types.js";

// ─── Carrier 카테고리 ─────────────────────────────────────

/** Carrier 카테고리 — 운영 계층 분류 */
export type CarrierCategory = "strategy" | "planning" | "operations";

// ─── Carrier 메타데이터 (2-Tier) ────────────────────────

/** 구조화 요청 블록 정의 */
export interface RequestBlock {
  /** 태그 이름 (e.g., "objective", "scope") */
  tag: string;
  /** 1줄 설명 */
  hint: string;
  /** 필수 여부 */
  required: boolean;
}

/**
 * Carrier 메타데이터 — 2-Tier 구조
 *
 * - Tier 1 (Routing): 시스템 프롬프트에 carrier당 ~4줄의 compact roster로 상주
 * - Tier 2 (Composition): 실행 시점에만 request에 자동 주입
 */
export interface CarrierMetadata {
  // ── Tier 1: Routing (→ promptGuidelines compact roster) ──
  /** 직함 (e.g., "Chief Engineer") */
  title: string;
  /** 한줄 역할+특징 요약 */
  summary: string;
  /** 운영 카테고리 — strategy | planning | operations */
  category: CarrierCategory;
  /** 긍정 호출 조건 (N개, 짧은 구문) */
  whenToUse: string[];
  /** 부정 호출 조건 (N개, 짧은 구문) */
  whenNotToUse: string[];
  /** 구조화 요청 블록 — 로스터 및 도구 가이드라인에 노출 */
  requestBlocks: RequestBlock[];
  /** 공용 요청 블록 — 모든 carrier에 공통으로 주입되는 선택적 블록 (e.g., prior_jobs) */
  commonRequestBlocks?: RequestBlock[];

  // ── Tier 2: Composition (→ 실행 시 request에 자동 주입) ──
  /** 권한/제약 (여러 줄) */
  permissions: string[];
  /** <output_format> 전체 블록 — framework가 request 끝에 자동 append */
  outputFormat: string;
  /** 일반 원칙 (carrier 고유 행동 지침, 2-3줄) */
  principles?: string[];
}

// ─── 공개 타입 ───────────────────────────────────────────

// ─── Carrier ID 검증 상수 ─────────────────────────────────

/** 도구 네임스페이스 충돌 방지를 위한 예약 ID */
export const RESERVED_CARRIER_IDS = new Set(["jobs", "squadron", "taskforce"]);

/** Carrier ID 허용 형식: 소문자 시작, 소문자/숫자/밑줄만 허용 */
export const CARRIER_ID_FORMAT_REGEX = /^[a-z][a-z0-9_]*$/;

// ─── 공개 타입 ───────────────────────────────────────────

/** Carrier 프레임워크 globalThis 공유 키 */
export const CARRIER_FRAMEWORK_KEY = "__pi_bridge_framework__";

export interface CarrierConfig {
  /** 고유 식별자 (carrierId) → 메시지 `{id}-user/{id}-response`, 풀/세션 키 */
  id: string;
  /** 사용할 CLI 바이너리 타입 */
  cliType: CliType;
  /** 소스레벨 기본 CLI 타입 (사용자 변경과 무관하게 원본 유지) */
  defaultCliType: CliType;
  /** 정렬 및 표시용 슬롯 번호 (키바인딩에는 사용되지 않음) */
  slot: number;
  /** 표시 이름 */
  displayName: string;
  /** 에이전트 패널 프레임 색상 (ANSI) */
  color: string;
  /** 응답 배경색 (ANSI, 선택) */
  bgColor?: string;
  /** 커스텀 응답 렌더러 (없으면 기본 렌더러) */
  renderResponse?: (...args: any[]) => any;
  /** 커스텀 사용자 입력 렌더러 (없으면 기본 렌더러) */
  renderUser?: (...args: any[]) => any;
  /** carrier 메타데이터 (2-Tier: Routing + Composition) */
  carrierMetadata?: CarrierMetadata;
}

// ─── 내부 상태 타입 ──────────────────────────────────────

export interface CarrierState {
  config: CarrierConfig;
}

export interface CarrierFrameworkState {
  /** 등록된 모든 carrier */
  modes: Map<string, CarrierState>;
  /** slot 순으로 정렬된 carrierId 목록 */
  registeredOrder: string[];
  /** 상태바 갱신 콜백 */
  statusUpdateCallbacks: Array<() => void>;
  /** offline 상태인 carrier ID 집합 */
  offlineCarriers: Set<string>;
  /** Task Force 설정이 완료된 carrier ID 집합 */
  taskforceConfiguredCarriers: Set<string>;
  /** squadron 활성화된 carrier ID 집합 */
  squadronEnabledCarriers: Set<string>;
}
