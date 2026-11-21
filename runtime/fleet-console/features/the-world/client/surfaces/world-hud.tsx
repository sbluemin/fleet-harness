import type { ConsoleLocale } from "@fleet-console/i18n";
import { useState } from "react";

import { ApprovalCapsule } from "../../../execution/client/approval/panel.js";
import type { WorldCameraMode, WorldSnapshot, WorldTimeMode } from "../../shared/world-types.js";
import { getWorldT } from "../i18n/index.js";
import {
  exitTheWorld,
  openActorRadialMenu,
  requestApproachActor,
  requestWorldTeleport,
  setWorldCameraMode,
  setWorldTimeMode,
  triggerWorldChoreography,
  useWorldStore,
} from "../world-store.js";

const TIME_MODES: readonly { readonly id: WorldTimeMode; readonly label: string }[] = [
  { id: "day", label: "☀️ 낮" },
  { id: "sunset", label: "🌅 노을" },
  { id: "night", label: "🌙 밤" },
  { id: "cycle", label: "⏱ 순환" },
  { id: "realtime", label: "🕒 현실시간" },
];

const CAMERA_MODES: readonly { readonly id: WorldCameraMode; readonly label: string }[] = [
  { id: "follow", label: "🎮 3인칭 추적" },
  { id: "orbit", label: "🏞️ 초원 조망" },
];

export function WorldHud({
  snapshot,
  locale,
  reducedMotion,
  statusBanner,
  hideBottom,
  onStatusBanner,
}: {
  readonly snapshot: WorldSnapshot;
  readonly locale: ConsoleLocale | undefined;
  readonly reducedMotion: boolean;
  readonly statusBanner: string;
  readonly hideBottom: boolean;
  readonly onStatusBanner: (msg: string) => void;
}) {
  const store = useWorldStore();
  const [simExpanded, setSimExpanded] = useState(false);
  const t = getWorldT(locale);
  const attentionActor = snapshot.actors.find((a) => a.needsAttention) ?? null;

  return (
    <>
      <div className="the-world-hud-top">
        <div className="the-world-hud-cluster">
          <div className="the-world-bar" role="group" aria-label={t("theWorld.hud.timeGroupAria")}>
            {TIME_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`the-world-btn${store.timeMode === item.id ? " is-active" : ""}`}
                onClick={() => setWorldTimeMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="the-world-bar" role="group" aria-label={t("theWorld.hud.cameraGroupAria")}>
            {CAMERA_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`the-world-btn${store.cameraMode === item.id ? " is-active" : ""}`}
                onClick={() => setWorldCameraMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="the-world-hud-cluster">
          <ApprovalCapsule />
          {attentionActor ? (
            <div className="the-world-bar">
              <button
                type="button"
                className="the-world-btn is-attention"
                onClick={() => {
                  requestApproachActor(attentionActor.id);
                  openActorRadialMenu(attentionActor.id);
                }}
              >
                🔔 확인 필요 ({attentionActor.name})
              </button>
            </div>
          ) : null}
          <div className="the-world-bar">
            <button
              type="button"
              className="the-world-btn"
              onClick={() => exitTheWorld({ reducedMotion })}
            >
              🌀 콘솔로 탈출 (Esc)
            </button>
          </div>
        </div>
      </div>

      {!hideBottom ? (
        <div className="the-world-hud-bottom">
          <div className="the-world-hud-stack">
            <div className="the-world-hint">{statusBanner}</div>

            <div className="the-world-bar" role="group" aria-label={t("theWorld.hud.simGroupAria")}>
              <button
                type="button"
                className={`the-world-btn${simExpanded ? " is-active" : ""}`}
                title={t("theWorld.hud.simToggleTitle")}
                onClick={() => setSimExpanded((prev) => !prev)}
              >
                🎬 연출 {simExpanded ? "▾" : "▸"}
              </button>
              {simExpanded ? (
                <>
                  <button
                    type="button"
                    className="the-world-btn"
                    onClick={() => {
                      triggerWorldChoreography("delegate");
                      onStatusBanner("📜 사령관이 초원 오솔길 너머로 청사진을 보내고 지휘관이 구성원을 브리핑 테이블로 소집합니다.");
                    }}
                  >
                    📜 목표 하달 & 소집
                  </button>
                  <button
                    type="button"
                    className="the-world-btn"
                    onClick={() => {
                      triggerWorldChoreography("report");
                      onStatusBanner("🎁 구성원이 결과물 상자를 들고 지휘관에게 달려가 보고한 뒤 점프 몸통 하이파이브를 나눕니다.");
                    }}
                  >
                    🎁 보고 & 하이파이브
                  </button>
                  <button
                    type="button"
                    className="the-world-btn"
                    onClick={() => {
                      triggerWorldChoreography("handoff");
                      onStatusBanner("🔑 선행 구현 구성원과 후속 검증 구성원이 캠프 앞마당에서 커밋 바통을 터치합니다.");
                    }}
                  >
                    🔑 바통 터치
                  </button>
                  <button
                    type="button"
                    className="the-world-btn"
                    onClick={() => {
                      triggerWorldChoreography("celebrate");
                      onStatusBanner("🎉 초원 전 구역의 사령관·지휘관·구성원들이 회전 점프와 별꽃 축포로 목표 완수를 축하합니다!");
                    }}
                  >
                    🎉 완수 축포
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className="the-world-bar" role="group" aria-label={t("theWorld.hud.teleportGroupAria")}>
            <span className="the-world-bar-label">🧭 구역 이동:</span>
            {snapshot.zones.map((zone) => (
              <button
                key={zone.id}
                type="button"
                className="the-world-btn the-world-zone-btn"
                onClick={() => requestWorldTeleport(zone.x, zone.z)}
              >
                <span className="the-world-zone-text">{zone.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
