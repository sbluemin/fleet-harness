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

export interface FloatingWidgetDeparture {
  readonly operationId: string;
  readonly title: string;
}

export interface FloatingWidgetDeparturesCapability {
  list(): readonly FloatingWidgetDeparture[];
  subscribe(listener: (departures: readonly FloatingWidgetDeparture[]) => void): () => void;
}

/** 부유 위젯이 호스트에 요청할 수 있는 Operation 동작. 상태 읽기는 허용하지 않는다. */
export interface FloatingWidgetOperationsCapability {
  /** 해당 Operation이 속한 Theater로 전환하고 Operation을 활성화한다. */
  focus(operationId: string): void;
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
  /** OS의 동작 줄이기 설정으로 모션이 억제된 상태. */
  readonly reducedMotion: boolean;
}

export interface FloatingWidgetSignalsCapability {
  read(): FloatingWidgetFleetSignals;
  subscribe(listener: (signals: FloatingWidgetFleetSignals) => void): () => void;
}

export interface FloatingWidgetContext {
  readonly api: ClientApiCapability;
  readonly arrivals: FloatingWidgetArrivalsCapability;
  readonly departures: FloatingWidgetDeparturesCapability;
  readonly operations: FloatingWidgetOperationsCapability;
  readonly signals: FloatingWidgetSignalsCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
}

export interface FloatingWidgetDescriptor {
  readonly id: string;
  readonly render: (ctx: FloatingWidgetContext) => ReactNode;
}
