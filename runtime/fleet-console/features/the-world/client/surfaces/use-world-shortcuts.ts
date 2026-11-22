import { useEffect, type RefObject } from "react";

import { WORLD_CAMPFIRE_BENCH_POS } from "../../shared/world-types.js";
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
  closeQuestBoard,
  closeSkyQuickMenu,
  closeWarRoom,
  deactivateChat,
  exitTheWorld,
  getWorldStoreSnapshot,
  openActorRadialMenu,
  openGazette,
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
 * - `E`: 근접 캐릭터 방사형 메뉴 열기/닫기
 * - `M`: RTS 하늘 조망 모드 토글
 * - `C`: 시네마 관전(작업 동반자) 모드 토글
 * - `G`: 오늘의 초원 일보 모달 토글
 * - `P`: 포토 모드(UI 숨김) 토글
 * - `F`: 모닥불 벤치 불멍 착석/기상
 * - `1` / `2` / `3`: 제독 퀵 감정표현(`wave` / `cheer` / `jump`)
 * - `?` / `H`: 조작 가이드 모달 토글
 * - `Shift+D`: 디버그 패널 노출 토글
 * - `Escape`: 포토 → 시네마 → 모달 → 불멍 → 채팅 → 상호작용 → 하늘 조망 → 월드 탈출 우선순위 해제
 */

/** 모닥불 벤치 `F` 키 우선 판정 반경 (`world-stage.tsx` 근접 칩과 단일 기준 공유). */
export const CAMPFIRE_F_PRIORITY_RADIUS = 3.2;

export interface UseWorldShortcutsOptions {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly lastPlayerPoseRef: RefObject<{ readonly x: number; readonly z: number }>;
  readonly controlsGuideOpenRef: RefObject<boolean>;
  readonly nearParadeBellRef: RefObject<boolean>;
  readonly nearCampfireRef: RefObject<boolean>;
  readonly nearFishingWaterRef: RefObject<boolean>;
  readonly onToggleControlsGuide: () => void;
  readonly onCloseControlsGuide: () => void;
  readonly onToggleDebugPanel: () => void;
  readonly onFocusNextUrgentActor: () => void;
  readonly onToggleFlightCam: () => void;
  readonly onRingParadeBell: () => void;
  readonly onStartFishing: () => void;
  readonly onReelFishing: () => void;
  readonly onCancelFishing: () => void;
  readonly isReducedMotion: () => boolean;
}

export function useWorldShortcuts({
  rootRef,
  lastPlayerPoseRef,
  controlsGuideOpenRef,
  nearParadeBellRef,
  nearCampfireRef,
  nearFishingWaterRef,
  onToggleControlsGuide,
  onCloseControlsGuide,
  onToggleDebugPanel,
  onFocusNextUrgentActor,
  onToggleFlightCam,
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

      // G: 오늘의 초원 일보 모달 토글
      if (
        event.code === "KeyG"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.gazetteOpen) {
          event.preventDefault();
          closeGazette();
          return;
        }
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode) {
          event.preventDefault();
          playDistrictSelect();
          openGazette();
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

      // V: 하늘 비행 중 에이스 추격 / 전략 조망 시점 전환
      if (
        event.code === "KeyV"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.overviewMode && snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode) {
          event.preventDefault();
          onToggleFlightCam();
          return;
        }
      }

      if (event.code === "KeyM" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.cinemaMode) {
          event.preventDefault();
          playOverviewToggle(!snap.overviewMode);
          toggleOverviewMode();
          return;
        }
      }

      if (event.code === "KeyF" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.cinemaMode && !snap.overviewMode) {
          if (snap.sittingAtCampfire) {
            event.preventDefault();
            setSittingAtCampfire(false);
            return;
          }
          // 하단 근접 칩과 1:1 동일한 단일 우선순위: 모닥불 바로 앞(`nearCampfire`) → 시냇가(`nearFishingWater`) → 광장 반경 내 모닥불
          if (nearCampfireRef.current) {
            event.preventDefault();
            playDistrictSelect();
            setSittingAtCampfire(true);
            return;
          }
          if (nearFishingWaterRef.current && snap.fishingPhase === "idle") {
            event.preventDefault();
            onStartFishing();
            return;
          }
          const pose = lastPlayerPoseRef.current;
          const px = Number.isNaN(pose.x) ? 0.4 : pose.x;
          const pz = Number.isNaN(pose.z) ? 2.2 : pose.z;
          const distCampfire = Math.hypot(px - WORLD_CAMPFIRE_BENCH_POS.x, pz - WORLD_CAMPFIRE_BENCH_POS.z);
          if (distCampfire <= 10.5) {
            event.preventDefault();
            playDistrictSelect();
            setSittingAtCampfire(true);
            return;
          }
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

      if (event.code === "KeyE" && !anyModalOpen && !snap.photoMode && !snap.cinemaMode) {
        if (snap.interactionMode === "radial") {
          event.preventDefault();
          closeActorInteraction();
          return;
        }
        if (snap.interactionMode === "closed" && nearParadeBellRef.current && !snap.nearActorId) {
          event.preventDefault();
          onRingParadeBell();
          return;
        }
        if (snap.interactionMode === "closed" && snap.nearActorId) {
          event.preventDefault();
          playMongleChirp();
          openActorRadialMenu(snap.nearActorId);
          return;
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
    isReducedMotion,
    lastPlayerPoseRef,
    nearFishingWaterRef,
    nearParadeBellRef,
    onCancelFishing,
    onCloseControlsGuide,
    onFocusNextUrgentActor,
    onReelFishing,
    onRingParadeBell,
    onStartFishing,
    onToggleControlsGuide,
    onToggleDebugPanel,
    onToggleFlightCam,
    rootRef,
  ]);
}
