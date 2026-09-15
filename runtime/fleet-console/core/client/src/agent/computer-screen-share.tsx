import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { isDesktopShell } from "../desktop-shell.js";
import "./computer-screen-share.css";

type CaptureTarget = { id: string; operationId: string; title: string };
type Capture = { target: CaptureTarget; stream: MediaStream | null; failed: boolean; retry?: () => void };
const CaptureContext = createContext<Capture | null>(null);
const OperationUseContext = createContext<{ console: string[]; computer: string[]; browser: string[] }>({ console: [], computer: [], browser: [] });
export function useOperationUse(operationId: string) {
  const activity = useContext(OperationUseContext);
  return { console: activity.console.includes(operationId), computer: activity.computer.includes(operationId), browser: activity.browser.includes(operationId) };
}

/** 영상 수명은 Console가, 표시 위치는 해당 Operation이 소유한다. */
export function ComputerScreenShareProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [activity, setActivity] = useState<{ console: string[]; computer: string[]; browser: string[] }>({ console: [], computer: [], browser: [] });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/v1/operation-use", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
        if (!response.ok) throw new Error("operation_use_unavailable");
        const next = await response.json() as { console: string[]; computer: string[]; browser?: string[] };
        if (!controller.signal.aborted) setActivity({ console: next.console, computer: next.computer, browser: next.browser ?? [] });
      } catch { if (!controller.signal.aborted) setActivity({ console: [], computer: [], browser: [] }); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 400); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!isDesktopShell()) return;
    let disposed = false;
    let currentId: string | null = null;
    let stream: MediaStream | null = null;
    let acquiring = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const stop = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    const retry = () => { if (!disposed && !acquiring) { attemptedId = null; setCapture(null); } };
    const acquire = async (target: CaptureTarget) => {
      acquiring = true;
      try {
        const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
        if (disposed || currentId !== target.id) { next.getTracks().forEach((track) => track.stop()); return; }
        stream = next;
        next.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (stream !== next) return;
          stop();
          if (!disposed) setCapture({ target, stream: null, failed: true, retry });
        }, { once: true });
        setCapture({ target, stream: next, failed: false });
      } catch (error) {
        if (!disposed && currentId === target.id) {
          console.warn("Computer capture unavailable", error instanceof Error ? error.name : "unknown");
          setCapture({ target, stream: null, failed: true, retry });
        }
      } finally { acquiring = false; }
    };
    const poll = async () => {
      try {
        const response = await fetch("/api/v1/desktop/computer-capture", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
        if (!response.ok) throw new Error("capture_target_unavailable");
        const { target, unavailableOperationId } = await response.json() as { target: CaptureTarget | null; unavailableOperationId?: string | null };
        if (disposed) return;
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
        if (target && !stream && !acquiring && currentId === target.id) {
          // 같은 실패 대상을 자동으로 재시도하지 않는다. 새 관찰의 id가 재개를 결정한다.
          if (attemptedId !== target.id) { attemptedId = target.id; void acquire(target); }
        }
      } catch {
        stop();
        currentId = null;
        attemptedId = null;
        if (!disposed) setCapture(null);
      } finally { if (!disposed) timer = setTimeout(() => void poll(), 700); }
    };
    let attemptedId: string | null = null;
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); stop(); };
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
