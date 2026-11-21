import { useSyncExternalStore } from "react";

import type {
  WorldActorEmote,
  WorldCameraMode,
  WorldChoreographyCommand,
  WorldChoreographyKind,
  WorldInteractionMode,
  WorldLifecycleState,
  WorldTimeMode,
} from "../shared/world-types.js";

/**
 * 「더 월드」 전환 상태 머신 및 UI 선호·상호작용 스토어.
 *
 * 진입(`closed → diving → open`)과 탈출(`open → escaping → closed`) 타이밍을 단일 원천으로 관리하며,
 * 심즈/MMORPG 스타일 방사형 상호작용 메뉴(`radial`) · 하단 RPG 대화창(`dialogue`) · 상태 살피기(`inspect`) 흐름을 소유한다.
 */

const DIVE_DURATION_MS = 1_120;
const ESCAPE_DURATION_MS = 820;
const REDUCED_TRANSITION_MS = 180;

export interface WorldStoreSnapshot {
  readonly lifecycle: WorldLifecycleState;
  readonly selectedActorId: string | null;
  readonly nearActorId: string | null;
  readonly interactionMode: WorldInteractionMode;
  readonly timeMode: WorldTimeMode;
  readonly cameraMode: WorldCameraMode;
  readonly choreography: WorldChoreographyCommand | null;
  readonly emoteCommand: { readonly nonce: number; readonly actorId: string; readonly emote: WorldActorEmote } | null;
  readonly approachRequest: { readonly nonce: number; readonly actorId: string } | null;
  readonly teleportRequest: { readonly nonce: number; readonly x: number; readonly z: number } | null;
  readonly localSpeeches: Readonly<Record<string, { readonly text: string; readonly nonce: number }>>;
}

let state: WorldStoreSnapshot = {
  lifecycle: "closed",
  selectedActorId: null,
  nearActorId: null,
  interactionMode: "closed",
  timeMode: "day",
  cameraMode: "follow",
  choreography: null,
  emoteCommand: null,
  approachRequest: null,
  teleportRequest: null,
  localSpeeches: {},
};

let transitionTimer: number | null = null;
let nonceCounter = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function clearTransitionTimer(): void {
  if (transitionTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(transitionTimer);
    transitionTimer = null;
  }
}

export function getWorldStoreSnapshot(): WorldStoreSnapshot {
  return state;
}

export function subscribeWorldStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorldStore(): WorldStoreSnapshot {
  return useSyncExternalStore(subscribeWorldStore, getWorldStoreSnapshot, getWorldStoreSnapshot);
}

export function enterTheWorld(options?: { readonly reducedMotion?: boolean; readonly initialActorId?: string | null }): void {
  if (state.lifecycle === "open" || state.lifecycle === "diving") return;
  clearTransitionTimer();
  const duration = options?.reducedMotion ? REDUCED_TRANSITION_MS : DIVE_DURATION_MS;
  state = {
    ...state,
    lifecycle: "diving",
    interactionMode: "closed",
    selectedActorId: null,
  };
  emit();
  if (typeof window !== "undefined") {
    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      if (state.lifecycle !== "diving") return;
      state = { ...state, lifecycle: "open" };
      emit();
    }, duration);
  }
}

export function exitTheWorld(options?: { readonly reducedMotion?: boolean; readonly onExited?: () => void }): void {
  if (state.lifecycle === "closed" || state.lifecycle === "escaping") return;
  clearTransitionTimer();
  const duration = options?.reducedMotion ? REDUCED_TRANSITION_MS : ESCAPE_DURATION_MS;
  state = {
    ...state,
    lifecycle: "escaping",
    interactionMode: "closed",
    selectedActorId: null,
  };
  emit();
  if (typeof window !== "undefined") {
    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      state = { ...state, lifecycle: "closed", nearActorId: null, selectedActorId: null, interactionMode: "closed" };
      emit();
      options?.onExited?.();
    }, duration);
  }
}

export function openActorRadialMenu(actorId: string): void {
  state = {
    ...state,
    selectedActorId: actorId,
    interactionMode: "radial",
  };
  emit();
}

export function openActorDialogue(actorId: string): void {
  state = {
    ...state,
    selectedActorId: actorId,
    interactionMode: "dialogue",
  };
  emit();
}

export function openActorInspect(actorId: string): void {
  state = {
    ...state,
    selectedActorId: actorId,
    interactionMode: "inspect",
  };
  emit();
}

export function closeActorInteraction(): void {
  if (state.interactionMode === "closed" && state.selectedActorId === null) return;
  state = {
    ...state,
    interactionMode: "closed",
    selectedActorId: null,
  };
  emit();
}

export function setNearWorldActor(actorId: string | null): void {
  if (state.nearActorId === actorId) return;
  state = { ...state, nearActorId: actorId };
  emit();
}

export function setWorldTimeMode(timeMode: WorldTimeMode): void {
  if (state.timeMode === timeMode) return;
  state = { ...state, timeMode };
  emit();
}

export function setWorldCameraMode(cameraMode: WorldCameraMode): void {
  if (state.cameraMode === cameraMode) return;
  state = { ...state, cameraMode };
  emit();
}

export function triggerWorldChoreography(kind: WorldChoreographyKind, outpostId?: string): void {
  nonceCounter += 1;
  state = {
    ...state,
    choreography: { nonce: nonceCounter, kind, outpostId },
  };
  emit();
}

export function requestActorEmote(actorId: string, emote: WorldActorEmote): void {
  nonceCounter += 1;
  state = {
    ...state,
    emoteCommand: { nonce: nonceCounter, actorId, emote },
  };
  emit();
}

export function requestApproachActor(actorId: string): void {
  nonceCounter += 1;
  state = {
    ...state,
    approachRequest: { nonce: nonceCounter, actorId },
  };
  emit();
}

export function requestWorldTeleport(x: number, z: number): void {
  nonceCounter += 1;
  state = {
    ...state,
    teleportRequest: { nonce: nonceCounter, x, z },
  };
  emit();
}

export function pushActorSpeech(actorId: string, text: string): void {
  nonceCounter += 1;
  state = {
    ...state,
    localSpeeches: {
      ...state.localSpeeches,
      [actorId]: { text, nonce: nonceCounter },
    },
  };
  emit();
}
