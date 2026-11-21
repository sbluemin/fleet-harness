import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { useEffect, useRef, useState } from "react";

import type { WorldPlayerScreenLabel, WorldScreenLabel } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { createWorldRuntime, type WorldRuntimeHandle } from "../engine/world-runtime.js";
import { getWorldT } from "../i18n/index.js";
import { useWorldSnapshot } from "../world-projection.js";
import {
  closeActorInteraction,
  exitTheWorld,
  getWorldStoreSnapshot,
  openActorRadialMenu,
  setNearWorldActor,
  useWorldStore,
} from "../world-store.js";
import { WorldDialogueBox } from "./world-dialogue-box.js";
import { WorldHud } from "./world-hud.js";
import { WorldRadialMenu } from "./world-radial-menu.js";

const DEFAULT_HINT =
  "🌿 WASD/방향키 이동 · Shift 질주 · Space 점프 · 드래그/휠 회전·줌 · E 또는 클릭으로 상호작용 휠 열기";

export default function WorldStage({ deps }: { readonly deps: TheWorldClientDeps }) {
  const store = useWorldStore();
  const snapshot = useWorldSnapshot(deps);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<WorldRuntimeHandle | null>(null);

  const [labels, setLabels] = useState<readonly WorldScreenLabel[]>([]);
  const [playerLabel, setPlayerLabel] = useState<WorldPlayerScreenLabel | null>(null);
  const [statusBanner, setStatusBanner] = useState(DEFAULT_HINT);

  // 월드에 표시되는 사령관들의 모델·상태·보드 준비 정보를 미리 불러와 상호작용·메시지 전송이 즉시 동작하게 한다.
  useEffect(() => {
    for (const actor of snapshot.actors) {
      if (actor.role === "commodore" && actor.commodoreId && deps.commodore.read(actor.commodoreId).view === null) {
        void deps.commodore.load(actor.commodoreId);
      }
    }
  }, [deps, snapshot.actors]);

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

  // 전환/시간/카메라/상호작용 상태 동기화
  useEffect(() => {
    runtimeRef.current?.setMode({
      lifecycle: store.lifecycle,
      timeMode: store.timeMode,
      cameraMode: store.cameraMode,
      interactionMode: store.interactionMode,
      selectedActorId: store.selectedActorId,
    });
  }, [store.lifecycle, store.timeMode, store.cameraMode, store.interactionMode, store.selectedActorId]);

  // 협동 연출 명령 전달
  useEffect(() => {
    if (!store.choreography) return;
    const ran = runtimeRef.current?.runChoreography(store.choreography);
    if (ran === false) {
      setStatusBanner("ℹ️ 이 연출을 재생하려면 진행 중인 Objective 캠프 또는 대상 구성원이 필요합니다.");
    }
  }, [store.choreography]);

  // 심즈 스타일 감정표현/인사 이모트 전달
  const lastEmoteNonceRef = useRef(0);
  useEffect(() => {
    const cmd = store.emoteCommand;
    if (!cmd || cmd.nonce === lastEmoteNonceRef.current) return;
    lastEmoteNonceRef.current = cmd.nonce;
    runtimeRef.current?.playEmote(cmd.actorId, cmd.emote);
  }, [store.emoteCommand]);

  // 대상에게 다가가기 요청 전달
  const lastApproachNonceRef = useRef(0);
  useEffect(() => {
    const req = store.approachRequest;
    if (!req || req.nonce === lastApproachNonceRef.current) return;
    lastApproachNonceRef.current = req.nonce;
    runtimeRef.current?.approachActor(req.actorId);
  }, [store.approachRequest]);

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

  // 선택 대상이 스냅샷에서 사라지면 상호작용 상태를 정리한다.
  useEffect(() => {
    if (store.selectedActorId && !snapshot.actors.some((a) => a.id === store.selectedActorId)) {
      closeActorInteraction();
    }
  }, [snapshot.actors, store.selectedActorId]);

  // 키보드 E(방사형 상호작용 메뉴 토글) · Escape(상호작용 닫기 → 월드 탈출)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) {
          if (event.key === "Escape") {
            event.preventDefault();
            closeActorInteraction();
          }
          return;
        }
      }
      const snap = getWorldStoreSnapshot();
      if (snap.lifecycle !== "open") return;

      if (event.code === "KeyE") {
        if (snap.interactionMode === "radial") {
          event.preventDefault();
          closeActorInteraction();
          return;
        }
        if (snap.interactionMode === "closed" && snap.nearActorId) {
          event.preventDefault();
          openActorRadialMenu(snap.nearActorId);
          return;
        }
      }

      if (event.key === "Escape") {
        // 다른 전역 모달(승인 목록·검색 팔레트 등)이 열려 있으면 양보한다.
        if (document.querySelector('[aria-modal="true"]:not([hidden])')) return;
        event.preventDefault();
        if (snap.interactionMode !== "closed") {
          closeActorInteraction();
          return;
        }
        exitTheWorld({ reducedMotion: deps.isReducedMotion() });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deps]);

  // 캔버스 클릭 피킹 (드래그 회전과 구분)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const selectedActor = snapshot.actors.find((a) => a.id === store.selectedActorId) ?? null;
  const selectedAnchorLabel = selectedActor
    ? (labels.find((l) => l.actorId === selectedActor.id) ?? null)
    : null;
  const locale = deps.commodore.language();
  const t = getWorldT(locale);
  const bottomDialogueOpen =
    selectedActor !== null && (store.interactionMode === "dialogue" || store.interactionMode === "inspect");

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
          if (hitId) {
            openActorRadialMenu(hitId);
          } else if (store.interactionMode !== "closed") {
            closeActorInteraction();
          }
        }}
      />

      <div
        className={`the-world-warp-veil${store.lifecycle === "diving" || store.lifecycle === "escaping" ? " is-active" : ""}`}
        aria-hidden="true"
      />

      <div className="the-world-labels">
        {playerLabel && store.interactionMode === "closed" ? (
          <div
            className="the-world-actor-anchor"
            style={{ left: `${playerLabel.x.toFixed(1)}px`, top: `${playerLabel.y.toFixed(1)}px` }}
            aria-hidden="true"
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
          const hideForRadial = store.interactionMode === "radial" && lbl.isSelected;
          const isBackground = store.interactionMode === "radial" && !lbl.isSelected;
          if (hideForRadial) return null;
          return (
            <div
              key={lbl.actorId}
              className={`the-world-actor-anchor${isDistant ? " is-distant" : ""}${isBackground ? " is-background" : ""}`}
              style={{ left: `${lbl.x.toFixed(1)}px`, top: `${lbl.y.toFixed(1)}px` }}
            >
              {lbl.speech ? <span className="the-world-speech">{lbl.speech}</span> : null}
              {lbl.isNearPlayer && store.interactionMode === "closed" ? (
                <button
                  type="button"
                  className="the-world-interact-prompt"
                  aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
                  onClick={() => openActorRadialMenu(lbl.actorId)}
                >
                  <span className="the-world-keycap">E</span>
                  <span>상호작용</span>
                </button>
              ) : null}
              <button
                type="button"
                className={`the-world-nametag${lbl.isSelected ? " is-selected" : ""}`}
                aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
                onClick={() => openActorRadialMenu(lbl.actorId)}
              >
                <span className="the-world-tone-dot" data-tone={lbl.tone} />
                <span>
                  {lbl.quaker ? "🦜 " : lbl.role === "commodore" ? "★ " : lbl.role === "commander" ? "📡 " : ""}
                  {lbl.name}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {store.lifecycle === "open" ? (
        <>
          <WorldHud
            snapshot={snapshot}
            locale={locale}
            reducedMotion={deps.isReducedMotion()}
            statusBanner={statusBanner}
            hideBottom={bottomDialogueOpen}
            onStatusBanner={setStatusBanner}
          />
          {store.interactionMode === "radial" && selectedActor ? (
            <WorldRadialMenu
              actor={selectedActor}
              anchorLabel={selectedAnchorLabel}
              isNear={store.nearActorId === selectedActor.id}
              deps={deps}
              onStatusBanner={setStatusBanner}
            />
          ) : null}
          {bottomDialogueOpen && selectedActor ? (
            <WorldDialogueBox
              actor={selectedActor}
              mode={store.interactionMode === "inspect" ? "inspect" : "dialogue"}
              deps={deps}
              onStatusBanner={setStatusBanner}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
