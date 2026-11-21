import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import {
  playCameraShutter,
  playEmoteSparkle,
  playPhotoShutter,
} from "../engine/world-audio.js";
import { getWorldT } from "../i18n/index.js";
import {
  clearPhotoSnapshotPreview,
  setPhotoSnapshotPreview,
  type WorldPhotoSnapshotPreview,
} from "../world-store.js";
import { WorldIcon } from "./world-icons.js";

const FLASH_DURATION_MS = 350;
const POLAROID_PREVIEW_MS = 5_500;

export interface WorldPhotoStudioProps {
  readonly open: boolean;
  readonly locale: ConsoleLocale | undefined;
  readonly snapshotPreview: WorldPhotoSnapshotPreview | null;
  readonly onGroupPose: () => void;
  readonly onCapture: () => string | null;
  readonly onExit: () => void;
  readonly onStatusBanner: (msg: string) => void;
}

/**
 * 포토 스튜디오 플로팅 셔터 바 (`P`).
 *
 * 포토 모드(`is-photo-mode`)에서 다른 모든 HUD가 숨겨져도 이 컨트롤 바만 노출되며,
 * 단체 카메라 포즈 유도 · 0.35초 셔터 플래시 + PNG 자동 저장 · 5.5초 폴라로이드 프리뷰를 제공한다.
 */
export const WorldPhotoStudio = memo(function WorldPhotoStudio({
  open,
  locale,
  snapshotPreview,
  onGroupPose,
  onCapture,
  onExit,
  onStatusBanner,
}: WorldPhotoStudioProps) {
  const t = getWorldT(locale);
  const [flashNonce, setFlashNonce] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const flashTimerRef = useRef<number | null>(null);
  const previewTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
  }, []);

  const handleGroupPose = useCallback(() => {
    playEmoteSparkle("cheer");
    onGroupPose();
    onStatusBanner(t("theWorld.photo.poseToast"));
  }, [onGroupPose, onStatusBanner, t]);

  const handleCapture = useCallback(() => {
    playCameraShutter();
    setFlashing(true);
    setFlashNonce((n) => n + 1);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlashing(false);
    }, FLASH_DURATION_MS);

    const dataUrl = onCapture();
    if (dataUrl) {
      try {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `the-world-meadow-${stamp}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch {
        // 다운로드 차단 환경에서도 프리뷰 토스트는 유지한다.
      }
      setPhotoSnapshotPreview({ dataUrl, savedAt: Date.now() });
      if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        clearPhotoSnapshotPreview();
      }, POLAROID_PREVIEW_MS);
    }
    onStatusBanner(t("theWorld.photo.savedToast"));
  }, [onCapture, onStatusBanner, t]);

  const handleExit = useCallback(() => {
    playPhotoShutter();
    onExit();
  }, [onExit]);

  if (!open && !flashing && !snapshotPreview) return null;

  return (
    <>
      {flashing ? (
        <div key={flashNonce} className="the-world-photo-flash" aria-hidden="true" />
      ) : null}

      {snapshotPreview ? (
        <div
          className="the-world-polaroid-toast"
          role="status"
          aria-live="polite"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <img
            className="the-world-polaroid-img"
            src={snapshotPreview.dataUrl}
            alt=""
            aria-hidden="true"
          />
          <span className="the-world-polaroid-caption">{t("theWorld.photo.savedToast")}</span>
        </div>
      ) : null}

      {open ? (
        <div
          className="the-world-photo-studio-bar"
          role="toolbar"
          aria-label={t("theWorld.photo.studioAria")}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="the-world-photo-studio-btn is-pose"
            onClick={handleGroupPose}
          >
            <WorldIcon name="cheer" size={14} tone="teal" />
            <span>{t("theWorld.photo.groupPose")}</span>
          </button>

          <button
            type="button"
            className="the-world-photo-studio-btn is-snap"
            onClick={handleCapture}
          >
            <WorldIcon name="camera" size={14} tone="inherit" />
            <span>{t("theWorld.photo.snap")}</span>
          </button>

          <button
            type="button"
            className="the-world-photo-studio-btn is-exit"
            aria-label={t("theWorld.photoMode.exitAria")}
            onClick={handleExit}
          >
            <WorldIcon name="close" size={13} tone="inherit" />
            <span>{t("theWorld.photo.exit")}</span>
          </button>
        </div>
      ) : null}
    </>
  );
});
