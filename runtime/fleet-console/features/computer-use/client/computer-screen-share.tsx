import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../../core/client/src/i18n/index.js";
import { getState, setOperationUseRequestIds, subscribe as subscribeStore } from "../../../core/client/src/integration/store.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/operations-sse.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import "../../execution/client/agent/computer-screen-share.css";

type CaptureTarget = { id: string; operationId: string; title: string };
type Capture = { target: CaptureTarget; stream: MediaStream | null; failed: boolean; retry?: () => void };
const CaptureContext = createContext<Capture | null>(null);
/** 패널 안 허용 요청 — 서버가 붙잡아 둔 호출 하나(합쳐진 도구 이름·막힌 사유·시한). 인자·내용은 없다. */
export interface OperationUseRequest {
  readonly id: string;
  readonly operationId: string;
  readonly capability: "console" | "computer";
  readonly tools: readonly string[];
  readonly blocked: "experiment_disabled" | null;
  readonly expiresAt: number;
}
type OperationUseActivity = {
  console: string[];
  computer: string[];
  browser: string[];
  requests: OperationUseRequest[];
  grants: { console: string[]; computer: string[] };
};
const EMPTY_ACTIVITY: OperationUseActivity = { console: [], computer: [], browser: [], requests: [], grants: { console: [], computer: [] } };
const OperationUseContext = createContext<OperationUseActivity>(EMPTY_ACTIVITY);
export function useOperationUse(operationId: string) {
  const activity = useContext(OperationUseContext);
  return {
    console: activity.console.includes(operationId),
    computer: activity.computer.includes(operationId),
    browser: activity.browser.includes(operationId),
    /** 「이번 작업만」 허가로 쓰는 중인 도구군. */
    turnOnly: { console: activity.grants.console.includes(operationId), computer: activity.grants.computer.includes(operationId) },
  };
}
/** 이 Operation 이 답을 기다리는 허용 요청(도구군마다 하나). */
export function useOperationUseRequests(operationId: string, childSessionIds: readonly string[] = []): readonly OperationUseRequest[] {
  const activity = useContext(OperationUseContext);
  const represented = new Set([operationId, ...childSessionIds]);
  return activity.requests.filter((request) => represented.has(request.operationId));
}
/** 이 Console 이 답을 기다리는 허용 요청 전부 — Map 우하단 더미가 Operation 을 가리지 않고 모은다. */
export function useAllOperationUseRequests(): readonly OperationUseRequest[] {
  return useContext(OperationUseContext).requests;
}

function readRequests(value: unknown): OperationUseRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OperationUseRequest[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.operationId !== "string" || (record.capability !== "console" && record.capability !== "computer") || typeof record.expiresAt !== "number") return [];
    const tools = Array.isArray(record.tools) ? record.tools.filter((tool): tool is string => typeof tool === "string") : [];
    return [{ id: record.id, operationId: record.operationId, capability: record.capability, tools, blocked: record.blocked === "experiment_disabled" ? "experiment_disabled" : null, expiresAt: record.expiresAt }];
  });
}

/** operation-use 스냅샷(SSE 프레임과 /api/v1/operation-use 응답이 같은 모양)을 읽는다. */
function readActivity(value: unknown): OperationUseActivity {
  if (!value || typeof value !== "object") return EMPTY_ACTIVITY;
  const record = value as Record<string, unknown>;
  const ids = (v: unknown) => Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : [];
  const requests = readRequests(record.requests);
  const grants = record.grants as { console?: unknown; computer?: unknown } | undefined;
  return { console: ids(record.console), computer: ids(record.computer), browser: ids(record.browser), requests, grants: { console: ids(grants?.console), computer: ids(grants?.computer) } };
}

/** 영상 수명은 Console가, 표시 위치는 해당 Operation이 소유한다. */
export function ComputerScreenShareProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [activity, setActivity] = useState<OperationUseActivity>(EMPTY_ACTIVITY);
  useEffect(() => {
    let disposed = false;
    // 스트림이 먼저 말을 걸었는가. mount 1회 조회가 늦게 돌아와 낡은 값을 되돌리지 않게 한다.
    let streamed = false;
    const apply = (value: unknown) => {
      if (disposed) return;
      const next = readActivity(value);
      setActivity(next);
      setOperationUseRequestIds(next.requests.map((request) => request.operationId));
    };
    const unsubscribe = subscribeConsoleChannel("operation-use:state", (payload) => {
      streamed = true;
      apply(payload);
    });
    // 최초 mount 는 connectOperationsSse 가 연 스트림의 핸드셰이크 스냅샷보다 늦게 붙을 수 있다 — 1회 조회로 그 틈을 메운다.
    // 이후 변화는 스트림이, 재연결은 서버가 다시 보내는 핸드셰이크 스냅샷이 채운다.
    void fetch("/api/v1/operation-use", { signal: AbortSignal.timeout(3000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("operation_use_unavailable");
        const body = await response.json();
        if (!streamed) apply(body);
      })
      .catch(() => undefined);
    return () => { disposed = true; unsubscribe(); setOperationUseRequestIds([]); };
  }, []);
  useEffect(() => {
    if (!isDesktopShell()) return;
    let disposed = false;
    let currentId: string | null = null;
    let stream: MediaStream | null = null;
    let acquiring = false;
    let desiredTarget: CaptureTarget | null = null;
    let attemptedId: string | null = null;
    let streamed = false;
    let captureGeneration = 0;
    const controller = new AbortController();
    const stop = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    const startCapture = () => {
      const target = desiredTarget;
      if (disposed || !target || stream || acquiring || attemptedId === target.id) return;
      attemptedId = target.id;
      void acquire(target);
    };
    const retry = () => {
      if (!disposed && !acquiring) { attemptedId = null; setCapture(null); startCapture(); }
    };
    const acquire = async (target: CaptureTarget) => {
      const generation = captureGeneration;
      acquiring = true;
      try {
        const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
        if (disposed || generation !== captureGeneration || currentId !== target.id) { next.getTracks().forEach((track) => track.stop()); return; }
        stream = next;
        next.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (stream !== next) return;
          stop();
          if (!disposed) setCapture({ target, stream: null, failed: true, retry });
        }, { once: true });
        setCapture({ target, stream: next, failed: false });
      } catch (error) {
        if (!disposed && generation === captureGeneration && currentId === target.id) {
          console.warn("Computer capture unavailable", error instanceof Error ? error.name : "unknown");
          setCapture({ target, stream: null, failed: true, retry });
        }
      } finally { acquiring = false; startCapture(); }
    };
    const apply = (value: unknown) => {
      if (disposed || !value || typeof value !== "object") return;
      const { target, unavailableOperationId } = value as { target: CaptureTarget | null; unavailableOperationId?: string | null };
      desiredTarget = target;
      if (!target && unavailableOperationId) {
        stop();
        currentId = null;
        attemptedId = null;
        setCapture({ target: { id: `unavailable:${unavailableOperationId}`, operationId: unavailableOperationId, title: "" }, stream: null, failed: true });
        return;
      }
      if (!target) setCapture(null);
      if ((target?.id ?? null) !== currentId) {
        stop();
        currentId = target?.id ?? null;
        attemptedId = null;
        setCapture(null);
      }
      // 같은 실패 대상은 자동으로 재시도하지 않는다. 새 대상이나 명시적 재시도만 획득을 재개한다.
      startCapture();
    };
    const unsubscribe = subscribeConsoleChannel("computer-capture:state", (payload) => {
      streamed = true;
      apply(payload);
    });
    const releaseOfflineCapture = () => {
      if (getState().connection !== "offline") return;
      // 마지막 해제 프레임 없이 끊겨도 로컬 캡처는 멈춘다. 늦은 GET·획득 결과도 되살리지 못한다.
      streamed = true;
      captureGeneration++;
      stop();
      currentId = null;
      attemptedId = null;
      desiredTarget = null;
      setCapture(null);
    };
    const unsubscribeConnection = subscribeStore(releaseOfflineCapture);
    releaseOfflineCapture();
    // mount가 핸드셰이크보다 늦으면 한 번만 보정한다. 재연결과 이후 변화는 SSE가 맡는다.
    void fetch("/api/v1/desktop/computer-capture", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error("capture_target_unavailable");
        const body: unknown = await response.json();
        if (!streamed) apply(body);
      })
      .catch(() => undefined);
    return () => { disposed = true; controller.abort(); unsubscribe(); unsubscribeConnection(); stop(); };
  }, []);
  return <OperationUseContext.Provider value={activity}><CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider></OperationUseContext.Provider>;
}

export function ComputerScreenShare({ operationId }: { operationId: string }) {
  const t = useT();
  const capture = useContext(CaptureContext);
  const video = useRef<HTMLVideoElement | null>(null);
  const own = capture?.target.operationId === operationId ? capture : null;
  const card = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 256, height: 144 });
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const preferredSize = useRef<{ width: number; height: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; scaleX: number; scaleY: number; resizing: boolean; width: number; height: number } | null>(null);
  useEffect(() => {
    const element = card.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const resize = () => {
      const settings = own?.stream?.getVideoTracks()[0]?.getSettings();
      const ratio = (settings?.width || 16) / (settings?.height || 9);
      const preferred = preferredSize.current;
      const width = Math.max(1, Math.min(preferred?.width ?? Math.min(256, 256 * ratio), parent.clientWidth - 24));
      const height = Math.max(1, Math.min(preferred?.height ?? width / ratio, parent.clientHeight - 24));
      setSize({ width, height });
      setPosition((previous) => previous ? {
        x: Math.max(0, Math.min(previous.x, parent.clientWidth - width)),
        y: Math.max(0, Math.min(previous.y, parent.clientHeight - height)),
      } : null);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [own?.stream, own?.target.id]);
  useEffect(() => {
    const element = video.current;
    if (!element || !own?.stream) return;
    element.srcObject = own.stream;
    void element.play().catch(() => undefined);
    return () => { element.srcObject = null; };
  }, [own?.stream]);
  if (!own) return null;
  return <aside ref={card} className={`computer-screen-share${dragging ? " is-dragging" : ""}${maximized && own.stream ? " is-maximized" : ""}`} aria-label={t("settings.computerUse.sharePreview")}
    style={maximized && own.stream ? { inset: 0, width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%" } : { width: own.stream ? size.width : 256, height: own.stream ? size.height : undefined, ...(position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : {}) }}
    onPointerDown={(event) => {
      const resizing = event.target instanceof Element && Boolean(event.target.closest(".computer-screen-share-resize"));
      if (event.button !== 0 || (maximized && own.stream) || (!resizing && event.target instanceof Element && event.target.closest("button"))) return;
      const element = event.currentTarget;
      const parent = element.parentElement;
      if (!parent) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = parent.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const scaleX = bounds.width / parent.offsetWidth || 1;
      const scaleY = bounds.height / parent.offsetHeight || 1;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: (rect.left - bounds.left) / scaleX, top: (rect.top - bounds.top) / scaleY, scaleX, scaleY, resizing, width: element.offsetWidth, height: element.offsetHeight };
      if (resizing) setPosition({ x: drag.current.left, y: drag.current.top });
      element.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      const element = event.currentTarget;
      const parent = element.parentElement;
      if (!start || start.id !== event.pointerId || !parent) return;
      event.stopPropagation();
      if (start.resizing) {
        const next = {
          width: Math.min(parent.clientWidth - start.left, Math.max(96, start.width + (event.clientX - start.x) / start.scaleX)),
          height: Math.min(parent.clientHeight - start.top, Math.max(72, start.height + (event.clientY - start.y) / start.scaleY)),
        };
        preferredSize.current = next;
        setSize(next);
        return;
      }
      setPosition({
        x: Math.max(0, Math.min(start.left + (event.clientX - start.x) / start.scaleX, parent.clientWidth - element.offsetWidth)),
        y: Math.max(0, Math.min(start.top + (event.clientY - start.y) / start.scaleY, parent.clientHeight - element.offsetHeight)),
      });
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      event.stopPropagation();
      drag.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onClick={(event) => event.stopPropagation()}>
    {own.stream ? <><video ref={video} muted playsInline aria-label={t("settings.computerUse.sharePreview")} />
      <button type="button" className="computer-screen-share-maximize" aria-label={t(maximized ? "settings.computerUse.shareRestore" : "settings.computerUse.shareMaximize")} title={t(maximized ? "settings.computerUse.shareRestore" : "settings.computerUse.shareMaximize")} onClick={() => setMaximized((value) => !value)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{maximized ? <><path d="M5 5V2h9v9h-3" /><rect x="2" y="5" width="9" height="9" rx="1" /></> : <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" />}</svg>
      </button>
      {!maximized ? <button type="button" className="computer-screen-share-resize" aria-label={t("settings.computerUse.shareResize")} onKeyDown={(event) => {
        const direction = { ArrowRight: [16, 0], ArrowLeft: [-16, 0], ArrowDown: [0, 16], ArrowUp: [0, -16] }[event.key];
        const parent = card.current?.parentElement;
        if (!direction || !parent) return;
        event.preventDefault(); event.stopPropagation();
        const next = { width: Math.min(parent.clientWidth - (position?.x ?? 12), Math.max(96, size.width + direction[0]!)), height: Math.min(parent.clientHeight - (position?.y ?? 12), Math.max(72, size.height + direction[1]!)) };
        preferredSize.current = next; setSize(next);
      }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m5 13 8-8m-3 8 3-3" /></svg></button> : null}
    </> : <><p role="status">{t("settings.computerUse.shareError")}</p>{own.retry ? <button type="button" className="computer-screen-share-retry" onClick={own.retry}>{t("settings.computerUse.shareRetry")}</button> : <p>{t("settings.computerUse.sharePermission")}</p>}</>}
  </aside>;
}
