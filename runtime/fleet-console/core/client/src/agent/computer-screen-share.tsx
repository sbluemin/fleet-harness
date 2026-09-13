import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { isDesktopShell } from "../desktop-shell.js";
import "./computer-screen-share.css";

type CaptureTarget = { id: string; operationId: string; title: string };
type Capture = { target: CaptureTarget; stream: MediaStream | null; failed: boolean };
const CaptureContext = createContext<Capture | null>(null);

/** 영상 수명은 Console가, 표시 위치는 해당 Operation이 소유한다. */
export function ComputerScreenShareProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  useEffect(() => {
    if (!isDesktopShell()) return;
    let disposed = false;
    let currentId: string | null = null;
    let stream: MediaStream | null = null;
    let acquiring = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const stop = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    const acquire = async (target: CaptureTarget) => {
      acquiring = true;
      try {
        const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
        if (disposed || currentId !== target.id) { next.getTracks().forEach((track) => track.stop()); return; }
        stream = next;
        next.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (stream !== next) return;
          stop();
          if (!disposed) setCapture({ target, stream: null, failed: true });
        }, { once: true });
        setCapture({ target, stream: next, failed: false });
      } catch (error) {
        if (!disposed && currentId === target.id) {
          console.warn("Computer capture unavailable", error instanceof Error ? error.name : "unknown");
          setCapture({ target, stream: null, failed: true });
        }
      } finally { acquiring = false; }
    };
    const poll = async () => {
      try {
        const response = await fetch("/api/v1/desktop/computer-capture", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
        if (!response.ok) throw new Error("capture_target_unavailable");
        const { target } = await response.json() as { target: CaptureTarget | null };
        if (disposed) return;
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
  return <CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider>;
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
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; scaleX: number; scaleY: number } | null>(null);
  useEffect(() => {
    const element = card.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const resize = () => {
      const settings = own?.stream?.getVideoTracks()[0]?.getSettings();
      const ratio = (settings?.width || 16) / (settings?.height || 9);
      const width = Math.max(1, Math.min(256, 256 * ratio, parent.clientWidth - 24, (parent.clientHeight - 24) * ratio));
      const height = width / ratio;
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
  return <aside ref={card} className={`computer-screen-share${dragging ? " is-dragging" : ""}`} aria-label={t("settings.computerUse.sharePreview")}
    style={{ width: own.stream ? size.width : 256, height: own.stream ? size.height : undefined, ...(position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : {}) }}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const element = event.currentTarget;
      const parent = element.parentElement;
      if (!parent) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = parent.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const scaleX = bounds.width / parent.offsetWidth || 1;
      const scaleY = bounds.height / parent.offsetHeight || 1;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: (rect.left - bounds.left) / scaleX, top: (rect.top - bounds.top) / scaleY, scaleX, scaleY };
      element.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      const element = event.currentTarget;
      const parent = element.parentElement;
      if (!start || start.id !== event.pointerId || !parent) return;
      event.stopPropagation();
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
    {own.stream ? <video ref={video} muted playsInline aria-label={t("settings.computerUse.sharePreview")} /> : <p role="status">{t("settings.computerUse.shareError")}</p>}
  </aside>;
}
