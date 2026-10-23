import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../../core/client/src/i18n/index.js";
import { getState, setObjectiveUseRequestIds, subscribe as subscribeStore } from "../../../core/client/src/integration/store.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import "../../execution/client/agent/computer-screen-share.css";

/** 화면의 주인(objectiveId — 공유 컨텍스트면 루트)과 지금 조작하는 참가자(actor). */
type CaptureTarget = { id: string; objectiveId: string; actor: string | null; title: string };
/** 공유 불가의 사람이 고칠 수 있는 원인(서버의 비민감 사유 코드). 없으면 일반 식별 실패다. */
type CaptureFailure = "accessibility_permission_required" | "screen_recording_permission_required";
type Capture = { target: CaptureTarget; stream: MediaStream | null; failed: boolean; retry?: () => void; failure?: CaptureFailure };
/** 창을 든 Desktop에게 손쉬운 사용 권한을 묻거나 화면 기록 설정을 열게 한다. 서버는 실제로 그 사유로 막혀 있을 때만 로컬 셸에 넘긴다. */
const DESKTOP_WINDOW_COMMAND_PATH = "/api/v1/desktop/window/command";
/** Desktop이 읽어 둔 화면 기록 사유. 프로토콜의 DESKTOP_SCREEN_PERMISSION_PATH 와 같다. 브라우저 번들은 node 프로토콜을 가져오지 않는다. */
const DESKTOP_SCREEN_PERMISSION_PATH = "/api/v1/desktop/screen-permission";
const SCREEN_RECORDING_PERMISSION_REASON = "screen_recording_permission_required" as const;

/** 캡처가 거절된 뒤에만 묻는다. 고정 코드가 아니면 사유 없음으로 보아 일반 재시도를 유지한다. */
async function readScreenRecordingFailure(): Promise<typeof SCREEN_RECORDING_PERMISSION_REASON | undefined> {
  try {
    const response = await fetch(DESKTOP_SCREEN_PERMISSION_PATH, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    return (body as { reason?: unknown }).reason === SCREEN_RECORDING_PERMISSION_REASON ? SCREEN_RECORDING_PERMISSION_REASON : undefined;
  } catch {
    return undefined;
  }
}
const CaptureContext = createContext<Capture | null>(null);
/** 패널 안 허용 요청 — 서버가 붙잡아 둔 호출 하나(합쳐진 도구 이름·시한). 인자·내용은 없다. */
export interface ObjectiveUseRequest {
  readonly id: string;
  readonly objectiveId: string;
  readonly capability: "console" | "computer";
  readonly tools: readonly string[];
  /** 이 요청을 기다리는 참가자(호출한 세션). 공유 컨텍스트에서는 루트(objectiveId)와 다를 수 있다. */
  readonly requestedBy: readonly string[];
  readonly expiresAt: number;
}
type ObjectiveUseActivity = {
  console: string[];
  computer: string[];
  /** 컴퓨터를 지금 조작하는 참가자 — 공유 컨텍스트에서는 기기의 주인(computer, 루트)과 다르다. */
  computerActor: string | null;
  browser: string[];
  requests: ObjectiveUseRequest[];
  grants: { console: string[]; computer: string[] };
};
const EMPTY_ACTIVITY: ObjectiveUseActivity = { console: [], computer: [], computerActor: null, browser: [], requests: [], grants: { console: [], computer: [] } };
const ObjectiveUseContext = createContext<ObjectiveUseActivity>(EMPTY_ACTIVITY);
export function useObjectiveUse(objectiveId: string) {
  const activity = useContext(ObjectiveUseContext);
  return {
    console: activity.console.includes(objectiveId),
    computer: activity.computer.includes(objectiveId),
    browser: activity.browser.includes(objectiveId),
    /** 「이번 작업만」 허가로 쓰는 중인 도구군. */
    turnOnly: { console: activity.grants.console.includes(objectiveId), computer: activity.grants.computer.includes(objectiveId) },
  };
}
/** 이 Objective 이 답을 기다리는 허용 요청(도구군마다 하나). */
export function useObjectiveUseRequests(objectiveId: string, childSessionIds: readonly string[] = []): readonly ObjectiveUseRequest[] {
  const activity = useContext(ObjectiveUseContext);
  const represented = new Set([objectiveId, ...childSessionIds]);
  return activity.requests.filter((request) => represented.has(request.objectiveId));
}
/** 이 Objective(공유 컨텍스트면 루트)의 컴퓨터를 지금 조작하는 참가자. 쓰지 않으면 null. */
export function useComputerActor(objectiveId: string): string | null {
  const activity = useContext(ObjectiveUseContext);
  return activity.computer.includes(objectiveId) ? activity.computerActor ?? objectiveId : null;
}
/** 이 Console 이 답을 기다리는 허용 요청 전부 — Map 우하단 더미가 Objective 을 가리지 않고 모은다. */
export function useAllObjectiveUseRequests(): readonly ObjectiveUseRequest[] {
  return useContext(ObjectiveUseContext).requests;
}

function readRequests(value: unknown): ObjectiveUseRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ObjectiveUseRequest[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.objectiveId !== "string" || (record.capability !== "console" && record.capability !== "computer") || typeof record.expiresAt !== "number") return [];
    const tools = Array.isArray(record.tools) ? record.tools.filter((tool): tool is string => typeof tool === "string") : [];
    const requestedBy = Array.isArray(record.requestedBy) ? record.requestedBy.filter((id): id is string => typeof id === "string") : [];
    return [{ id: record.id, objectiveId: record.objectiveId, capability: record.capability, tools, requestedBy: requestedBy.length > 0 ? requestedBy : [record.objectiveId], expiresAt: record.expiresAt }];
  });
}

/** objective-use 스냅샷(SSE 프레임과 /api/v1/objective-use 응답이 같은 모양)을 읽는다. */
function readActivity(value: unknown): ObjectiveUseActivity {
  if (!value || typeof value !== "object") return EMPTY_ACTIVITY;
  const record = value as Record<string, unknown>;
  const ids = (v: unknown) => Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : [];
  const requests = readRequests(record.requests);
  const grants = record.grants as { console?: unknown; computer?: unknown } | undefined;
  return { console: ids(record.console), computer: ids(record.computer), computerActor: typeof record.computerActor === "string" ? record.computerActor : null, browser: ids(record.browser), requests, grants: { console: ids(grants?.console), computer: ids(grants?.computer) } };
}

/** 영상 수명은 Console가, 표시 위치는 해당 Objective이 소유한다. */
export function ComputerScreenShareProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [activity, setActivity] = useState<ObjectiveUseActivity>(EMPTY_ACTIVITY);
  useEffect(() => {
    let disposed = false;
    // 스트림이 먼저 말을 걸었는가. mount 1회 조회가 늦게 돌아와 낡은 값을 되돌리지 않게 한다.
    let streamed = false;
    const apply = (value: unknown) => {
      if (disposed) return;
      const next = readActivity(value);
      setActivity(next);
      setObjectiveUseRequestIds(next.requests.map((request) => request.objectiveId));
    };
    const unsubscribe = subscribeConsoleChannel("objective-use:state", (payload) => {
      streamed = true;
      apply(payload);
    });
    // 최초 mount 는 connectObjectiveRecordsSse 가 연 스트림의 핸드셰이크 스냅샷보다 늦게 붙을 수 있다 — 1회 조회로 그 틈을 메운다.
    // 이후 변화는 스트림이, 재연결은 서버가 다시 보내는 핸드셰이크 스냅샷이 채운다.
    void fetch("/api/v1/objective-use", { signal: AbortSignal.timeout(3000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("objectiveRecord_use_unavailable");
        const body = await response.json();
        if (!streamed) apply(body);
      })
      .catch(() => undefined);
    return () => { disposed = true; unsubscribe(); setObjectiveUseRequestIds([]); };
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
          const failure = await readScreenRecordingFailure();
          if (!disposed && generation === captureGeneration && currentId === target.id) {
            setCapture({ target, stream: null, failed: true, retry, ...(failure ? { failure } : {}) });
          }
        }
      } finally { acquiring = false; startCapture(); }
    };
    const apply = (value: unknown) => {
      if (disposed || !value || typeof value !== "object") return;
      const raw = value as { target: (Omit<CaptureTarget, "actor"> & { actor?: unknown }) | null; unavailableObjectiveId?: string | null; unavailableReason?: unknown };
      const target: CaptureTarget | null = raw.target ? { ...raw.target, actor: typeof raw.target.actor === "string" ? raw.target.actor : null } : null;
      const unavailableObjectiveId = raw.unavailableObjectiveId;
      desiredTarget = target;
      if (!target && unavailableObjectiveId) {
        stop();
        currentId = null;
        attemptedId = null;
        const failure: CaptureFailure | undefined = raw.unavailableReason === "accessibility_permission_required" ? raw.unavailableReason : undefined;
        setCapture({ target: { id: `unavailable:${unavailableObjectiveId}`, objectiveId: unavailableObjectiveId, actor: null, title: "" }, stream: null, failed: true, ...(failure ? { failure } : {}) });
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
  return <ObjectiveUseContext.Provider value={activity}><CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider></ObjectiveUseContext.Provider>;
}

/** 이 Objective(공유 컨텍스트면 루트)의 화면을 지금 공유하는 중인가 — 영상 수명은 Desktop 셸만 가진다. */
export function useComputerShareActive(objectiveId: string): boolean {
  return useContext(CaptureContext)?.target.objectiveId === objectiveId;
}

/**
 * 폰 배치에서 본문 위에 떠 있는 상단 막대의 몫(px) — 셸이 `--m-chrome-top`으로 물려준다. 데스크톱에는 그 속성이 없어 0이다.
 * 카드를 끌거나 키울 때 이 몫 위로는 올라가지 않는다(막대에 가리면 카드를 다시 잡을 수 없다).
 */
function chromeTopInset(element: Element): number {
  return Number.parseFloat(getComputedStyle(element).getPropertyValue("--m-chrome-top")) || 0;
}

/**
 * 떠 있는 화면공유 미리보기. `actor` 를 주면 미리보기 왼쪽 위에 조작자 칩을 그린다(공유 컨텍스트의 그룹채팅 — 누가 조작하는지는
 * 그 화면이 안다). `className` 은 놓이는 자리의 배치 손잡이다.
 */
export function ComputerScreenShare({ objectiveId, actor, className }: { objectiveId: string; actor?: (participantId: string) => ReactNode; className?: string }) {
  const t = useT();
  const capture = useContext(CaptureContext);
  const actorId = useComputerActor(objectiveId) ?? capture?.target.actor ?? null;
  const video = useRef<HTMLVideoElement | null>(null);
  const own = capture?.target.objectiveId === objectiveId ? capture : null;
  const card = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 256, height: 144 });
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  /** 이 실패에 대해 권한 요청을 보냈는가. 다른 실패(새 대상·다른 사유)가 오면 버튼을 되살린다. */
  const [accessibilityRequested, setAccessibilityRequested] = useState<string | null>(null);
  /** 이 실패에 대해 화면 기록 설정을 열었는가. 다른 대상이 오면 버튼을 되살린다. */
  const [screenSettingsOpened, setScreenSettingsOpened] = useState<string | null>(null);
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
      const inset = chromeTopInset(element);
      const width = Math.max(1, Math.min(preferred?.width ?? Math.min(256, 256 * ratio), parent.clientWidth - 24));
      const height = Math.max(1, Math.min(preferred?.height ?? width / ratio, parent.clientHeight - 24 - inset));
      setSize({ width, height });
      setPosition((previous) => previous ? {
        x: Math.max(0, Math.min(previous.x, parent.clientWidth - width)),
        y: Math.max(inset, Math.min(previous.y, parent.clientHeight - height)),
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
  // 칩은 영상 위에는 겹쳐도 되지만 문구(실패·권한 안내) 위에는 겹치면 안 된다 — 영상이 없을 때는 CSS 가 칩을 본문 위 한 줄로 내린다.
  const chip = actor && actorId ? actor(actorId) : null;
  return <aside ref={card} className={`computer-screen-share${className ? ` ${className}` : ""}${chip ? " has-actor" : ""}${own.stream ? " is-streaming" : ""}${dragging ? " is-dragging" : ""}${maximized && own.stream ? " is-maximized" : ""}`} aria-label={t("settings.computerUse.sharePreview")}
    // 최대화는 폰 배치의 떠 있는 상단 막대 아래에서 멈춘다(데스크톱은 막대 몫이 없어 틀 전체).
    style={maximized && own.stream ? { inset: "var(--m-chrome-top, 0px) 0 0 0", width: "100%", height: "calc(100% - var(--m-chrome-top, 0px))", maxWidth: "100%", maxHeight: "calc(100% - var(--m-chrome-top, 0px))" } : { width: own.stream ? size.width : 256, height: own.stream ? size.height : undefined, ...(position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : {}) }}
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
        y: Math.max(chromeTopInset(element), Math.min(start.top + (event.clientY - start.y) / start.scaleY, parent.clientHeight - element.offsetHeight)),
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
    {chip ? <span className="computer-screen-share-actor">{chip}</span> : null}
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
    </> : <><p role="status">{t("settings.computerUse.shareError")}</p>{own.failure === "screen_recording_permission_required" ? <>
        <p>{t("settings.computerUse.shareScreenRecording")}</p>
        <p>{t("settings.computerUse.shareScreenRecordingRestart")}</p>
        {screenSettingsOpened === own.target.id ? <p>{t("settings.computerUse.shareScreenRecordingOpened")}</p>
          : <button type="button" className="computer-screen-share-retry" onClick={() => {
            setScreenSettingsOpened(own.target.id);
            void fetch(DESKTOP_WINDOW_COMMAND_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "open-screen-recording-settings" }), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
          }}>{t("settings.computerUse.shareScreenRecordingOpen")}</button>}
        {own.retry ? <button type="button" className="computer-screen-share-retry" onClick={own.retry}>{t("settings.computerUse.shareRetry")}</button> : null}
      </> : own.retry ? <button type="button" className="computer-screen-share-retry" onClick={own.retry}>{t("settings.computerUse.shareRetry")}</button>
      : own.failure === "accessibility_permission_required" ? <>
        <p>{t("settings.computerUse.shareAccessibility")}</p>
        {accessibilityRequested === own.target.id ? <p>{t("settings.computerUse.shareAccessibilityRequested")}</p>
          : <button type="button" className="computer-screen-share-retry" onClick={() => {
            setAccessibilityRequested(own.target.id);
            void fetch(DESKTOP_WINDOW_COMMAND_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "request-accessibility-permission" }), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
          }}>{t("settings.computerUse.shareAccessibilityRequest")}</button>}
      </> : <p>{t("settings.computerUse.sharePermission")}</p>}</>}
  </aside>;
}
