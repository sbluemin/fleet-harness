import { useEffect, type RefObject } from "react";

import {
  playDistrictSelect,
  playMongleChirp,
  playOverviewToggle,
  playPhotoShutter,
} from "../engine/world-audio.js";
import {
  activateChat,
  closeActorInteraction,
  closeAdmiralCustomizer,
  closeDistrictContextMenu,
  closeGazette,
  closeMailbox,
  closeQuestBoard,
  closeSkyQuickMenu,
  closeWarRoom,
  deactivateChat,
  exitTheWorld,
  getWorldStoreSnapshot,
  openActorRadialMenu,
  requestPlayerEmote,
  setCinemaMode,
  setEmoteWheelOpen,
  setOverviewMode,
  setPhotoMode,
  setSittingAtCampfire,
  setStampBookOpen,
  toggleCinemaMode,
  toggleEmoteWheel,
  toggleOverviewMode,
  togglePhotoMode,
} from "../world-store.js";

/**
 * 「더 월드」 전역 키보드 단축키 훅.
 *
 * - `Enter`: 채팅창 활성화
 * - `Tab`: 확인 필요(`needsAttention`) 사령관에게 즉시 이동 · 대화창 오픈 (순환)
 * - `E`: 통합 상호작용 키 (불멍 기상 · 우체통 · 소집 종 · 사령관 대화 · 모닥불 착석 · 시냇가 낚시, 비행 중에는 고도 상승에 양보)
 * - `F`: 별빛 상공 자유 비행 이륙/착지 토글 (에이스 추격 시점 단일화, 비행 중 `Q`/`E` 고도 하강/상승)
 * - `C`: 시네마 관전(작업 동반자) 모드 토글
 * - `G`: 빠른 마을 이동 팝오버 토글
 * - `P`: 포토 모드(UI 숨김) 토글
 * - `B`: 별 제독 이모트 휠 토글
 * - `1` / `2` / `3`: 제독 퀵 감정표현(`wave` / `cheer` / `jump`)
 * - `?` / `H`: 조작 가이드 모달 토글
 * - `Shift+D`: 디버그 패널 노출 토글
 * - `Escape`: 낚시 → 포토 → 시네마 → 빠른 이동 → 모달 → 불멍 → 채팅 → 상호작용 → 별빛 비행 → 월드 탈출 우선순위 해제
 */

/** 모닥불 벤치 `E` 키 우선 판정 반경 (`world-stage.tsx` 근접 칩과 단일 기준 공유). */
export const CAMPFIRE_F_PRIORITY_RADIUS = 3.2;

export interface UseWorldShortcutsOptions {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly controlsGuideOpenRef: RefObject<boolean>;
  readonly fastTravelOpenRef: RefObject<boolean>;
  readonly nearMailboxRef: RefObject<boolean>;
  readonly nearParadeBellRef: RefObject<boolean>;
  readonly nearCampfireRef: RefObject<boolean>;
  readonly nearFishingWaterRef: RefObject<boolean>;
  readonly onToggleControlsGuide: () => void;
  readonly onCloseControlsGuide: () => void;
  readonly onToggleFastTravel: () => void;
  readonly onCloseFastTravel: () => void;
  readonly onToggleDebugPanel: () => void;
  readonly onFocusNextUrgentActor: () => void;
  readonly onOpenMailbox: () => void;
  readonly onRingParadeBell: () => void;
  readonly onStartFishing: () => void;
  readonly onReelFishing: () => void;
  readonly onCancelFishing: () => void;
  readonly isReducedMotion: () => boolean;
}

export function useWorldShortcuts({
  rootRef,
  controlsGuideOpenRef,
  fastTravelOpenRef,
  nearMailboxRef,
  nearParadeBellRef,
  nearCampfireRef,
  nearFishingWaterRef,
  onToggleControlsGuide,
  onCloseControlsGuide,
  onToggleFastTravel,
  onCloseFastTravel,
  onToggleDebugPanel,
  onFocusNextUrgentActor,
  onOpenMailbox,
  onRingParadeBell,
  onStartFishing,
  onReelFishing,
  onCancelFishing,
  isReducedMotion,
}: UseWorldShortcutsOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.target.blur();
            const current = getWorldStoreSnapshot();
            if (current.skyQuickMenu) {
              closeSkyQuickMenu();
            } else if (fastTravelOpenRef.current) {
              onCloseFastTravel();
            } else if (current.chatActive) {
              deactivateChat();
            } else if (controlsGuideOpenRef.current) {
              onCloseControlsGuide();
            } else if (current.warRoomOpen) {
              closeWarRoom();
            } else if (current.admiralCustomizerOpen) {
              closeAdmiralCustomizer();
            } else if (current.questBoardOpen) {
              closeQuestBoard();
            } else if (current.mailboxOpen) {
              closeMailbox();
            } else if (current.gazetteOpen) {
              closeGazette();
            } else if (current.stampBookOpen) {
              setStampBookOpen(false);
            } else if (current.interactionMode !== "closed" || current.selectedDistrictId !== null) {
              closeActorInteraction();
            }
          }
          return;
        }
      }

      const snap = getWorldStoreSnapshot();
      if (snap.lifecycle !== "open") return;

      const guideOpen = controlsGuideOpenRef.current;
      const anyModalOpen = snap.questBoardOpen
        || snap.mailboxOpen
        || snap.warRoomOpen
        || snap.admiralCustomizerOpen
        || snap.gazetteOpen
        || snap.stampBookOpen
        || guideOpen;

      // Tab: 긴급 확인 필요 사령관 즉시 이동 · 대화창 오픈 (순환)
      if (
        event.key === "Tab"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        if (!anyModalOpen && !snap.chatActive && !snap.photoMode) {
          event.preventDefault();
          onFocusNextUrgentActor();
          return;
        }
      }

      // Shift+D: 디버그 도구 버튼 노출 토글
      if (
        event.code === "KeyD"
        && event.shiftKey
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        event.preventDefault();
        onToggleDebugPanel();
        return;
      }

      // C: 시네마 관전(작업 동반자) 모드 토글
      if (
        event.code === "KeyC"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.cinemaMode) {
          event.preventDefault();
          playOverviewToggle(false);
          setCinemaMode(false);
          return;
        }
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode) {
          event.preventDefault();
          playOverviewToggle(true);
          toggleCinemaMode();
          return;
        }
      }

      // G: 빠른 마을 이동 팝오버 토글 (열릴 때 진행 중인 낚시 자동 취소)
      if (
        event.code === "KeyG"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (fastTravelOpenRef.current) {
          event.preventDefault();
          onCloseFastTravel();
          return;
        }
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode) {
          event.preventDefault();
          if (snap.fishingPhase !== "idle") {
            onCancelFishing();
          }
          playDistrictSelect();
          onToggleFastTravel();
          return;
        }
      }

      // ? 또는 H: 조작 가이드 모달 토글
      if (
        !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && (event.key === "?" || (event.code === "KeyH" && !event.shiftKey))
      ) {
        if (guideOpen) {
          event.preventDefault();
          onCloseControlsGuide();
          return;
        }
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode) {
          event.preventDefault();
          onToggleControlsGuide();
          return;
        }
      }

      // B: 별 제독 방사형 이모트 휠 토글
      if (
        event.code === "KeyB"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.emoteWheelOpen) {
          event.preventDefault();
          setEmoteWheelOpen(false);
          return;
        }
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode && !snap.overviewMode) {
          event.preventDefault();
          playDistrictSelect();
          toggleEmoteWheel();
          return;
        }
      }

      if (
        event.code === "KeyP"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.cinemaMode) {
          event.preventDefault();
          playPhotoShutter();
          togglePhotoMode();
          return;
        }
      }

      if (
        event.key === "Enter"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        const targetEl = event.target instanceof HTMLElement ? event.target : null;
        const isWorldInteractive =
          targetEl !== null
          && Boolean(targetEl.closest(".the-world-root"))
          && (targetEl.tagName === "BUTTON" || targetEl.tagName === "A");
        if (!isWorldInteractive && !snap.photoMode && !snap.cinemaMode && snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive) {
          event.preventDefault();
          activateChat();
          return;
        }
      }

      // Space: 낚시 대기/입질 중 즉시 릴 감기 (모달·채팅·포토·시네마·이모트 휠 비활성 시에만)
      if (
        event.code === "Space"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        if (
          (snap.fishingPhase === "waiting" || snap.fishingPhase === "bite")
          && !anyModalOpen
          && !snap.chatActive
          && !snap.photoMode
          && !snap.cinemaMode
          && !snap.emoteWheelOpen
        ) {
          event.preventDefault();
          onReelFishing();
          return;
        }
      }

      // F: 별빛 상공 자유 비행 이륙/착지 토글 (항상 에이스 추격 시점)
      if (
        event.code === "KeyF"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode) {
          event.preventDefault();
          if (snap.fishingPhase !== "idle") {
            onCancelFishing();
          }
          playOverviewToggle(!snap.overviewMode);
          toggleOverviewMode();
          return;
        }
      }

      if (
        (event.code === "Digit1" || event.code === "Digit2" || event.code === "Digit3")
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.overviewMode && !snap.cinemaMode) {
          event.preventDefault();
          const emote = event.code === "Digit1" ? "wave" : event.code === "Digit2" ? "cheer" : "jump";
          requestPlayerEmote(emote);
          return;
        }
      }

      // E: 통합 상호작용 키 (방사형 닫기 → 불멍 기상 → 우체통 → 소집 종 → 사령관 대화 → 모닥불 착석 → 시냇가 낚시)
      // 주의: 비행 중(`snap.overviewMode === true`)에는 `player-controller.ts`가 `KeyE`(상승)/`KeyQ`(하강)를 소유하므로 지상 상호작용 완전 차단.
      if (
        event.code === "KeyE"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && !anyModalOpen
        && !snap.photoMode
        && !snap.cinemaMode
        && !snap.overviewMode
      ) {
        if (snap.interactionMode === "radial") {
          event.preventDefault();
          closeActorInteraction();
          return;
        }
        if (snap.interactionMode === "closed" && !snap.chatActive) {
          if (snap.sittingAtCampfire) {
            event.preventDefault();
            setSittingAtCampfire(false);
            return;
          }
          if (snap.fishingPhase === "idle" && nearMailboxRef.current) {
            event.preventDefault();
            onOpenMailbox();
            return;
          }
          if (snap.fishingPhase === "idle" && nearParadeBellRef.current) {
            event.preventDefault();
            onRingParadeBell();
            return;
          }
          const nearNonCompanionActorId =
            snap.nearActorId && !snap.companionActorIds.includes(snap.nearActorId)
              ? snap.nearActorId
              : null;
          if (nearNonCompanionActorId) {
            event.preventDefault();
            playMongleChirp();
            openActorRadialMenu(nearNonCompanionActorId);
            return;
          }
          if (snap.fishingPhase === "idle" && nearCampfireRef.current) {
            event.preventDefault();
            playDistrictSelect();
            setSittingAtCampfire(true);
            return;
          }
          if (snap.fishingPhase === "idle" && nearFishingWaterRef.current) {
            event.preventDefault();
            onStartFishing();
            return;
          }
          if (snap.nearActorId) {
            event.preventDefault();
            playMongleChirp();
            openActorRadialMenu(snap.nearActorId);
            return;
          }
        }
      }

      if (event.key === "Escape") {
        // 더 월드 바깥의 콘솔 전역 모달(승인 목록·폴더 선택·새 사령관 모달 등)이 열려 있을 때만 양보한다.
        const hasExternalModal = Array.from(document.querySelectorAll('[aria-modal="true"]:not([hidden])'))
          .some((el) => !rootRef.current?.contains(el));
        if (hasExternalModal) return;
        event.preventDefault();
        if (snap.fishingPhase !== "idle") {
          onCancelFishing();
          return;
        }
        if (snap.photoMode) {
          playPhotoShutter();
          setPhotoMode(false);
          return;
        }
        if (snap.cinemaMode) {
          playOverviewToggle(false);
          setCinemaMode(false);
          return;
        }
        if (guideOpen) {
          onCloseControlsGuide();
          return;
        }
        if (fastTravelOpenRef.current) {
          onCloseFastTravel();
          return;
        }
        if (snap.sittingAtCampfire) {
          setSittingAtCampfire(false);
          return;
        }
        if (snap.emoteWheelOpen) {
          setEmoteWheelOpen(false);
          return;
        }
        if (snap.skyQuickMenu) {
          closeSkyQuickMenu();
          return;
        }
        if (snap.districtContextMenu) {
          closeDistrictContextMenu();
          return;
        }
        if (snap.mailboxOpen) {
          closeMailbox();
          return;
        }
        if (snap.gazetteOpen) {
          closeGazette();
          return;
        }
        if (snap.stampBookOpen) {
          setStampBookOpen(false);
          return;
        }
        if (snap.warRoomOpen) {
          closeWarRoom();
          return;
        }
        if (snap.admiralCustomizerOpen) {
          closeAdmiralCustomizer();
          return;
        }
        if (snap.questBoardOpen) {
          closeQuestBoard();
          return;
        }
        if (snap.chatActive) {
          deactivateChat();
          return;
        }
        if (snap.interactionMode !== "closed" || snap.selectedDistrictId !== null) {
          closeActorInteraction();
          return;
        }
        if (snap.overviewMode) {
          playOverviewToggle(false);
          setOverviewMode(false);
          return;
        }
        exitTheWorld({ reducedMotion: isReducedMotion() });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    controlsGuideOpenRef,
    fastTravelOpenRef,
    isReducedMotion,
    nearCampfireRef,
    nearFishingWaterRef,
    nearMailboxRef,
    nearParadeBellRef,
    onCancelFishing,
    onCloseControlsGuide,
    onCloseFastTravel,
    onFocusNextUrgentActor,
    onOpenMailbox,
    onReelFishing,
    onRingParadeBell,
    onStartFishing,
    onToggleControlsGuide,
    onToggleDebugPanel,
    onToggleFastTravel,
    rootRef,
  ]);
}
