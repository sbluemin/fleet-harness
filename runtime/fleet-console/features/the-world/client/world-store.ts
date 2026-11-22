import { useSyncExternalStore } from "react";

import { isIdentityTone } from "../../workspace/shared/identity-tones.js";
import type {
  WorldActorEmote,
  WorldActorPanelMode,
  WorldAdmiralCape,
  WorldAdmiralHat,
  WorldAdmiralStyle,
  WorldAdmiralTrail,
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
import {
  WORLD_FISH_IDS,
  WORLD_FISH_SPECS,
  type WorldFishId,
  type WorldFishingPhase,
  type WorldFishRarity,
} from "./engine/fishing-controller.js";

export type { WorldFishId, WorldFishingPhase, WorldFishRarity };
export type WorldFlightCamMode = "overview" | "chase";

export interface WorldFishCatchRecord {
  readonly fishId: WorldFishId;
  readonly rarity: WorldFishRarity;
  readonly isNew: boolean;
  readonly count: number;
  readonly senderName?: string | undefined;
  readonly caughtAt: number;
}

/**
 * 「더 월드」 전환 상태 머신 및 UI 선호·상호작용 스토어.
 *
 * 진입(`closed → diving → open`)과 탈출(`open → escaping → closed`) 타이밍을 단일 원천으로 관리하며,
 * 심즈/MMORPG 스타일 방사형 상호작용 메뉴(`radial`) · 하단 시네마틱 RPG 대화창(`dialogue`) · 우측 작전 수첩 드로어(`chat`·`goals`·`info`·`settings`) 흐름을 소유한다.
 */

const DIVE_DURATION_MS = 1_120;
const ESCAPE_DURATION_MS = 820;
const REDUCED_TRANSITION_MS = 180;
const SOUND_MUTED_STORAGE_KEY = "fleet.theWorld.soundMuted.v1";
const BGM_ENABLED_STORAGE_KEY = "fleet.theWorld.bgmEnabled.v1";
const VILLAGE_BIOMES_STORAGE_KEY = "fleet.theWorld.villageBiomes.v1";
const WEATHER_MODE_STORAGE_KEY = "fleet.theWorld.weatherMode.v1";
const ADMIRAL_STYLE_STORAGE_KEY = "fleet.theWorld.admiralStyle.v2";
const COMMODORE_GIFTS_STORAGE_KEY = "fleet.theWorld.commodoreGifts.v1";
const DISTRICT_NOTES_STORAGE_KEY = "fleet.theWorld.districtNotes.v1";
const UNLOCKED_STAMPS_STORAGE_KEY = "fleet.theWorld.unlockedStamps.v1";
const AURORA_ENABLED_STORAGE_KEY = "fleet.theWorld.auroraEnabled.v1";
const CAUGHT_FISH_STORAGE_KEY = "fleet.theWorld.caughtFishCounts.v1";
const MAX_DISTRICT_NOTE_LEN = 240;

export const WORLD_STAMP_IDS = [
  "first_dive",
  "squadron_flight",
  "campfire_party",
  "rain_umbrella_walk",
  "photo_snap",
  "sky_ring_combo",
  "tier5_citadel",
  "objective_celebration",
] as const;

export type WorldStampId = (typeof WORLD_STAMP_IDS)[number];

export type WorldUnlockableCosmeticKind = "flower_crown" | "aurora" | "rainbow";

export const COSMETIC_UNLOCK_THRESHOLDS: Readonly<Record<WorldUnlockableCosmeticKind, number>> = {
  flower_crown: 2,
  aurora: 4,
  rainbow: 6,
};

export function isCosmeticUnlocked(
  unlockedCount: number,
  kind: WorldUnlockableCosmeticKind | string,
): boolean {
  if (kind === "flower_crown") return unlockedCount >= COSMETIC_UNLOCK_THRESHOLDS.flower_crown;
  if (kind === "aurora") return unlockedCount >= COSMETIC_UNLOCK_THRESHOLDS.aurora;
  if (kind === "rainbow") return unlockedCount >= COSMETIC_UNLOCK_THRESHOLDS.rainbow;
  return true;
}

const WORLD_STAMP_ID_SET: ReadonlySet<string> = new Set(WORLD_STAMP_IDS);

function isWorldStampId(value: unknown): value is WorldStampId {
  return typeof value === "string" && WORLD_STAMP_ID_SET.has(value);
}

const DEFAULT_ADMIRAL_STYLE: WorldAdmiralStyle = {
  tone: "amber",
  hat: "admiral",
  cape: "starlight",
  trail: "stardust",
};

function isVillageBiome(value: unknown): value is WorldVillageBiome {
  return value === "meadow" || value === "sakura" || value === "citadel" || value === "autumn";
}

function isWeatherMode(value: unknown): value is WorldWeatherMode {
  return value === "clear" || value === "sakura" || value === "rain" || value === "snow";
}

function isAdmiralHat(value: unknown): value is WorldAdmiralHat {
  return (
    value === "admiral"
    || value === "crown"
    || value === "explorer"
    || value === "flower_crown"
    || value === "none"
  );
}

function isAdmiralCape(value: unknown): value is WorldAdmiralCape {
  return (
    value === "starlight"
    || value === "hero"
    || value === "forest"
    || value === "aurora"
    || value === "none"
  );
}

function isAdmiralTrail(value: unknown): value is WorldAdmiralTrail {
  return value === "stardust" || value === "sakura" || value === "rainbow" || value === "none";
}

function readInitialUnlockedStamps(): readonly WorldStampId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UNLOCKED_STAMPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: WorldStampId[] = [];
    for (const item of parsed) {
      if (isWorldStampId(item) && !result.includes(item)) {
        result.push(item);
      }
    }
    return result;
  } catch {
    return [];
  }
}

function persistUnlockedStamps(stamps: readonly WorldStampId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UNLOCKED_STAMPS_STORAGE_KEY, JSON.stringify(stamps));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialAuroraEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AURORA_ENABLED_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function persistAuroraEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AURORA_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

const WORLD_FISH_ID_SET: ReadonlySet<string> = new Set(WORLD_FISH_IDS);

function readInitialCaughtFishCounts(): Readonly<Record<string, number>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CAUGHT_FISH_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (WORLD_FISH_ID_SET.has(key) && typeof val === "number" && Number.isFinite(val) && val > 0) {
        sanitized[key] = Math.floor(val);
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function persistCaughtFishCounts(counts: Readonly<Record<string, number>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAUGHT_FISH_STORAGE_KEY, JSON.stringify(counts));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialBgmEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BGM_ENABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistBgmEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BGM_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

function readInitialCommodoreGifts(): Readonly<Record<string, WorldAdmiralHat>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COMMODORE_GIFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized: Record<string, WorldAdmiralHat> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && key.length <= 128 && isAdmiralHat(val)) {
        sanitized[key] = val;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function persistCommodoreGifts(gifts: Readonly<Record<string, WorldAdmiralHat>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMMODORE_GIFTS_STORAGE_KEY, JSON.stringify(gifts));
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
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
      cape: isAdmiralCape(parsed.cape) ? parsed.cape : DEFAULT_ADMIRAL_STYLE.cape,
      trail: isAdmiralTrail(parsed.trail) ? parsed.trail : DEFAULT_ADMIRAL_STYLE.trail,
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

export interface WorldSkyQuickMenu {
  readonly districtId: string;
  readonly commodoreId: string;
  readonly actorId: string;
  readonly x: number;
  readonly y: number;
}

export interface WorldPhotoSnapshotPreview {
  readonly dataUrl: string;
  readonly savedAt: number;
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
  readonly companionActorIds: readonly string[];
  readonly emoteWheelOpen: boolean;
  readonly skyQuickMenu: WorldSkyQuickMenu | null;
  readonly photoSnapshotPreview: WorldPhotoSnapshotPreview | null;
  readonly pendingChatMention: {
    readonly nonce: number;
    readonly actorId: string;
    readonly actorIds?: readonly string[] | undefined;
    readonly prefillText?: string | undefined;
  } | null;
  readonly questBoardOpen: boolean;
  readonly warRoomOpen: boolean;
  readonly admiralCustomizerOpen: boolean;
  readonly gazetteOpen: boolean;
  readonly stampBookOpen: boolean;
  readonly unlockedStamps: readonly WorldStampId[];
  readonly cinemaMode: boolean;
  readonly cinemaSpotlight: string;
  readonly bgmEnabled: boolean;
  readonly commodoreGifts: Readonly<Record<string, WorldAdmiralHat>>;
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
  readonly flightCamMode: WorldFlightCamMode;
  readonly auroraEnabled: boolean;
  readonly fishingPhase: WorldFishingPhase;
  readonly lastFishCatch: WorldFishCatchRecord | null;
  readonly caughtFishCounts: Readonly<Record<string, number>>;
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
  companionActorIds: [],
  emoteWheelOpen: false,
  skyQuickMenu: null,
  photoSnapshotPreview: null,
  pendingChatMention: null,
  questBoardOpen: false,
  warRoomOpen: false,
  admiralCustomizerOpen: false,
  gazetteOpen: false,
  stampBookOpen: false,
  unlockedStamps: readInitialUnlockedStamps(),
  cinemaMode: false,
  cinemaSpotlight: "",
  bgmEnabled: readInitialBgmEnabled(),
  commodoreGifts: readInitialCommodoreGifts(),
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
  flightCamMode: "overview",
  auroraEnabled: readInitialAuroraEnabled(),
  fishingPhase: "idle",
  lastFishCatch: null,
  caughtFishCounts: readInitialCaughtFishCounts(),
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
    companionActorIds: [],
    emoteWheelOpen: false,
    skyQuickMenu: null,
    photoSnapshotPreview: null,
    pendingChatMention: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
    chatActive: false,
    photoMode: false,
    sittingAtCampfire: false,
    overviewMode: false,
    flightCamMode: "overview",
    fishingPhase: "idle",
    lastFishCatch: null,
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
    companionActorIds: [],
    emoteWheelOpen: false,
    skyQuickMenu: null,
    photoSnapshotPreview: null,
    pendingChatMention: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
    chatActive: false,
    photoMode: false,
    sittingAtCampfire: false,
    overviewMode: false,
    flightCamMode: "overview",
    fishingPhase: "idle",
    lastFishCatch: null,
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
        companionActorIds: [],
        emoteWheelOpen: false,
        skyQuickMenu: null,
        photoSnapshotPreview: null,
        pendingChatMention: null,
        questBoardOpen: false,
        warRoomOpen: false,
        admiralCustomizerOpen: false,
        gazetteOpen: false,
        stampBookOpen: false,
        cinemaMode: false,
        cinemaSpotlight: "",
        chatActive: false,
        photoMode: false,
        sittingAtCampfire: false,
        overviewMode: false,
        flightCamMode: "overview",
        fishingPhase: "idle",
        lastFishCatch: null,
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    chatActive: false,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    chatActive: false,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
          emoteWheelOpen: false,
          skyQuickMenu: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          gazetteOpen: false,
          stampBookOpen: false,
          cinemaMode: false,
          cinemaSpotlight: "",
          chatActive: false,
        }
      : {
          photoSnapshotPreview: null,
        }),
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
  const nextCape = patch.cape !== undefined && isAdmiralCape(patch.cape) ? patch.cape : state.admiralStyle.cape;
  const nextTrail = patch.trail !== undefined && isAdmiralTrail(patch.trail) ? patch.trail : state.admiralStyle.trail;
  if (
    nextTone === state.admiralStyle.tone
    && nextHat === state.admiralStyle.hat
    && nextCape === state.admiralStyle.cape
    && nextTrail === state.admiralStyle.trail
  ) {
    return;
  }
  const nextStyle: WorldAdmiralStyle = {
    tone: nextTone,
    hat: nextHat,
    cape: nextCape,
    trail: nextTrail,
  };
  persistAdmiralStyle(nextStyle);
  state = { ...state, admiralStyle: nextStyle };
  emit();
}

export function openGazette(): void {
  if (
    state.gazetteOpen
    && state.selectedActorId === null
    && state.interactionMode === "closed"
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
    && !state.stampBookOpen
    && !state.cinemaMode
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    gazetteOpen: true,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function closeGazette(): void {
  if (!state.gazetteOpen) return;
  state = { ...state, gazetteOpen: false };
  emit();
}

export function toggleGazette(): void {
  if (state.gazetteOpen) closeGazette();
  else openGazette();
}

export function unlockStamp(id: WorldStampId): boolean {
  if (!isWorldStampId(id)) return false;
  if (state.unlockedStamps.includes(id)) return false;
  const next: readonly WorldStampId[] = [...state.unlockedStamps, id];
  persistUnlockedStamps(next);
  state = { ...state, unlockedStamps: next };
  emit();
  return true;
}

export function setStampBookOpen(open: boolean): void {
  if (!open) {
    if (!state.stampBookOpen) return;
    state = { ...state, stampBookOpen: false };
    emit();
    return;
  }
  if (
    state.stampBookOpen
    && state.selectedActorId === null
    && state.interactionMode === "closed"
    && state.selectedDistrictId === null
    && state.districtContextMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
    && !state.gazetteOpen
    && !state.cinemaMode
    && !state.photoMode
    && !state.overviewMode
  ) {
    return;
  }
  state = {
    ...state,
    stampBookOpen: true,
    selectedActorId: null,
    interactionMode: "closed",
    inspectedObjectiveId: null,
    selectedDistrictId: null,
    districtContextMenu: null,
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
    photoMode: false,
    overviewMode: false,
  };
  emit();
}

export function openStampBook(): void {
  setStampBookOpen(true);
}

export function closeStampBook(): void {
  setStampBookOpen(false);
}

export function toggleStampBook(): void {
  setStampBookOpen(!state.stampBookOpen);
}

export function setCinemaMode(enabled: boolean): void {
  if (state.cinemaMode === enabled) return;
  state = {
    ...state,
    cinemaMode: enabled,
    ...(enabled
      ? {
          selectedActorId: null,
          interactionMode: "closed" as const,
          inspectedObjectiveId: null,
          selectedDistrictId: null,
          districtContextMenu: null,
          emoteWheelOpen: false,
          skyQuickMenu: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          gazetteOpen: false,
          stampBookOpen: false,
          chatActive: false,
          photoMode: false,
          overviewMode: false,
          sittingAtCampfire: false,
        }
      : {
          cinemaSpotlight: "",
        }),
  };
  emit();
}

export function toggleCinemaMode(): void {
  setCinemaMode(!state.cinemaMode);
}

export function setCinemaSpotlight(label: string): void {
  if (state.cinemaSpotlight === label) return;
  state = { ...state, cinemaSpotlight: label };
  emit();
}

export function setBgmEnabled(enabled: boolean): void {
  if (state.bgmEnabled === enabled) return;
  persistBgmEnabled(enabled);
  state = { ...state, bgmEnabled: enabled };
  emit();
}

export function toggleBgm(): void {
  setBgmEnabled(!state.bgmEnabled);
}

export function setCommodoreGift(commodoreId: string, hat: WorldAdmiralHat | null): void {
  if (!commodoreId) return;
  if (hat !== null && !isAdmiralHat(hat)) return;
  const current = state.commodoreGifts[commodoreId] ?? null;
  if (current === hat) return;
  const next: Record<string, WorldAdmiralHat> = { ...state.commodoreGifts };
  if (hat === null) {
    delete next[commodoreId];
  } else {
    next[commodoreId] = hat;
  }
  persistCommodoreGifts(next);
  state = { ...state, commodoreGifts: next };
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
    cinemaMode: false,
    cinemaSpotlight: "",
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
          selectedDistrictId: null,
          districtContextMenu: null,
          emoteWheelOpen: false,
          skyQuickMenu: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          gazetteOpen: false,
          stampBookOpen: false,
          cinemaMode: false,
          cinemaSpotlight: "",
          sittingAtCampfire: false,
        }
      : {
          skyQuickMenu: null,
        }),
  };
  emit();
}

export function toggleOverviewMode(): void {
  setOverviewMode(!state.overviewMode);
}

export function setFlightCamMode(mode: WorldFlightCamMode): void {
  if (state.flightCamMode === mode) return;
  state = { ...state, flightCamMode: mode };
  emit();
}

export function toggleFlightCamMode(): void {
  setFlightCamMode(state.flightCamMode === "overview" ? "chase" : "overview");
}

export function setAuroraEnabled(enabled: boolean): void {
  if (state.auroraEnabled === enabled) return;
  persistAuroraEnabled(enabled);
  state = { ...state, auroraEnabled: enabled };
  emit();
}

export function toggleAuroraEnabled(): void {
  setAuroraEnabled(!state.auroraEnabled);
}

export function setFishingState(
  phase: WorldFishingPhase,
  lastCatch?: WorldFishCatchRecord | null,
): void {
  const nextCatch = lastCatch === undefined ? state.lastFishCatch : lastCatch;
  if (state.fishingPhase === phase && state.lastFishCatch === nextCatch) return;
  state = {
    ...state,
    fishingPhase: phase,
    lastFishCatch: nextCatch,
  };
  emit();
}

export function recordFishCatch(
  fishId: WorldFishId,
  options?: { readonly rarity?: WorldFishRarity; readonly senderName?: string },
): WorldFishCatchRecord {
  const spec = WORLD_FISH_SPECS.find((s) => s.id === fishId);
  const rarity: WorldFishRarity = options?.rarity ?? spec?.rarity ?? "common";
  const prevCount = state.caughtFishCounts[fishId] ?? 0;
  const nextCount = prevCount + 1;
  const nextCounts: Readonly<Record<string, number>> = {
    ...state.caughtFishCounts,
    [fishId]: nextCount,
  };
  persistCaughtFishCounts(nextCounts);
  const record: WorldFishCatchRecord = {
    fishId,
    rarity,
    isNew: prevCount === 0,
    count: nextCount,
    ...(options?.senderName ? { senderName: options.senderName } : {}),
    caughtAt: Date.now(),
  };
  state = {
    ...state,
    fishingPhase: "caught",
    lastFishCatch: record,
    caughtFishCounts: nextCounts,
  };
  emit();
  return record;
}

export function clearLastFishCatch(): void {
  if (state.lastFishCatch === null) return;
  state = { ...state, lastFishCatch: null };
  emit();
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
    && !state.emoteWheelOpen
    && state.skyQuickMenu === null
    && !state.questBoardOpen
    && !state.warRoomOpen
    && !state.admiralCustomizerOpen
    && !state.gazetteOpen
    && !state.stampBookOpen
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
    emoteWheelOpen: false,
    skyQuickMenu: null,
    questBoardOpen: false,
    warRoomOpen: false,
    admiralCustomizerOpen: false,
    gazetteOpen: false,
    stampBookOpen: false,
  };
  emit();
}

export function addCompanionActorId(id: string): void {
  if (!id) return;
  if (state.companionActorIds.includes(id)) return;
  state = { ...state, companionActorIds: [...state.companionActorIds, id] };
  emit();
}

export function removeCompanionActorId(id: string): void {
  if (!id || !state.companionActorIds.includes(id)) return;
  state = {
    ...state,
    companionActorIds: state.companionActorIds.filter((existing) => existing !== id),
  };
  emit();
}

export function toggleCompanionActorId(id: string): void {
  if (!id) return;
  if (state.companionActorIds.includes(id)) {
    removeCompanionActorId(id);
  } else {
    addCompanionActorId(id);
  }
}

export function clearCompanionActorIds(): void {
  if (state.companionActorIds.length === 0) return;
  state = { ...state, companionActorIds: [] };
  emit();
}

export function setEmoteWheelOpen(open: boolean): void {
  if (state.emoteWheelOpen === open) return;
  state = {
    ...state,
    emoteWheelOpen: open,
    ...(open
      ? {
          districtContextMenu: null,
          skyQuickMenu: null,
          interactionMode: "closed" as const,
          selectedActorId: null,
          questBoardOpen: false,
          warRoomOpen: false,
          admiralCustomizerOpen: false,
          gazetteOpen: false,
          stampBookOpen: false,
          photoMode: false,
          cinemaMode: false,
          cinemaSpotlight: "",
        }
      : {}),
  };
  emit();
}

export function toggleEmoteWheel(): void {
  setEmoteWheelOpen(!state.emoteWheelOpen);
}

export function setSkyQuickMenu(menu: WorldSkyQuickMenu | null): void {
  if (state.skyQuickMenu === null && menu === null) return;
  state = {
    ...state,
    skyQuickMenu: menu,
    ...(menu ? { districtContextMenu: null, emoteWheelOpen: false } : {}),
  };
  emit();
}

export function openSkyQuickMenu(menu: WorldSkyQuickMenu): void {
  setSkyQuickMenu(menu);
}

export function closeSkyQuickMenu(): void {
  setSkyQuickMenu(null);
}

export function setPhotoSnapshotPreview(preview: WorldPhotoSnapshotPreview | null): void {
  if (state.photoSnapshotPreview === null && preview === null) return;
  state = { ...state, photoSnapshotPreview: preview };
  emit();
}

export function clearPhotoSnapshotPreview(): void {
  setPhotoSnapshotPreview(null);
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
