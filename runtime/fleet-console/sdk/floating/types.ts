import type { ReactNode } from "react";

import type { ConsoleLocale } from "../i18n/types.js";
import type {
  ClientApiCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
} from "../plugin/types.js";

export interface FloatingWidgetArrival {
  readonly operationId: string;
  readonly title: string;
}

export interface FloatingWidgetArrivalsCapability {
  list(): readonly FloatingWidgetArrival[];
  subscribe(listener: (arrivals: readonly FloatingWidgetArrival[]) => void): () => void;
}

/**
 * 콘솔 전역 상태를 부유 위젯이 읽는 유일한 창구. 개별 Operation의 정체는 넘기지 않고 집계만 넘겨
 * 위젯이 함대 분위기에만 반응하게 한다 — 세부는 여전히 호스트 소유다.
 */
export interface FloatingWidgetFleetSignals {
  /** 실행 중인 Operation 수. */
  readonly running: number;
  /** 입력이나 승인을 기다리는 Operation 수. */
  readonly awaiting: number;
  /** 콘솔 스트림이 끊어진 상태. */
  readonly disconnected: boolean;
  /** OS 설정이나 콘솔 설정으로 모션이 억제된 상태. */
  readonly reducedMotion: boolean;
}

export interface FloatingWidgetSignalsCapability {
  read(): FloatingWidgetFleetSignals;
  subscribe(listener: (signals: FloatingWidgetFleetSignals) => void): () => void;
}

export interface FloatingWidgetContext {
  readonly api: ClientApiCapability;
  readonly arrivals: FloatingWidgetArrivalsCapability;
  readonly signals: FloatingWidgetSignalsCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
}

export interface FloatingWidgetDescriptor {
  readonly id: string;
  readonly render: (ctx: FloatingWidgetContext) => ReactNode;
}
