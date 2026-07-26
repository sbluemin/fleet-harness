import type { FloatingWidgetContext } from "@fleet-console/sdk/floating";
import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { ChatCard } from "./chat-card.js";
import type { ChatState } from "./chat-store.js";
import { initialDragState, updateDrag, type DragState } from "./drag-state.js";
import { clampPoint, snapPoint, type Point, type Size } from "./geometry.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
} from "./settings-store.js";

const POSITION_KEY = "scuttlebutt.mascot-pos";
const DEFAULT_SIZE: Size = { width: 81, height: 95 };

interface PersistedPosition extends Point {
  readonly version: 1;
}

export function ScuttlebuttMascot({ context }: { readonly context: FloatingWidgetContext }) {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const mascotRef = React.useRef<HTMLButtonElement>(null);
  const dragRef = React.useRef<DragState>(initialDragState);
  const positionRef = React.useRef<Point>({ left: 4, top: 4 });
  const hadPersistedPosition = React.useRef(false);
  const [position, setPosition] = React.useState<Point>(() => {
    const stored = context.preferences.read<unknown>(POSITION_KEY, null);
    if (isPersistedPosition(stored)) {
      hadPersistedPosition.current = true;
      positionRef.current = { left: stored.left, top: stored.top };
      return positionRef.current;
    }
    return positionRef.current;
  });
  const [open, setOpen] = React.useState(false);
  const [tucked, setTucked] = React.useState(false);
  const [phase, setPhase] = React.useState<ChatState["phase"]>("idle");
  const [positionRevision, setPositionRevision] = React.useState(0);

  const widgetSize = React.useCallback((): Size => {
    const rect = mascotRef.current?.getBoundingClientRect();
    return {
      width: rect?.width || DEFAULT_SIZE.width,
      height: rect?.height || DEFAULT_SIZE.height,
    };
  }, []);

  const commitPosition = React.useCallback((next: Point, persist: boolean) => {
    const clamped = clampPoint(next, { width: window.innerWidth, height: window.innerHeight }, widgetSize());
    positionRef.current = clamped;
    setPosition(clamped);
    setPositionRevision((revision) => revision + 1);
    if (persist) context.preferences.write<PersistedPosition>(POSITION_KEY, { version: 1, ...clamped });
  }, [context.preferences, widgetSize]);

  const snap = React.useCallback((corner: "bottom-right" | "bottom-left" | "top-right") => {
    commitPosition(snapPoint(corner, { width: window.innerWidth, height: window.innerHeight }, widgetSize()), true);
  }, [commitPosition, widgetSize]);

  React.useLayoutEffect(() => {
    if (hadPersistedPosition.current) commitPosition(positionRef.current, false);
    else snap("bottom-right");
  }, [commitPosition, snap]);

  React.useEffect(() => {
    const onResize = () => commitPosition(positionRef.current, true);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [commitPosition]);

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const result = updateDrag(dragRef.current, {
        type: "move",
        pointer: { left: event.clientX, top: event.clientY },
      });
      dragRef.current = result.state;
      if (result.position) commitPosition(result.position, false);
    };
    const onPointerUp = () => {
      if (dragRef.current.phase === "idle") return;
      const result = updateDrag(dragRef.current, { type: "up" });
      const dragged = result.state.suppressClick;
      dragRef.current = result.state;
      if (dragged) commitPosition(positionRef.current, true);
      setPositionRevision((revision) => revision + 1);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [commitPosition]);

  if (!settings.enabled) return null;

  const mascotState = phase === "starting" || phase === "thinking"
    ? "is-thinking"
    : phase === "ready" ? "is-ready" : "";
  const isDragging = dragRef.current.phase === "dragging";
  return (
    <>
      <button
        ref={mascotRef}
        type="button"
        className={[
          "scuttlebutt-mascot",
          mascotState,
          isDragging ? "is-dragging" : "",
          tucked ? "is-tucked" : "",
        ].filter(Boolean).join(" ")}
        style={{ left: position.left, top: position.top }}
        aria-label="Admiral Sam"
        aria-expanded={open}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragRef.current = updateDrag(dragRef.current, {
            type: "down",
            pointer: { left: event.clientX, top: event.clientY },
            origin: positionRef.current,
          }).state;
        }}
        onClick={() => {
          if (dragRef.current.suppressClick) {
            dragRef.current = updateDrag(dragRef.current, { type: "click" }).state;
            return;
          }
          if (tucked) {
            setTucked(false);
            return;
          }
          setOpen((current) => !current);
        }}
      >
        {tucked ? <span className="scuttlebutt-beacon" aria-hidden="true" /> : (
          <>
            <span className="scuttlebutt-bubble" aria-hidden="true">
              {mascotState === "is-thinking" ? "…" : mascotState === "is-ready" ? "got it!" : "zzz"}
            </span>
            <span className="scuttlebutt-cat" aria-hidden="true">
              <i className="scuttlebutt-pixel scuttlebutt-fur" />
              <i className="scuttlebutt-pixel scuttlebutt-eyes" />
              <i className="scuttlebutt-pixel scuttlebutt-tail" />
            </span>
          </>
        )}
      </button>
      {open && !tucked ? (
        <ChatCard
          api={context.api}
          mascot={mascotRef}
          settings={settings}
          positionRevision={positionRevision}
          onPhaseChange={setPhase}
          onSnap={snap}
          onClose={() => {
            setOpen(false);
            window.requestAnimationFrame(() => mascotRef.current?.focus());
          }}
          onTuck={() => {
            setOpen(false);
            setTucked(true);
            window.requestAnimationFrame(() => mascotRef.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}

function isPersistedPosition(value: unknown): value is PersistedPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const position = value as { readonly version?: unknown; readonly left?: unknown; readonly top?: unknown };
  return position.version === 1
    && typeof position.left === "number" && Number.isFinite(position.left)
    && typeof position.top === "number" && Number.isFinite(position.top);
}
