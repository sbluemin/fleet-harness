import { useSyncExternalStore } from "react";

import { isIdentityTone } from "../../workspace/shared/identity-tones.js";
import type {
  WorldActorEmote,
  WorldActorPanelMode,
  WorldAdmiralHat,
  WorldAdmiralStyle,
  WorldCameraMode,
  WorldChoreographyCommand,
  WorldChoreographyKind,
  WorldDispatchFlag,
  WorldInteractionMode,
  WorldLifecycleState,
  WorldPlayerEmote,
  WorldTimeMode,
  WorldVillageBiome,
  WorldWeatherMode,
} from "../shared/world-types.js";

/**
 * 「더 월드」 전환 상태 머신 및 UI 선호·상호작용 스토어.
 *
 * 진입(`closed → diving → open`)과 탈출(`open → escaping → closed`) 타이밍을 단일 원천으로 관리하며,
 * 심즈/MMORPG 스타일 방사형 상호작용 메뉴(`radial`) · 하단 RPG 대화창(`dialogue`) · 월드 내부 게임 패널(`goals`·`info`·`settings`) 흐름을 소유한다.
 */

const DIVE_DURATION_MS = 1_120;
const ESCAPE_DURATION_MS = 820;
const REDUCED_TRANSITION_MS = 180;
const SOUND_MUTED_STORAGE_KEY = "fleet.theWorld.soundMuted.v1";
const VILLAGE_BIOMES_STORAGE_KEY = "fleet.theWorld.villageBiomes.v1";
const WEATHER_MODE_STORAGE_KEY = "fleet.theWorld.weatherMode.v1";
const ADMIRAL_STYLE_STORAGE_KEY = "fleet.theWorld.admiralStyle.v1";
const DISTRICT_NOTES_STORAGE_KEY = "fleet.theWorld.districtNotes.v1";
const MAX_DISTRICT_NOTE_LEN = 240;

const DEFAULT_ADMIRAL_STYLE: WorldAdmiralStyle = {
  tone: "cerulean",
  hat: "admiral",
};

function isVillageBiome(value: unknown): value is WorldVillageBiome {
  return value === "meadow" || value === "sakura" || value === "citadel";
}

function isWeatherMode(value: unknown): value is WorldWeatherMode {
  return value === "clear" || value === "sakura" || value === "rain" || value === "snow";
}

function isAdmiralHat(value: unknown): value is WorldAdmiralHat {
  return value === "admiral" || value === "crown" || value === "explorer" || value === "none";
}

function readInitialSoundMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOUND_MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSoundMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUND_MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialVillageBiomes(): Readonly<Record<string, WorldVillageBiome>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VILLAGE_BIOMES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized: Record<string, WorldVillageBiome> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && key.length <= 128 && isVillageBiome(val)) {
        sanitized[key] = val;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function persistVillageBiomes(biomes: Readonly<Record<string, WorldVillageBiome>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VILLAGE_BIOMES_STORAGE_KEY, JSON.stringify(biomes));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialWeatherMode(): WorldWeatherMode {
  if (typeof window === "undefined") return "clear";
  try {
    const raw = window.localStorage.getItem(WEATHER_MODE_STORAGE_KEY);
    return isWeatherMode(raw) ? raw : "clear";
  } catch {
    return "clear";
  }
}

function persistWeatherMode(mode: WorldWeatherMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WEATHER_MODE_STORAGE_KEY, mode);
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialAdmiralStyle(): WorldAdmiralStyle {
  if (typeof window === "undefined") return DEFAULT_ADMIRAL_STYLE;
  try {
    const raw = window.localStorage.getItem(ADMIRAL_STYLE_STORAGE_KEY);
    if (!raw) return DEFAULT_ADMIRAL_STYLE;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_ADMIRAL_STYLE;
    return {
      tone: isIdentityTone(parsed.tone) ? parsed.tone : DEFAULT_ADMIRAL_STYLE.tone,
      hat: isAdmiralHat(parsed.hat) ? parsed.hat : DEFAULT_ADMIRAL_STYLE.hat,
    };
  } catch {
    return DEFAULT_ADMIRAL_STYLE;
  }
}

function persistAdmiralStyle(style: WorldAdmiralStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADMIRAL_STYLE_STORAGE_KEY, JSON.stringify(style));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialDistrictNotes(): Readonly<Record<string, string>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DISTRICT_NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && key.length <= 256 && typeof val === "string") {
        const trimmed = val.trim().slice(0, MAX_DISTRICT_NOTE_LEN);
        if (trimmed) sanitized[key] = trimmed;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function persistDistrictNotes(notes: Readonly<Record<string, string>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISTRICT_NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

export interface WorldDistrictContextMenu {
  readonly districtId: string;
  readonly clientX: number;
  readonly clientY: number;
}

export interface WorldStoreSnapshot {
  readonly lifecycle: WorldLifecycleState;
  readonly selectedActorId: string | null;
  readonly nearActorId: string | null;
  readonly interactionMode: WorldInteractionMode;
  readonly inspectedObjectiveId: string | null;
  readonly selectedDistrictId: string | null;
  readonly hoveredDistrictId: string | null;
  readonly districtContextMenu: WorldDistrictContextMenu | null;
  readonly pendingChatMention: {
    readonly nonce: number;
    readonly actorId: string;
    readonly actorIds?: readonly string[] | undefined;
    readonly prefillText?: string | undefined;
  } | null;
  readonly questBoardOpen: boolean;
  readonly warRoomOpen: boolean;
  readonly admiralCustomizerOpen: boolean;
  readonly chatActive: boolean;
  readonly photoMode: boolean;
  readonly sittingAtCampfire: boolean;
  readonly weatherMode: WorldWeatherMode;
  readonly admiralStyle: WorldAdmiralStyle;
  readonly villageBiomes: Readonly<Record<string, WorldVillageBiome>>;
  readonly dispatchFlags: Readonly<Record<string, WorldDispatchFlag>>;
  readonly districtNotes: Readonly<Record<string, string>>;
  readonly rallyNonce: number;
  readonly playerEmoteCommand: { readonly nonce: number; readonly emote: WorldPlayerEmote } | null;
  readonly overviewMode: boolean;
  readonly soundMuted: boolean;
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
  inspectedObjectiveId: null,
  selectedDistrictId: null,
  hoveredDistrictId: null,
  districtContextMenu: null,
  pendingChatMention: null,
  questBoardOpen: false,
  warRoomOpen: false,
  admiralCustomizerOpen: false,
  chatActive: false,
  photoMode: false,
  sittingAtCampfire: false,
  weatherMode: readInitialWeatherMode(),
  admiralStyle: readInitialAdmiralStyle(),
  villageBiomes: readInitialVillageBiomes(),
  dispatchFlags: {},
  districtNotes: readInitialDistrictNotes(),
  rallyNonce: 0,
  playerEmoteCommand: null,
  overviewMode: false,
  soundMuted: readInitialSoundMuted(),
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

function isWorldActive(): boolean {
  return state.lifecycle !== "closed";
}

export function useWorldActive(): boolean {
  return useSyncExternalStore(subscribeWorldStore, isWorldActive, isWorldActive);
}

function readVillageBiomes(): Readonly<Record<string, WorldVillageBiome>> {
  return state.villageBiomes;
}

export function useVillageBiomes(): Readonly<Record<string, WorldVillageBiome>> {
  return useSyncExternalStore(subscribeWorldStore, readVillageBiomes, readVillageBiomes);
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
    selectedDistrictId: null,
    hoveredDistrictId: null,
    districtContextMenu: null,
    pendingChatMention: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    chatActive: false,
    photoMode: false,
    sittingAtCampfire: false,
    overviewMode: false,
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
    selectedDistrictId: null,
    hoveredDistrictId: null,
    districtContextMenu: null,
    pendingChatMention: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    chatActive: false,
    photoMode: false,
    sittingAtCampfire: false,
    overviewMode: false,
  };
  emit();
  if (typeof window !== "undefined") {
    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      state = {
        ...state,
        lifecycle: "closed",
        nearActorId: null,
        selectedActorId: null,
        interactionMode: "closed",
        selectedDistrictId: null,
        hoveredDistrictId: null,
        districtContextMenu: null,
        pendingChatMention: null,
        questBoardOpen: false,
        warRoomOpen: false,
        admiralCustomizerOpen: false,
        chatActive: false,
        photoMode: false,
        sittingAtCampfire: false,
        overviewMode: false,
      };
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
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function openActorDialogue(actorId: string): void {
  state = {
    ...state,
    selectedActorId: actorId,
    interactionMode: "dialogue",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function openActorPanel(actorId: string, mode: WorldActorPanelMode, objectiveId?: string | null): void {
  state = {
    ...state,
    selectedActorId: actorId,
    interactionMode: mode,
    inspectedObjectiveId: objectiveId ?? null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function setInspectedObjectiveId(objectiveId: string | null): void {
  if (state.inspectedObjectiveId === objectiveId) return;
  state = { ...state, inspectedObjectiveId: objectiveId };
  emit();
}

export function selectDistrict(districtId: string | null): void {
  if (districtId === null) {
    if (state.selectedDistrictId === null) return;
    state = { ...state, selectedDistrictId: null };
    emit();
    return;
  }
  if (
    state.selectedDistrictId === districtId
    && state.interactionMode === "closed"
    && state.selectedActorId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    selectedDistrictId: districtId,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function setHoveredDistrict(districtId: string | null): void {
  if (state.hoveredDistrictId === districtId) return;
  state = { ...state, hoveredDistrictId: districtId };
  emit();
}

export function openDistrictContextMenu(districtId: string, clientX: number, clientY: number): void {
  state = {
    ...state,
    districtContextMenu: { districtId, clientX, clientY },
    photoMode: false,
  };
  emit();
}

export function closeDistrictContextMenu(): void {
  if (state.districtContextMenu === null) return;
  state = { ...state, districtContextMenu: null };
  emit();
}

export function requestChatMention(actorId: string, prefillText?: string): void {
  nonceCounter += 1;
  state = {
    ...state,
    chatActive: true,
    photoMode: false,
    districtContextMenu: null,
    pendingChatMention: {
      nonce: nonceCounter,
      actorId,
      actorIds: [actorId],
      ...(prefillText !== undefined ? { prefillText } : {}),
    },
  };
  emit();
}

export function requestChatMentions(actorIds: readonly string[], prefillText?: string): void {
  const unique = [...new Set(actorIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return;
  nonceCounter += 1;
  state = {
    ...state,
    chatActive: true,
    photoMode: false,
    overviewMode: false,
    districtContextMenu: null,
    pendingChatMention: {
      nonce: nonceCounter,
      actorId: unique[0]!,
      actorIds: unique,
      ...(prefillText !== undefined ? { prefillText } : {}),
    },
  };
  emit();
}

export function consumeChatMention(nonce: number): void {
  if (!state.pendingChatMention || state.pendingChatMention.nonce !== nonce) return;
  state = { ...state, pendingChatMention: null };
  emit();
}

export function setPhotoMode(enabled: boolean): void {
  if (state.photoMode === enabled) return;
  state = {
    ...state,
    photoMode: enabled,
    ...(enabled
      ? {
          selectedActorId: null,
          interactionMode: "closed" as const,
          inspectedObjectiveId: null,
          selectedDistrictId: null,
          districtContextMenu: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          chatActive: false,
        }
      : {}),
  };
  emit();
}

export function togglePhotoMode(): void {
  setPhotoMode(!state.photoMode);
}

export function setWeatherMode(mode: WorldWeatherMode): void {
  if (!isWeatherMode(mode) || state.weatherMode === mode) return;
  persistWeatherMode(mode);
  state = { ...state, weatherMode: mode };
  emit();
}

export function openWarRoom(): void {
  if (
    state.warRoomOpen
    && state.selectedActorId === null
    && state.interactionMode === "closed"
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.admiralCustomizerOpen
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    warRoomOpen: true,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function closeWarRoom(): void {
  if (!state.warRoomOpen) return;
  state = { ...state, warRoomOpen: false };
  emit();
}

export function toggleWarRoom(): void {
  if (state.warRoomOpen) closeWarRoom();
  else openWarRoom();
}

export function setAdmiralStyle(patch: Partial<WorldAdmiralStyle>): void {
  const nextTone = patch.tone !== undefined && isIdentityTone(patch.tone) ? patch.tone : state.admiralStyle.tone;
  const nextHat = patch.hat !== undefined && isAdmiralHat(patch.hat) ? patch.hat : state.admiralStyle.hat;
  if (nextTone === state.admiralStyle.tone && nextHat === state.admiralStyle.hat) return;
  const nextStyle: WorldAdmiralStyle = { tone: nextTone, hat: nextHat };
  persistAdmiralStyle(nextStyle);
  state = { ...state, admiralStyle: nextStyle };
  emit();
}

export function openAdmiralCustomizer(): void {
  if (
    state.admiralCustomizerOpen
    && state.selectedActorId === null
    && state.interactionMode === "closed"
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    admiralCustomizerOpen: true,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function closeAdmiralCustomizer(): void {
  if (!state.admiralCustomizerOpen) return;
  state = { ...state, admiralCustomizerOpen: false };
  emit();
}

export function toggleAdmiralCustomizer(): void {
  if (state.admiralCustomizerOpen) closeAdmiralCustomizer();
  else openAdmiralCustomizer();
}

export function setSittingAtCampfire(sitting: boolean): void {
  if (state.sittingAtCampfire === sitting) return;
  state = {
    ...state,
    sittingAtCampfire: sitting,
    ...(sitting ? { overviewMode: false, districtContextMenu: null } : {}),
  };
  emit();
}

export function toggleCampfireSit(): void {
  setSittingAtCampfire(!state.sittingAtCampfire);
}

export function setDistrictNote(districtId: string, note: string): void {
  if (!districtId) return;
  const trimmed = note.trim().slice(0, MAX_DISTRICT_NOTE_LEN);
  const current = state.districtNotes[districtId] ?? "";
  if (current === trimmed) return;
  const next = { ...state.districtNotes };
  if (trimmed) next[districtId] = trimmed;
  else delete next[districtId];
  persistDistrictNotes(next);
  state = { ...state, districtNotes: next };
  emit();
}

export function requestRallyAll(): void {
  nonceCounter += 1;
  state = {
    ...state,
    rallyNonce: nonceCounter,
    warRoomOpen: false,
    questBoardOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    sittingAtCampfire: false,
  };
  emit();
}

export function requestPlayerEmote(emote: WorldPlayerEmote): void {
  nonceCounter += 1;
  state = {
    ...state,
    playerEmoteCommand: { nonce: nonceCounter, emote },
  };
  emit();
}

export function setVillageBiome(commodoreId: string, biome: WorldVillageBiome): void {
  if (!commodoreId || !isVillageBiome(biome)) return;
  if (state.villageBiomes[commodoreId] === biome) return;
  const nextBiomes: Readonly<Record<string, WorldVillageBiome>> = {
    ...state.villageBiomes,
    [commodoreId]: biome,
  };
  persistVillageBiomes(nextBiomes);
  state = { ...state, villageBiomes: nextBiomes };
  emit();
}

export function placeDispatchFlag(districtId: string, label: string): void {
  if (!districtId) return;
  const trimmed = label.trim().slice(0, 80);
  state = {
    ...state,
    dispatchFlags: {
      ...state.dispatchFlags,
      [districtId]: {
        districtId,
        label: trimmed,
        createdAt: Date.now(),
      },
    },
  };
  emit();
}

export function clearDispatchFlag(districtId: string): void {
  if (!state.dispatchFlags[districtId]) return;
  const next = { ...state.dispatchFlags };
  delete next[districtId];
  state = { ...state, dispatchFlags: next };
  emit();
}

export function openQuestBoard(): void {
  if (
    state.questBoardOpen
    && state.selectedActorId === null
    && state.interactionMode === "closed"
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    questBoardOpen: true,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function closeQuestBoard(): void {
  if (!state.questBoardOpen) return;
  state = { ...state, questBoardOpen: false };
  emit();
}

export function toggleQuestBoard(): void {
  if (state.questBoardOpen) closeQuestBoard();
  else openQuestBoard();
}

export function setChatActive(active: boolean): void {
  if (state.chatActive === active) return;
  state = {
    ...state,
    chatActive: active,
    ...(active ? { photoMode: false, districtContextMenu: null } : {}),
  };
  emit();
}

export function activateChat(): void {
  setChatActive(true);
}

export function deactivateChat(): void {
  setChatActive(false);
}

export function setOverviewMode(enabled: boolean): void {
  if (state.overviewMode === enabled) return;
  state = {
    ...state,
    overviewMode: enabled,
    ...(enabled
      ? {
          selectedActorId: null,
          interactionMode: "closed" as const,
          inspectedObjectiveId: null,
          districtContextMenu: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          sittingAtCampfire: false,
        }
      : {}),
  };
  emit();
}

export function toggleOverviewMode(): void {
  setOverviewMode(!state.overviewMode);
}

export function setSoundMuted(muted: boolean): void {
  if (state.soundMuted === muted) return;
  persistSoundMuted(muted);
  state = { ...state, soundMuted: muted };
  emit();
}

export function toggleSoundMuted(): void {
  setSoundMuted(!state.soundMuted);
}

export function closeActorInteraction(): void {
  if (
    state.interactionMode === "closed"
    && state.selectedActorId === null
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
  ) {
    return;
  }
  state = {
    ...state,
    interactionMode: "closed",
    selectedActorId: null,
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
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
    overviewMode: false,
    sittingAtCampfire: false,
    approachRequest: { nonce: nonceCounter, actorId },
  };
  emit();
}

export function requestWorldTeleport(x: number, z: number): void {
  nonceCounter += 1;
  state = {
    ...state,
    overviewMode: false,
    sittingAtCampfire: false,
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
