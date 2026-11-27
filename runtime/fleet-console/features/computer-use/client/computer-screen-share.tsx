import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../../core/client/src/i18n/index.js";
import { getState, setObjectiveUseRequestIds, subscribe as subscribeStore } from "../../../core/client/src/integration/store.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import {
  DESKTOP_OFFSCREEN_PREVIEW_STILL_PATH,
  DESKTOP_REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_AFTER_PARAM,
  REMOTE_PREVIEW_AGE_HEADER,
  REMOTE_PREVIEW_FRAME_PATH,
  REMOTE_PREVIEW_INTERVAL_MS,
  REMOTE_PREVIEW_JPEG_QUALITY,
  REMOTE_PREVIEW_MAX_WIDTH,
  REMOTE_PREVIEW_SEQ_HEADER,
  REMOTE_PREVIEW_STALE_MS,
  REMOTE_PREVIEW_STATE_EVENT,
  REMOTE_PREVIEW_STATE_PATH,
  REMOTE_PREVIEW_TARGET_PARAM,
  REMOTE_PREVIEW_VIEWERS_EVENT,
  readRemotePreviewState,
} from "../shared/remote-preview.js";
import "../../execution/client/agent/computer-screen-share.css";

/**
 * 화면의 주인과 지금 조작하는 참가자(actor). 주인은 목표(objectiveId — 공유 컨텍스트면 루트)이거나 사령관(commodoreId)이다.
 * `ownerKind` 가 없는 프레임은 목표 소유로 읽는다.
 */
type CaptureTarget = { id: string; ownerKind?: "objective" | "commodore"; objectiveId: string | null; commodoreId?: string | null; actor: string | null; title: string; offscreen?: boolean; minimized?: boolean };
/** 이 화면의 주인이 그 목표/사령관인가. 사령관을 묻는 쪽은 목표 id 로 겹쳐 읽히지 않는다. */
function targetOwnedBy(target: CaptureTarget, owner: { readonly objectiveId?: string; readonly commodoreId?: string }): boolean {
  return owner.commodoreId !== undefined
    ? target.ownerKind === "commodore" && target.commodoreId === owner.commodoreId
    : target.ownerKind !== "commodore" && target.objectiveId === owner.objectiveId;
}
/** 공유 불가의 사람이 고칠 수 있는 원인(서버의 비민감 사유 코드). 없으면 일반 식별 실패다. */
type CaptureFailure = "accessibility_permission_required" | "screen_recording_permission_required";
/**
 * 원격 full 화면이 받는 정지 화면(결정 8cd1a62d). `url`은 마지막으로 받아 아직 가리지 않은 이미지다.
 * 지연은 마지막 이미지를 두고 경과 시간만 알리고, 거부(403 등)는 이전 이미지를 바로 가린다. `off`는 호스트 설정이 꺼졌음을
 * 서버 상태로 확인했을 때만 참이다 — 거부만으로 꺼졌다고 단정하지 않는다.
 */
type RemoteFrame = { readonly url: string | null; readonly lastFrameAt: number | null; readonly waitingSince: number; readonly off: boolean };
type Capture = { target: CaptureTarget; stream: MediaStream | null; failed: boolean; retry?: () => void; failure?: CaptureFailure; remote?: RemoteFrame; localStillUrl?: string | null };
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
/** 지금 이 창 캡처를 원격 기기가 받아 가는가(서버가 센 시청 세션 수). 호스트 카드의 공유 칩이 읽는다. */
const RemoteViewersContext = createContext(0);

type FrameGrabber = { grabFrame(): Promise<ImageBitmap> };
/**
 * 이미 받은 창 캡처 트랙에서 한 장을 뽑아 가로 480px 이하 JPEG로 만든다. 새 캡처를 열지 않는다 — 원격에 나가는 것은
 * 호스트 카드가 보여 주는 바로 그 창(에이전트가 고른 창 1개)뿐이다.
 */
async function grabRemotePreviewJpeg(track: MediaStreamTrack): Promise<Blob | null> {
  const ImageCaptureCtor = (globalThis as { ImageCapture?: new (track: MediaStreamTrack) => FrameGrabber }).ImageCapture;
  if (!ImageCaptureCtor || typeof OffscreenCanvas === "undefined") return null;
  const bitmap = await new ImageCaptureCtor(track).grabFrame();
  try {
    const scale = Math.min(1, REMOTE_PREVIEW_MAX_WIDTH / Math.max(1, bitmap.width));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: REMOTE_PREVIEW_JPEG_QUALITY });
  } finally {
    bitmap.close();
  }
}

const CaptureContext = createContext<Capture | null>(null);
const VisibleStillCardContext = createContext<(targetId: string, visible: boolean) => void>(() => undefined);

function previewTargetUrl(path: string, targetId: string): string {
  return `${path}?${REMOTE_PREVIEW_TARGET_PARAM}=${encodeURIComponent(targetId)}`;
}

function uploadPreviewStill(targetId: string, jpeg: Blob, signal: AbortSignal) {
  return fetch(previewTargetUrl(DESKTOP_REMOTE_PREVIEW_FRAME_PATH, targetId), {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: jpeg, signal,
  });
}
/** 패널 안 허용 요청 — 서버가 붙잡아 둔 호출 하나(합쳐진 도구 이름·시한). 인자·내용은 없다. */
export interface ObjectiveUseRequest {
  readonly id: string;
  readonly objectiveId: string;
  readonly capability: "computer";
  readonly tools: readonly string[];
  /** 이 요청을 기다리는 참가자(호출한 세션). 공유 컨텍스트에서는 루트(objectiveId)와 다를 수 있다. */
  readonly requestedBy: readonly string[];
  readonly expiresAt: number;
}
type ObjectiveUseActivity = {
  computer: string[];
  /** 컴퓨터를 지금 조작하는 참가자 — 공유 컨텍스트에서는 기기의 주인(computer, 루트)과 다르다. */
  computerActor: string | null;
  /** 자기 세션으로 컴퓨터를 쓰는 사령관들 — 그 사령관의 Objective 가 쓰는 것은 `computer` 가 말한다. */
  computerCommodores: string[];
  browser: string[];
  /** 자기 세션으로 플릿 브라우저를 쓰는 사령관들 — 그 사령관의 Objective 가 쓰는 것은 `browser` 가 말한다. */
  browserCommodores: string[];
  requests: ObjectiveUseRequest[];
};
const EMPTY_ACTIVITY: ObjectiveUseActivity = { computer: [], computerActor: null, computerCommodores: [], browser: [], browserCommodores: [], requests: [] };
const ObjectiveUseContext = createContext<ObjectiveUseActivity>(EMPTY_ACTIVITY);
export function useObjectiveUse(objectiveId: string) {
  const activity = useContext(ObjectiveUseContext);
  return {
    computer: activity.computer.includes(objectiveId),
    browser: activity.browser.includes(objectiveId),
  };
}
/** 그 사령관 자신의 세션이 지금 사람의 컴퓨터를 조작하는가 — 사이드바의 사령관 줄이 읽는다. */
export function useCommodoreComputerUse(commodoreId: string | null): boolean {
  const activity = useContext(ObjectiveUseContext);
  return commodoreId !== null && activity.computerCommodores.includes(commodoreId);
}
/** 그 사령관 자신의 세션이 지금 플릿 브라우저를 쓰는가 — 사이드바의 사령관 줄과 사령관 대화의 지구본이 읽는다. */
export function useCommodoreBrowserUse(commodoreId: string | null): boolean {
  const activity = useContext(ObjectiveUseContext);
  return commodoreId !== null && activity.browserCommodores.includes(commodoreId);
}
export type ObjectiveUseTool = "computer" | "browser";
/**
 * 여러 Objective(지휘관 목록 줄의 뿌리와 구성원) 가운데 지금 도구를 쓰는 하나. 한 줄에 여럿이면 컴퓨터 → 브라우저 순으로 하나만 말한다.
 * `actor` 는 쓰는 참가자 — 컴퓨터는 조작자(공유 컨텍스트면 루트와 다르다), 나머지는 걸린 id 다.
 */
export function useObjectivesToolUse(objectiveIds: readonly string[]): { readonly tool: ObjectiveUseTool; readonly actor: string | null } | null {
  const activity = useContext(ObjectiveUseContext);
  const first = (ids: readonly string[]) => objectiveIds.find((id) => ids.includes(id)) ?? null;
  if (activity.computer.length > 0) {
    const actor = activity.computerActor !== null && objectiveIds.includes(activity.computerActor) ? activity.computerActor : first(activity.computer);
    if (actor !== null) return { tool: "computer", actor };
  }
  const browser = first(activity.browser);
  return browser !== null ? { tool: "browser", actor: browser } : null;
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
    if (typeof record.id !== "string" || typeof record.objectiveId !== "string" || record.capability !== "computer" || typeof record.expiresAt !== "number") return [];
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
  return { computer: ids(record.computer), computerActor: typeof record.computerActor === "string" ? record.computerActor : null, computerCommodores: ids(record.computerCommodores), browser: ids(record.browser), browserCommodores: ids(record.browserCommodores), requests };
}

/** 영상 수명은 Console가, 표시 위치는 해당 Objective이 소유한다. */
export function ComputerScreenShareProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [visibleStillCards, setVisibleStillCards] = useState<ReadonlyMap<string, number>>(() => new Map());
  const reportStillCardVisibility = useCallback((id: string, visible: boolean) => {
    setVisibleStillCards((previous) => {
      const next = new Map(previous);
      const count = (next.get(id) ?? 0) + (visible ? 1 : -1);
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });
  }, []);
  const [localStill, setLocalStill] = useState<{ id: string; url: string } | null>(null);
  const [remoteCapture, setRemoteCapture] = useState<Capture | null>(null);
  const [remoteViewers, setRemoteViewers] = useState(0);
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
    // 원격 미리보기 송신 — 서버가 센 원격 시청 세션이 있고 이 창 캡처가 살아 있을 때만 1초마다 한 장을 올린다.
    let viewers = 0;
    let sender: ReturnType<typeof setInterval> | null = null;
    let sendingFrame = false;
    const sendFrame = async () => {
      const owner = stream;
      const targetId = currentId;
      const track = owner?.getVideoTracks()[0];
      if (sendingFrame || !owner || !targetId || !track || track.readyState !== "live") return;
      sendingFrame = true;
      try {
        const jpeg = await grabRemotePreviewJpeg(track);
        if (!jpeg || disposed || stream !== owner || currentId !== targetId || viewers === 0) return;
        await uploadPreviewStill(targetId, jpeg, AbortSignal.timeout(3000));
      } catch { /* 한 장을 놓쳐도 다음 장이 따라온다. 원격은 갱신 멈춤으로 안다. */ }
      finally { sendingFrame = false; }
    };
    const syncSender = () => {
      const wanted = !disposed && viewers > 0 && stream !== null && currentId !== null;
      if (wanted && sender === null) { sender = setInterval(() => void sendFrame(), REMOTE_PREVIEW_INTERVAL_MS); void sendFrame(); }
      if (!wanted && sender !== null) { clearInterval(sender); sender = null; }
    };
    const stop = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; syncSender(); };
    const startCapture = () => {
      const target = desiredTarget;
      if (disposed || !target || target.offscreen || stream || acquiring || attemptedId === target.id) return;
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
        syncSender();
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
      const raw = value as { target: (Omit<CaptureTarget, "actor"> & { actor?: unknown }) | null; unavailableObjectiveId?: string | null; unavailableCommodoreId?: string | null; unavailableReason?: unknown };
      const target: CaptureTarget | null = raw.target ? { ...raw.target, actor: typeof raw.target.actor === "string" ? raw.target.actor : null } : null;
      const unavailableObjectiveId = raw.unavailableObjectiveId;
      const unavailableCommodoreId = raw.unavailableCommodoreId;
      const modeChanged = (target?.offscreen === true) !== (desiredTarget?.offscreen === true);
      desiredTarget = target;
      if (!target && (unavailableObjectiveId || unavailableCommodoreId)) {
        captureGeneration++;
        stop();
        currentId = null;
        attemptedId = null;
        const failure: CaptureFailure | undefined = raw.unavailableReason === "accessibility_permission_required" ? raw.unavailableReason : undefined;
        const unavailable: CaptureTarget = unavailableObjectiveId
          ? { id: `unavailable:${unavailableObjectiveId}`, objectiveId: unavailableObjectiveId, actor: null, title: "" }
          : { id: `unavailable:${unavailableCommodoreId}`, ownerKind: "commodore", objectiveId: null, commodoreId: unavailableCommodoreId ?? null, actor: null, title: "" };
        setCapture({ target: unavailable, stream: null, failed: true, ...(failure ? { failure } : {}) });
        return;
      }
      if ((target?.id ?? null) !== currentId || modeChanged) {
        captureGeneration++;
        stop();
        currentId = target?.id ?? null;
        attemptedId = null;
        setCapture(null);
      }
      if (target?.offscreen) setCapture({ target, stream: null, failed: false });
      else if (!target) setCapture(null);
      // 같은 실패 대상은 자동으로 재시도하지 않는다. 새 대상이나 명시적 재시도만 획득을 재개한다.
      startCapture();
    };
    const unsubscribe = subscribeConsoleChannel("computer-capture:state", (payload) => {
      streamed = true;
      apply(payload);
      syncSender();
    });
    // 서버는 이 이벤트를 이 Console을 띄운 로컬 Desktop에만 보낸다.
    const unsubscribeViewers = subscribeConsoleChannel(REMOTE_PREVIEW_VIEWERS_EVENT, (payload) => {
      const count = payload && typeof payload === "object" ? (payload as { count?: unknown }).count : 0;
      viewers = typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
      setRemoteViewers(viewers);
      syncSender();
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
    return () => { disposed = true; controller.abort(); unsubscribe(); unsubscribeViewers(); unsubscribeConnection(); stop(); setRemoteViewers(0); };
  }, []);
  const stillId = capture?.target.offscreen ? capture.target.id : null;
  const visibleStill = stillId !== null && visibleStillCards.has(stillId);
  const hasRemoteViewers = remoteViewers > 0;
  const wantsStill = visibleStill || hasRemoteViewers;
  const stillDemand = useRef({ visibleStill, hasRemoteViewers });
  stillDemand.current = { visibleStill, hasRemoteViewers };
  useEffect(() => {
    if (!stillId || !wantsStill) return;
    const controller = new AbortController();
    let url: string | null = null;
    let fetching = false;
    const hide = () => { if (url) URL.revokeObjectURL(url); url = null; setLocalStill(null); };
    const read = async () => {
      if (fetching || controller.signal.aborted) return;
      const demand = stillDemand.current;
      if (!demand.visibleStill && !demand.hasRemoteViewers) return;
      fetching = true;
      try {
        const response = await fetch(previewTargetUrl(DESKTOP_OFFSCREEN_PREVIEW_STILL_PATH, stillId), {
          method: "POST", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (controller.signal.aborted) return;
        if (response.status !== 200) return;
        const jpeg = await response.blob();
        if (controller.signal.aborted) return;
        if (stillDemand.current.visibleStill) {
          if (url) URL.revokeObjectURL(url);
          url = URL.createObjectURL(jpeg);
          setLocalStill({ id: stillId, url });
        }
        if (stillDemand.current.hasRemoteViewers) {
          await uploadPreviewStill(stillId, jpeg, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
        }
      } catch { /* 실패한 장은 다음 간격에 다시 시도한다. */ }
      finally { fetching = false; }
    };
    void read();
    const timer = setInterval(() => void read(), REMOTE_PREVIEW_INTERVAL_MS);
    return () => { controller.abort(); clearInterval(timer); hide(); };
  }, [stillId, wantsStill]);
  useEffect(() => {
    // 원격 full 화면 — 서버는 미리보기 상태를 원격 full 구독자에게만 보낸다. 로컬 화면에는 이 이벤트가 오지 않는다.
    let disposed = false;
    let target: CaptureTarget | null = null;
    let sending = false;
    let loop: AbortController | null = null;
    let url: string | null = null;
    let afterSeq = 0;
    let lastFrameAt: number | null = null;
    let waitingSince = Date.now();
    const hide = () => { if (url) URL.revokeObjectURL(url); url = null; };
    const publish = () => {
      if (disposed) return;
      setRemoteCapture(target ? { target, stream: null, failed: false, remote: { url, lastFrameAt, waitingSince, off: !sending } } : null);
    };
    const reset = () => { loop?.abort(); loop = null; hide(); afterSeq = 0; lastFrameAt = null; waitingSince = Date.now(); };
    const pause = (signal: AbortSignal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REMOTE_PREVIEW_INTERVAL_MS);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const run = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        let response: Response;
        try {
          response = await fetch(`${REMOTE_PREVIEW_FRAME_PATH}?${REMOTE_PREVIEW_AFTER_PARAM}=${afterSeq}`, { cache: "no-store", signal });
        } catch {
          // 네트워크 지연·끊김 — 마지막 이미지는 그대로 두고 경과 시간으로 알린다.
          if (signal.aborted) return;
          await pause(signal);
          continue;
        }
        if (signal.aborted) return;
        if (response.status === 200) {
          const seq = Number(response.headers.get(REMOTE_PREVIEW_SEQ_HEADER));
          const age = Number(response.headers.get(REMOTE_PREVIEW_AGE_HEADER));
          let blob: Blob;
          try { blob = await response.blob(); } catch { continue; }
          if (signal.aborted) return;
          hide();
          url = URL.createObjectURL(blob);
          if (Number.isFinite(seq) && seq > afterSeq) afterSeq = seq;
          lastFrameAt = Date.now() - (Number.isFinite(age) && age > 0 ? age : 0);
          publish();
          continue;
        }
        if (response.status === 204) continue;
        // 거부(401·403·409 등)는 이전 이미지를 바로 가린다. 꺼졌다는 판단은 서버 상태(`sending: false`)로만 한다.
        hide();
        publish();
        await pause(signal);
      }
    };
    const apply = (payload: unknown) => {
      if (disposed) return;
      const next = readRemotePreviewState(payload);
      const nextTarget: CaptureTarget | null = next.target
        ? { id: next.target.id, ownerKind: next.target.ownerKind, objectiveId: next.target.objectiveId, commodoreId: next.target.commodoreId, actor: next.target.actor, title: "" }
        : null;
      const changed = (nextTarget?.id ?? null) !== (target?.id ?? null);
      if (changed || !next.sending) reset();
      target = nextTarget;
      sending = next.sending;
      if (target && sending && loop === null) {
        loop = new AbortController();
        void run(loop.signal);
      }
      publish();
    };
    // 스트림이 먼저 말을 걸었는가. 늦게 돌아온 1회 조회가 더 새 상태를 되돌리지 않게 한다.
    let streamed = false;
    const unsubscribe = subscribeConsoleChannel(REMOTE_PREVIEW_STATE_EVENT, (payload) => { streamed = true; apply(payload); });
    // 채널은 지난 프레임을 다시 보내지 않는다 — 핸드셰이크 뒤에 붙은 화면이 진행 중인 사용을 놓치지 않게 1회 읽는다.
    // 원격 full이 아니면(로컬 화면 404, monitoring 403) 아무것도 하지 않는다.
    const initial = new AbortController();
    void fetch(REMOTE_PREVIEW_STATE_PATH, { cache: "no-store", signal: AbortSignal.any([initial.signal, AbortSignal.timeout(3000)]) })
      .then(async (response) => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!streamed) apply(body);
      })
      .catch(() => undefined);
    const releaseOffline = () => {
      if (getState().connection !== "offline" || target === null) return;
      // 끊기면 다시 붙을 때 서버가 지금 상태를 다시 보낸다. 그 사이 낡은 이미지를 남기지 않는다.
      reset();
      target = null;
      publish();
    };
    const unsubscribeConnection = subscribeStore(releaseOffline);
    return () => { disposed = true; initial.abort(); reset(); unsubscribe(); unsubscribeConnection(); setRemoteCapture(null); };
  }, []);
  const visibleCapture = stillId !== null && capture
    ? { ...capture, localStillUrl: visibleStill && localStill?.id === stillId ? localStill.url : null }
    : capture ?? remoteCapture;
  return <ObjectiveUseContext.Provider value={activity}><RemoteViewersContext.Provider value={remoteViewers}><VisibleStillCardContext.Provider value={reportStillCardVisibility}><CaptureContext.Provider value={visibleCapture}>{children}</CaptureContext.Provider></VisibleStillCardContext.Provider></RemoteViewersContext.Provider></ObjectiveUseContext.Provider>;
}

/** 이 Objective(공유 컨텍스트면 루트)의 화면을 지금 공유하는 중인가 — 영상 수명은 Desktop 셸만 가진다. */
export function useComputerShareActive(objectiveId: string): boolean {
  const target = useContext(CaptureContext)?.target;
  return target !== undefined && targetOwnedBy(target, { objectiveId });
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
export function ComputerScreenShare({ objectiveId, commodoreId, actor, className }: { objectiveId?: string; commodoreId?: string; actor?: (participantId: string) => ReactNode; className?: string }) {
  const t = useT();
  const capture = useContext(CaptureContext);
  const remoteViewers = useContext(RemoteViewersContext);
  const reportStillCardVisibility = useContext(VisibleStillCardContext);
  const video = useRef<HTMLVideoElement | null>(null);
  const own = capture && targetOwnedBy(capture.target, { ...(objectiveId !== undefined ? { objectiveId } : {}), ...(commodoreId !== undefined ? { commodoreId } : {}) }) ? capture : null;
  const actorId = useComputerActor(objectiveId ?? "") ?? own?.target.actor ?? null;
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
  /** 원격 정지 화면의 가로세로비 — 이미지가 처음 읽힐 때 정한다. 영상은 트랙 설정에서 읽는다. */
  const [remoteRatio, setRemoteRatio] = useState<number | null>(null);
  /**
   * 영상 프레임의 가로세로비. 트랙 설정은 획득 순간의 값이라, 최소화에서 막 복원되는 창처럼 그 순간의 크기가
   * 실제 프레임과 다를 수 있다. 그 스트림의 프레임 크기를 알면 그것을 따른다.
   */
  const [videoFrame, setVideoFrame] = useState<{ stream: MediaStream; ratio: number } | null>(null);
  const videoRatio = videoFrame && videoFrame.stream === own?.stream ? videoFrame.ratio : null;
  const stillId = own?.target.offscreen ? own.target.id : null;
  useEffect(() => {
    const element = card.current;
    if (!stillId || !element) return;
    let intersects = false;
    let visible = false;
    const update = () => {
      const next = intersects && document.visibilityState === "visible" &&
        (element.checkVisibility?.({ visibilityProperty: true }) ?? true);
      if (next !== visible) { visible = next; reportStillCardVisibility(stillId, visible); }
    };
    const observer = new IntersectionObserver(([entry]) => { intersects = entry?.isIntersecting === true; update(); });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      if (visible) reportStillCardVisibility(stillId, false);
    };
  }, [stillId, reportStillCardVisibility]);
  const remote = own?.remote;
  const remoteLive = remote !== undefined && !remote.off;
  /** 미리보기 자리(영상 또는 원격 정지 화면)가 있는가 — 크기·최대화·끌기 규칙은 둘이 같다. */
  const media = Boolean(own?.stream) || remoteLive || stillId !== null;
  const stillUrl = remote?.url ?? own?.localStillUrl;
  const minimizedStill = stillId !== null && own?.target.minimized === true && !remote;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!remoteLive) return;
    // 5초를 넘긴 직후 보이도록 반 초마다 본다. 초수는 화면에만 바뀌고 스크린리더에는 한 번만 알린다.
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [remoteLive]);
  // 첫 장 전이면 기다리기 시작한 때부터, 이후엔 마지막 새 이미지부터 센다.
  const remoteSince = remote ? remote.lastFrameAt ?? remote.waitingSince : null;
  const staleSeconds = remoteLive && remoteSince !== null && now - remoteSince > REMOTE_PREVIEW_STALE_MS ? Math.floor((now - remoteSince) / 1000) : null;
  const stale = staleSeconds !== null;
  /** 스크린리더에는 지연이 시작될 때 한 번만 알린다. 초수는 매초 읽히지 않는다. */
  const [announcement, setAnnouncement] = useState("");
  const staleSecondsRef = useRef<number | null>(null);
  staleSecondsRef.current = staleSeconds;
  useEffect(() => {
    setAnnouncement(stale ? t("settings.computerUse.remotePreviewStale", { seconds: String(staleSecondsRef.current ?? 0) }) : "");
  }, [stale, t]);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; scaleX: number; scaleY: number; resizing: boolean; width: number; height: number } | null>(null);
  useEffect(() => {
    const element = card.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const resize = () => {
      const settings = own?.stream?.getVideoTracks()[0]?.getSettings();
      const ratio = own?.stream ? videoRatio ?? (settings?.width || 16) / (settings?.height || 9) : remoteRatio ?? 16 / 10;
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
  }, [own?.stream, own?.target.id, remoteRatio, videoRatio]);
  useEffect(() => {
    const element = video.current;
    const stream = own?.stream;
    if (!element || !stream) return;
    element.srcObject = stream;
    // 첫 프레임의 크기와 이후 바뀐 크기(대상 창 크기 조절 포함)를 카드 비율에 반영한다.
    const measure = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) setVideoFrame({ stream, ratio: element.videoWidth / element.videoHeight });
    };
    element.addEventListener("loadedmetadata", measure);
    element.addEventListener("resize", measure);
    void element.play().catch(() => undefined);
    return () => {
      element.removeEventListener("loadedmetadata", measure);
      element.removeEventListener("resize", measure);
      element.srcObject = null;
    };
  }, [own?.stream]);
  if (!own) return null;
  // 칩은 영상 위에는 겹쳐도 되지만 문구(실패·권한 안내) 위에는 겹치면 안 된다 — 영상이 없을 때는 CSS 가 칩을 본문 위 한 줄로 내린다.
  const chip = actor && actorId ? actor(actorId) : null;
  return <aside ref={card} className={`computer-screen-share${className ? ` ${className}` : ""}${chip ? " has-actor" : ""}${media ? " is-streaming" : ""}${remote ? " is-remote" : ""}${dragging ? " is-dragging" : ""}${maximized && media ? " is-maximized" : ""}`} aria-label={t(remote ? "settings.computerUse.remotePreviewLabel" : "settings.computerUse.sharePreview")}
    // 최대화는 폰 배치의 떠 있는 상단 막대 아래에서 멈춘다(데스크톱은 막대 몫이 없어 틀 전체).
    style={maximized && media ? { inset: "var(--m-chrome-top, 0px) 0 0 0", width: "100%", height: "calc(100% - var(--m-chrome-top, 0px))", maxWidth: "100%", maxHeight: "calc(100% - var(--m-chrome-top, 0px))" } : { width: media ? size.width : 256, height: media ? size.height : undefined, ...(position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : {}) }}
    onPointerDown={(event) => {
      const resizing = event.target instanceof Element && Boolean(event.target.closest(".computer-screen-share-resize"));
      if (event.button !== 0 || (maximized && media) || (!resizing && event.target instanceof Element && event.target.closest("button"))) return;
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
    {(own.stream || own.localStillUrl) && remoteViewers > 0 ? <span className="computer-screen-share-remote" data-remote-viewers={remoteViewers}>{t("settings.computerUse.shareRemote")}</span> : null}
    {remoteLive || stillId !== null ? (minimizedStill
      // 최소화된 창은 정지 화면을 만들 수 없다(Windows DWM). 빈 자리 대신 사유와 되돌리는 방법을 말한다.
      ? <p className="computer-screen-share-still is-empty is-minimized" role="status">{t("settings.computerUse.shareMinimized")}</p>
      : stillUrl
      ? <img className="computer-screen-share-still" src={stillUrl} alt="" draggable={false} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) setRemoteRatio(image.naturalWidth / image.naturalHeight); }} />
      : <span className="computer-screen-share-still is-empty" />) : null}
    {remote ? <>
      {!remoteLive ? <p>{t("settings.computerUse.remotePreviewOff")}</p> : null}
      {staleSeconds !== null ? <p className="computer-screen-share-stale" aria-hidden="true">{t("settings.computerUse.remotePreviewStale", { seconds: String(staleSeconds) })}</p> : null}
      <span className="computer-screen-share-announce" role="status">{announcement}</span>
    </> : null}
    {media ? <>{own.stream ? <video ref={video} muted playsInline aria-label={t("settings.computerUse.sharePreview")} /> : null}
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
    </> : remote ? null : <><p role="status">{t("settings.computerUse.shareError")}</p>{own.failure === "screen_recording_permission_required" ? <>
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
