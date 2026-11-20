import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { useEffect, useRef, useState } from "react";

import type { WorldPlayerScreenLabel, WorldScreenLabel } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { createWorldRuntime, type WorldRuntimeHandle } from "../engine/world-runtime.js";
import { getWorldT } from "../i18n/index.js";
import { useWorldSnapshot } from "../world-projection.js";
import {
  closeWorldDrawer,
  exitTheWorld,
  getWorldStoreSnapshot,
  selectWorldActor,
  setNearWorldActor,
  useWorldStore,
} from "../world-store.js";
import { WorldHud } from "./world-hud.js";
import { WorldTacticalSheet } from "./world-tactical-sheet.js";

const DEFAULT_HINT =
  "🌿 WASD/방향키 초원 이동(조망 모드에서는 시점 패닝) · Shift 질주 · Space 점프 · 마우스 드래그/휠 360° 회전/줌 · E 또는 클릭으로 플릿 제어";

export default function WorldStage({ deps }: { readonly deps: TheWorldClientDeps }) {
  const store = useWorldStore();
  const snapshot = useWorldSnapshot(deps, store.demoMode, store.extraDemoOutposts);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<WorldRuntimeHandle | null>(null);

  const [labels, setLabels] = useState<readonly WorldScreenLabel[]>([]);
  const [playerLabel, setPlayerLabel] = useState<WorldPlayerScreenLabel | null>(null);
  const [statusBanner, setStatusBanner] = useState(DEFAULT_HINT);

  // Three.js 엔진 초기화 (마운트 시 1회)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastOverlayPush = 0;
    const runtime = createWorldRuntime({
      canvas,
      getFuzz: deps.getAvatarFuzz,
      isReducedMotion: deps.isReducedMotion,
      isLowerUnfocusedFrameRate: deps.isLowerUnfocusedFrameRate,
      onNearActorChanged: (id) => setNearWorldActor(id),
      onFrameOverlay: (nextLabels, nextPlayer) => {
        const now = performance.now();
        if (now - lastOverlayPush < 30) return;
        lastOverlayPush = now;
        setLabels(nextLabels);
        setPlayerLabel(nextPlayer);
      },
    });
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [deps]);

  // 실시간 월드 스냅샷 동기화
  useEffect(() => {
    runtimeRef.current?.applySnapshot(snapshot);
  }, [snapshot]);

  // 전환/시간/카메라/선택 상태 동기화
  useEffect(() => {
    runtimeRef.current?.setMode({
      lifecycle: store.lifecycle,
      timeMode: store.timeMode,
      cameraMode: store.cameraMode,
      selectedActorId: store.selectedActorId,
    });
  }, [store.lifecycle, store.timeMode, store.cameraMode, store.selectedActorId]);

  // 협동 시뮬레이션 명령 전달
  useEffect(() => {
    if (store.choreography) {
      runtimeRef.current?.runChoreography(store.choreography);
    }
  }, [store.choreography]);

  // 텔레포트 요청 전달
  useEffect(() => {
    if (store.teleportRequest) {
      runtimeRef.current?.teleport(store.teleportRequest.x, store.teleportRequest.z);
    }
  }, [store.teleportRequest]);

  // 로컬 말풍선 전달
  const appliedSpeechesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [actorId, entry] of Object.entries(store.localSpeeches)) {
      if (appliedSpeechesRef.current[actorId] === entry.nonce) continue;
      appliedSpeechesRef.current[actorId] = entry.nonce;
      runtimeRef.current?.pushSpeech(actorId, entry.text);
    }
  }, [store.localSpeeches]);

  // 키보드 E(근접 대화) · Escape(드로어 닫기 → 월드 탈출 + 콘솔 맥락 복귀)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) return;
      }
      const snap = getWorldStoreSnapshot();
      if (snap.lifecycle !== "open") return;

      if (event.code === "KeyE" && snap.nearActorId) {
        event.preventDefault();
        selectWorldActor(snap.nearActorId, true);
        return;
      }

      if (event.key === "Escape") {
        // 다른 전역 모달(승인 목록·검색 팔레트 등)이 열려 있으면 양보한다.
        if (document.querySelector('[aria-modal="true"]:not([hidden])')) return;
        event.preventDefault();
        if (snap.drawerOpen) {
          closeWorldDrawer();
          return;
        }
        const selected = snapshot.actors.find((a) => a.id === snap.selectedActorId);
        exitTheWorld({
          reducedMotion: deps.isReducedMotion(),
          onExited: () => {
            if (!selected || selected.isDemo) return;
            if (selected.role === "commodore" && selected.commodoreId) {
              deps.openCommodoreInConsole(selected.commodoreId);
            } else if (selected.commodoreId && (selected.rootObjectiveId ?? selected.objectiveId)) {
              deps.openObjectiveInConsole(selected.commodoreId, (selected.rootObjectiveId ?? selected.objectiveId)!);
            }
          },
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deps, snapshot.actors]);

  // 캔버스 클릭 피킹 (드래그 회전과 구분)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const selectedActor = snapshot.actors.find((a) => a.id === store.selectedActorId) ?? null;
  const t = getWorldT(deps.commodore.language());

  return (
    <div
      className={`the-world-root${store.lifecycle === "diving" ? " is-diving" : ""}${store.lifecycle === "escaping" ? " is-escaping" : ""}`}
      role="region"
      aria-label={t("theWorld.stage.aria")}
      {...{ [NATIVE_VIEW_COVER_ATTRIBUTE]: "" }}
    >
      <canvas
        ref={canvasRef}
        className="the-world-canvas"
        onPointerDown={(e) => {
          pointerDownRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const start = pointerDownRef.current;
          pointerDownRef.current = null;
          if (!start || store.lifecycle !== "open") return;
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
          const hitId = runtimeRef.current?.pickActorAt(e.clientX, e.clientY) ?? null;
          if (hitId) selectWorldActor(hitId, true);
        }}
      />

      <div
        className={`the-world-warp-veil${store.lifecycle === "diving" || store.lifecycle === "escaping" ? " is-active" : ""}`}
        aria-hidden="true"
      />

      <div className="the-world-labels" aria-hidden="true">
        {playerLabel ? (
          <div
            className="the-world-actor-anchor"
            style={{ left: `${playerLabel.x.toFixed(1)}px`, top: `${playerLabel.y.toFixed(1)}px` }}
          >
            <span className="the-world-nametag is-player">{playerLabel.label}</span>
          </div>
        ) : null}

        {labels.map((lbl) => {
          const isDistant =
            lbl.distance > 25
            && !lbl.isSelected
            && !lbl.isNearPlayer
            && !lbl.needsAttention
            && !lbl.speech;
          return (
            <div
              key={lbl.actorId}
              className={`the-world-actor-anchor${isDistant ? " is-distant" : ""}`}
              style={{ left: `${lbl.x.toFixed(1)}px`, top: `${lbl.y.toFixed(1)}px` }}
            >
              {lbl.speech ? <span className="the-world-speech">{lbl.speech}</span> : null}
              {lbl.isNearPlayer ? <span className="the-world-interact-prompt">[E] 대화 · 플릿 제어</span> : null}
              <span className={`the-world-nametag${lbl.isSelected ? " is-selected" : ""}`}>
                <span className="the-world-tone-dot" data-tone={lbl.tone} />
                <span>
                  {lbl.quaker ? "🦜 " : lbl.role === "commodore" ? "★ " : lbl.role === "commander" ? "📡 " : ""}
                  {lbl.name}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {store.lifecycle === "open" ? (
        <>
          <WorldHud
            snapshot={snapshot}
            reducedMotion={deps.isReducedMotion()}
            statusBanner={statusBanner}
            onStatusBanner={setStatusBanner}
          />
          {store.drawerOpen && selectedActor ? (
            <WorldTacticalSheet actor={selectedActor} deps={deps} onStatusBanner={setStatusBanner} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
