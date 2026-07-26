import type { FloatingWidgetContext } from "@fleet-console/sdk/floating";
import { React, usePluginApi, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { ArrivalBubble } from "./arrival-bubble.js";
import { ChatCard } from "./chat-card.js";
import { createChatSession } from "./chat-session.js";
import { initialDragState, updateDrag, type DragState } from "./drag-state.js";
import { clampPoint, snapPoint, type Point, type Size } from "./geometry.js";
import { getT } from "./i18n.js";
import { mascotMood } from "./mascot-mood.js";
import { SamFigure } from "./sam-figure.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
} from "./settings-store.js";

const POSITION_KEY = "scuttlebutt.mascot-pos";

/** styles.css 의 만세 키프레임 길이(1.25s)와 같은 값이어야 연출이 끝나는 순간 idle 로 넘어간다. */
const CHEER_DURATION_MS = 1_250;

interface PersistedPosition extends Point {
  readonly version: 1;
}

export function ScuttlebuttMascot({ context }: { readonly context: FloatingWidgetContext }) {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const pluginApi = usePluginApi(context.api, "scuttlebutt");
  const localeRef = React.useRef(context.language);
  React.useEffect(() => {
    localeRef.current = context.language;
  }, [context.language]);

  // 대화는 카드보다 오래 산다 — 카드를 닫아도 답이 끝까지 도착해야 완료 연출이 나온다.
  const session = React.useMemo(() => createChatSession({
    fetch: (path, init) => pluginApi.fetch(path, init),
    locale: () => localeRef.current,
  }), [pluginApi]);
  React.useEffect(() => () => session.close(), [session]);
  const chat = useStoreSnapshot(session.subscribe, session.snapshot);
  const phase = chat.state.phase;

  const mascotRef = React.useRef<HTMLButtonElement>(null);
  const dragRef = React.useRef<DragState>(initialDragState);
  const cheerTimeoutRef = React.useRef<number | null>(null);
  const cheerFrameRef = React.useRef<number | null>(null);
  const previousPhaseRef = React.useRef(phase);
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
  const [cheering, setCheering] = React.useState(false);
  const [positionRevision, setPositionRevision] = React.useState(0);

  const widgetSize = React.useCallback((): Size => {
    const rect = mascotRef.current?.getBoundingClientRect();
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    };
  }, []);

  const commitPosition = React.useCallback((next: Point, persist: boolean) => {
    const clamped = clampPoint(next, { width: window.innerWidth, height: window.innerHeight }, widgetSize());
    positionRef.current = clamped;
    setPosition(clamped);
    setPositionRevision((revision) => revision + 1);
    if (persist) context.preferences.write<PersistedPosition>(POSITION_KEY, { version: 1, ...clamped });
  }, [context.preferences, widgetSize]);

  const snap = React.useCallback(() => {
    commitPosition(snapPoint("bottom-right", { width: window.innerWidth, height: window.innerHeight }, widgetSize()), true);
  }, [commitPosition, widgetSize]);

  React.useLayoutEffect(() => {
    if (hadPersistedPosition.current) commitPosition(positionRef.current, false);
    else snap();
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

  // 만세는 한 번 돌고 끝난다 — 타이머가 끝나면 무드는 idle 로 돌아가 숨쉬기·깜빡임이 다시 돈다.
  const cheer = React.useCallback(() => {
    if (cheerFrameRef.current !== null) window.cancelAnimationFrame(cheerFrameRef.current);
    if (cheerTimeoutRef.current !== null) window.clearTimeout(cheerTimeoutRef.current);
    cheerTimeoutRef.current = null;
    setCheering(false);
    // 클래스를 한 프레임 걷어야 진행 중이던 만세가 처음부터 다시 돈다.
    cheerFrameRef.current = window.requestAnimationFrame(() => {
      cheerFrameRef.current = null;
      setCheering(true);
      cheerTimeoutRef.current = window.setTimeout(() => {
        cheerTimeoutRef.current = null;
        setCheering(false);
      }, CHEER_DURATION_MS);
    });
  }, []);

  React.useEffect(() => {
    if (phase === "ready" && previousPhaseRef.current !== "ready") cheer();
    previousPhaseRef.current = phase;
  }, [cheer, phase]);

  React.useEffect(() => () => {
    if (cheerFrameRef.current !== null) window.cancelAnimationFrame(cheerFrameRef.current);
    if (cheerTimeoutRef.current !== null) window.clearTimeout(cheerTimeoutRef.current);
  }, []);

  if (!settings.enabled) return null;

  const mood = mascotMood(phase, cheering);
  const isDragging = dragRef.current.phase === "dragging";
  return (
    <>
      <button
        ref={mascotRef}
        type="button"
        className={[
          "scuttlebutt-mascot",
          `is-${mood}`,
          isDragging ? "is-dragging" : "",
          tucked ? "is-tucked" : "",
        ].filter(Boolean).join(" ")}
        style={{ left: position.left, top: position.top }}
        aria-label={getT(context.language)("mascot.label")}
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
            {mood === "thinking"
              ? <span className="scuttlebutt-bubble" aria-hidden="true">…</span>
              : null}
            <SamFigure />
          </>
        )}
      </button>
      <ArrivalBubble
        arrivals={context.arrivals}
        locale={context.language}
        mascot={mascotRef}
        quiet={!open && phase !== "starting" && phase !== "thinking"}
        positionRevision={positionRevision}
        onShow={cheer}
      />
      {open && !tucked ? (
        <ChatCard
          state={chat.state}
          draft={chat.draft}
          mascot={mascotRef}
          locale={context.language}
          positionRevision={positionRevision}
          onAsk={(text) => void session.ask(text)}
          onDraftChange={session.setDraft}
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
