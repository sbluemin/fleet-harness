import type { FloatingWidgetContext } from "@fleet-console/sdk/floating";
import { React, usePluginApi, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { ArrivalBubble } from "./arrival-bubble.js";
import { birdVisual } from "./bird-state.js";
import { ChatCard } from "./chat-card.js";
import { createChatSession, type AdmiralId } from "./chat-session.js";
import { getT, type ScuttlebuttMessageKey } from "./i18n.js";
import { QuakerFigure } from "./quaker-figure.js";
import {
  BIRD_HALF_HEIGHT,
  BIRD_HALF_WIDTH,
  BIRD_HEIGHT,
  BIRD_WIDTH,
  createBirdBody,
  PERSONAS,
  pickWaypoint,
  stepFlock,
  type BirdBody,
  type BirdFrame,
} from "./roaming.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
} from "./settings-store.js";

const MORPHS = ["tori", "bori", "dori"] as const;
type OneShot = "cheer" | "salute" | null;
const FLOCK_PERSONAS = MORPHS.map((morph) => PERSONAS[morph]);

const SALUTE_DURATION_MS = 1_700;
const CHEER_DURATION_MS = 2_400;
const SAY_DURATION_MS = 1_700;
const CLICK_DELAY_MS = 260;
const PARKED_GAP = 8;

/** 첫 rAF 전에도 제자리에 그려야 세 마리가 좌상단에 겹쳤다가 흩어지는 깜빡임이 없다. */
function framesFromBodies(bodies: readonly BirdBody[]): readonly BirdFrame[] {
  return bodies.map((body): BirdFrame => ({
    left: body.x - BIRD_HALF_WIDTH,
    top: body.y - BIRD_HALF_HEIGHT,
    tilt: 0,
    flight: "hover",
    mode: "fly",
  }));
}

interface PointerGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
  lastX: number;
  lastY: number;
  lastAt: number;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  if (values[index] === value) return values;
  const next = [...values];
  next[index] = value;
  return next;
}

function sameMotion(left: BirdFrame, right: BirdFrame): boolean {
  return left.flight === right.flight && left.mode === right.mode;
}

export function ScuttlebuttFlock({ context }: { readonly context: FloatingWidgetContext }) {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const pluginApi = usePluginApi(context.api, "scuttlebutt");
  const localeRef = React.useRef(context.language);
  React.useEffect(() => {
    localeRef.current = context.language;
  }, [context.language]);

  // 대화는 카드보다 오래 산다 — 카드를 닫아도 답이 끝까지 도착해야 완료 연출이 나온다.
  const sessions = React.useMemo(() => MORPHS.map((admiral) => createChatSession({
    admiral,
    fetch: (path, init) => pluginApi.fetch(path, init),
    locale: () => localeRef.current,
  })), [pluginApi]);
  React.useEffect(() => () => {
    for (const session of sessions) session.close();
  }, [sessions]);
  const toriChat = useStoreSnapshot(sessions[0]!.subscribe, sessions[0]!.snapshot);
  const boriChat = useStoreSnapshot(sessions[1]!.subscribe, sessions[1]!.snapshot);
  const doriChat = useStoreSnapshot(sessions[2]!.subscribe, sessions[2]!.snapshot);
  const chats = [toriChat, boriChat, doriChat] as const;
  const phases = chats.map((chat) => chat.state.phase);
  const activeIndices = React.useMemo(
    () => MORPHS.map((morph, index) => settings[morph] ? index : -1).filter((index) => index >= 0),
    [settings.bori, settings.dori, settings.tori],
  );

  const [fleetSignals, setFleetSignals] = React.useState(() => context.signals.read());
  React.useEffect(() => context.signals.subscribe(setFleetSignals), [context.signals]);

  const viewportRef = React.useRef({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const bodiesRef = React.useRef<readonly BirdBody[] | null>(null);
  if (bodiesRef.current === null) {
    bodiesRef.current = MORPHS.map((_, index) => createBirdBody(index, viewportRef.current, Math.random));
  }
  const birdRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  // 소식은 근무 중인 첫 제독이 전한다 — 토리에 고정하면 토리를 끈 순간 알릴 곳이 사라진다.
  const announcerRef = React.useRef<HTMLButtonElement | null>(null);
  const gesturesRef = React.useRef<Array<PointerGesture | null>>([null, null, null]);
  const clickTimersRef = React.useRef<Array<number | null>>([null, null, null]);
  const oneShotTimersRef = React.useRef<Array<number | null>>([null, null, null]);
  const oneShotFramesRef = React.useRef<Array<number | null>>([null, null, null]);
  const sayTimersRef = React.useRef<Array<number | null>>([null, null, null]);
  const focusFrameRef = React.useRef<number | null>(null);
  const motionFramesRef = React.useRef(framesFromBodies(bodiesRef.current));
  const previousPhasesRef = React.useRef(phases);

  // 근무 중인 첫 제독을 매 렌더 뒤 다시 짚는다 — 설정에서 켜고 끌 때마다 대상이 바뀐다.
  React.useLayoutEffect(() => {
    const index = activeIndices[0];
    announcerRef.current = index === undefined ? null : birdRefs.current[index] ?? null;
  });

  const [motionFrames, setMotionFrames] = React.useState(motionFramesRef.current);
  const [grabbed, setGrabbed] = React.useState<readonly boolean[]>([false, false, false]);
  const [oneShots, setOneShots] = React.useState<readonly OneShot[]>([null, null, null]);
  const [lines, setLines] = React.useState<readonly string[]>(["", "", ""]);
  const [saying, setSaying] = React.useState<readonly boolean[]>([false, false, false]);
  const [openAdmiral, setOpenAdmiral] = React.useState<AdmiralId | null>(null);
  // 정박은 이 세션 동안만 산다 — 설정에도 preferences에도 남기지 않는다.
  const [moored, setMoored] = React.useState<readonly boolean[]>([false, false, false]);
  const [positionRevision, setPositionRevision] = React.useState(0);

  const toggleMoored = React.useCallback((index: number) => {
    setMoored((current) => {
      const next = replaceAt(current, index, !current[index]);
      const body = bodiesRef.current?.[index];
      if (body) {
        body.moored = next[index] ?? false;
        // 풀어 주면 자던 새도 깨워 가까운 새 항로부터 다시 시작한다.
        if (!body.moored) {
          body.mode = "fly";
          body.modeUntil = 0;
          body.pauseUntil = 0;
          pickWaypoint(body, viewportRef.current, Math.random);
        }
      }
      return next;
    });
  }, []);

  const clearTimer = React.useCallback((timers: React.MutableRefObject<Array<number | null>>, index: number) => {
    const timer = timers.current[index];
    if (timer != null) window.clearTimeout(timer);
    timers.current[index] = null;
  }, []);

  const triggerOneShot = React.useCallback((index: number, shot: Exclude<OneShot, null>, duration: number) => {
    clearTimer(oneShotTimersRef, index);
    const previousFrame = oneShotFramesRef.current[index];
    if (previousFrame != null) window.cancelAnimationFrame(previousFrame);
    oneShotFramesRef.current[index] = null;
    setOneShots((current) => replaceAt(current, index, null));
    // 클래스를 한 프레임 걷어야 연속 입력도 애니메이션의 첫 장면부터 다시 돈다.
    oneShotFramesRef.current[index] = window.requestAnimationFrame(() => {
      oneShotFramesRef.current[index] = null;
      setOneShots((current) => replaceAt(current, index, shot));
      oneShotTimersRef.current[index] = window.setTimeout(() => {
        oneShotTimersRef.current[index] = null;
        setOneShots((current) => replaceAt(current, index, null));
      }, duration);
    });
  }, [clearTimer]);

  const cheerAll = React.useCallback(() => {
    for (const index of activeIndices) {
      triggerOneShot(index, "cheer", CHEER_DURATION_MS);
    }
  }, [activeIndices, triggerOneShot]);

  const speak = React.useCallback((index: number) => {
    const morph = MORPHS[index]!;
    const choice = Math.floor(Math.random() * 3) + 1;
    const key = `line.${morph}.${choice}` as ScuttlebuttMessageKey;
    setLines((current) => replaceAt(current, index, getT(localeRef.current)(key)));
    setSaying((current) => replaceAt(current, index, true));
    clearTimer(sayTimersRef, index);
    sayTimersRef.current[index] = window.setTimeout(() => {
      sayTimersRef.current[index] = null;
      setSaying((current) => replaceAt(current, index, false));
    }, SAY_DURATION_MS);
  }, [clearTimer]);

  const clickAction = React.useCallback((index: number) => {
    triggerOneShot(index, "salute", SALUTE_DURATION_MS);
    const admiral = MORPHS[index]!;
    setOpenAdmiral((current) => current === admiral ? null : admiral);
  }, [triggerOneShot]);

  const focusAdmiral = React.useCallback((admiral: AdmiralId) => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      birdRefs.current[MORPHS.indexOf(admiral)]?.focus();
    });
  }, []);

  React.useEffect(() => {
    if (phases.some((phase, index) => phase === "ready" && previousPhasesRef.current[index] !== "ready")) {
      cheerAll();
    }
    previousPhasesRef.current = phases;
  }, [cheerAll, phases]);

  React.useEffect(() => {
    const bodies = bodiesRef.current;
    if (!bodies) return;
    for (let index = 0; index < MORPHS.length; index += 1) {
      const body = bodies[index]!;
      const anchored = MORPHS[index] === openAdmiral;
      body.anchored = anchored;
      if (anchored) {
        body.vx = 0;
        body.vy = 0;
        setPositionRevision((revision) => revision + 1);
      }
    }
  }, [openAdmiral]);

  React.useEffect(() => {
    if (openAdmiral && !settings[openAdmiral]) setOpenAdmiral(null);
  }, [openAdmiral, settings.bori, settings.dori, settings.tori]);

  const parkBirds = React.useCallback(() => {
    const viewport = viewportRef.current;
    const bodies = bodiesRef.current;
    if (!bodies) return;
    // 좁은 창에서는 간격을 좁혀서라도 켜진 새를 모두 화면 안에 남긴다.
    const rightmost = Math.max(8, viewport.width - 16 - BIRD_WIDTH);
    const step = activeIndices.length > 1 ? Math.min(
      BIRD_WIDTH + PARKED_GAP,
      Math.max(24, (viewport.width - 32 - BIRD_WIDTH) / (activeIndices.length - 1)),
    ) : 0;
    const parkedFrames = [...motionFramesRef.current];
    activeIndices.forEach((index, activeIndex) => {
      const left = Math.max(8, rightmost - step * (activeIndices.length - 1 - activeIndex));
      const top = Math.max(8, viewport.height - 16 - BIRD_HEIGHT);
      const body = bodies[index]!;
      body.x = left + BIRD_HALF_WIDTH;
      body.y = top + BIRD_HALF_HEIGHT;
      body.vx = 0;
      body.vy = 0;
      body.mode = "fly";
      body.grab = null;
      const element = birdRefs.current[index];
      if (element) element.style.transform = `translate(${left}px, ${top}px) rotate(0deg)`;
      parkedFrames[index] = { left, top, tilt: 0, flight: "hover", mode: "fly" };
    });
    motionFramesRef.current = parkedFrames;
    setMotionFrames(parkedFrames);
  }, [activeIndices]);

  React.useEffect(() => {
    const resize = () => {
      viewportRef.current = { width: window.innerWidth, height: window.innerHeight };
      if (fleetSignals.reducedMotion) parkBirds();
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [fleetSignals.reducedMotion, parkBirds]);

  React.useEffect(() => {
    if (!settings.enabled) return;
    if (fleetSignals.reducedMotion) {
      parkBirds();
      return;
    }
    const bodies = bodiesRef.current;
    if (!bodies) return;
    for (const index of activeIndices) {
      const body = bodies[index]!;
      body.mode = "fly";
      body.pauseUntil = 0;
      pickWaypoint(body, viewportRef.current, Math.random);
    }
    let animationFrame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const activeBodies = activeIndices.map((index) => bodies[index]!);
      const activePersonas = activeIndices.map((index) => FLOCK_PERSONAS[index]!);
      const activeFrames = stepFlock(
        activeBodies,
        activePersonas,
        viewportRef.current,
        dt,
        now / 1000,
        Math.random,
      );
      const frames = [...motionFramesRef.current];
      let motionChanged = false;
      for (let activeIndex = 0; activeIndex < activeFrames.length; activeIndex += 1) {
        const index = activeIndices[activeIndex]!;
        const frame = activeFrames[activeIndex]!;
        frames[index] = frame;
        const element = birdRefs.current[index];
        if (element) {
          element.style.transform = `translate(${frame.left}px, ${frame.top}px) rotate(${frame.tilt}deg)`;
        }
        if (!sameMotion(motionFramesRef.current[index]!, frame)) motionChanged = true;
      }
      // 좌표는 매 프레임 최신으로 둔다 — 리렌더가 끼어들 때 style prop이 옛 좌표를 되돌리면 새가 튄다.
      motionFramesRef.current = frames;
      if (motionChanged) setMotionFrames(frames);
      animationFrame = window.requestAnimationFrame(loop);
    };
    animationFrame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeIndices, fleetSignals.reducedMotion, parkBirds, settings.enabled]);

  React.useEffect(() => () => {
    for (let index = 0; index < MORPHS.length; index += 1) {
      clearTimer(clickTimersRef, index);
      clearTimer(oneShotTimersRef, index);
      clearTimer(sayTimersRef, index);
      const frame = oneShotFramesRef.current[index];
      if (frame != null) window.cancelAnimationFrame(frame);
    }
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
  }, [clearTimer]);

  const onPointerDown = React.useCallback((index: number, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    clearTimer(clickTimersRef, index);
    const body = bodiesRef.current?.[index];
    if (!body) return;
    body.mode = "fly";
    body.grab = { px: event.clientX, py: event.clientY };
    const now = performance.now();
    gesturesRef.current[index] = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: now,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: now,
    };
    setGrabbed((current) => replaceAt(current, index, true));
  }, [clearTimer]);

  const onPointerMove = React.useCallback((index: number, event: React.PointerEvent<HTMLElement>) => {
    const gesture = gesturesRef.current[index];
    const body = bodiesRef.current?.[index];
    if (!gesture || !body?.grab || gesture.pointerId !== event.pointerId) return;
    const now = performance.now();
    const dt = Math.max(8, now - gesture.lastAt) / 1000;
    body.vx = clamp((event.clientX - gesture.lastX) / dt, -420, 420);
    body.vy = clamp((event.clientY - gesture.lastY) / dt, -420, 420);
    body.grab.px = event.clientX;
    body.grab.py = event.clientY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    gesture.lastAt = now;
  }, []);

  // 취소된 제스처는 클릭이 아니다 — OS가 포인터를 뺏어갔을 뿐인데 챗이 열리면 안 된다.
  const release = React.useCallback((
    index: number,
    event: React.PointerEvent<HTMLElement>,
    cancelled = false,
  ) => {
    const gesture = gesturesRef.current[index];
    const body = bodiesRef.current?.[index];
    if (!gesture || !body || gesture.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    const held = performance.now() - gesture.startedAt;
    if (!cancelled && moved < 7 && held < 450) {
      body.vx = 0;
      body.vy = 0;
      clearTimer(clickTimersRef, index);
      clickTimersRef.current[index] = window.setTimeout(() => {
        clickTimersRef.current[index] = null;
        clickAction(index);
      }, CLICK_DELAY_MS);
    }
    body.grab = null;
    body.pauseUntil = 0;
    pickWaypoint(body, viewportRef.current, Math.random);
    gesturesRef.current[index] = null;
    setGrabbed((current) => replaceAt(current, index, false));
  }, [clearTimer, clickAction]);

  const t = getT(context.language);
  if (!settings.enabled) return null;

  return (
    <>
      {MORPHS.map((morph, index) => {
        if (!settings[morph]) return null;
        // 자세는 상태에서(리렌더를 몰고 온다), 좌표는 ref에서(루프가 쓴 최신 값) 읽는다.
        const motion = motionFrames[index]!;
        const frame = motionFramesRef.current[index] ?? motion;
        const phase = phases[index]!;
        const visual = birdVisual({
          grabbed: grabbed[index] ?? false,
          oneShot: oneShots[index] ?? null,
          alert: phase === "error"
            || (index === 1 && (fleetSignals.awaiting > 0 || fleetSignals.disconnected)),
          thinking: phase === "starting" || phase === "thinking"
            || (index === 2 && fleetSignals.running > 0),
          mode: motion.mode,
          flight: motion.flight,
        });
        const common = {
          className: `scuttlebutt-bird is-${visual}${saying[index] ? " is-saying" : ""}`,
          style: {
            transform: `translate(${frame.left}px, ${frame.top}px) rotate(${frame.tilt}deg)`,
          },
          onPointerDown: (event: React.PointerEvent<HTMLElement>) => onPointerDown(index, event),
          onPointerMove: (event: React.PointerEvent<HTMLElement>) => onPointerMove(index, event),
          onPointerUp: (event: React.PointerEvent<HTMLElement>) => release(index, event),
          onPointerCancel: (event: React.PointerEvent<HTMLElement>) => release(index, event, true),
          onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
            event.preventDefault();
            clearTimer(clickTimersRef, index);
            triggerOneShot(index, "cheer", CHEER_DURATION_MS);
            speak(index);
          },
        };
        const children = (
          <>
            <QuakerFigure morph={morph} />
            <span className="scuttlebutt-bird-tag" aria-hidden="true">{t(`bird.${morph}`)}</span>
            <span className="scuttlebutt-bird-say" aria-hidden="true">{lines[index]}</span>
          </>
        );
        return (
          <button
            {...common}
            key={morph}
            ref={(element) => {
              birdRefs.current[index] = element;
            }}
            type="button"
            aria-label={t(`chat.label.${morph}`)}
            aria-expanded={openAdmiral === morph}
            onClick={(event) => {
              if (event.detail === 0) clickAction(index);
            }}
          >
            {children}
          </button>
        );
      })}
      <ArrivalBubble
        arrivals={context.arrivals}
        locale={context.language}
        mascot={announcerRef}
        quiet={!openAdmiral && !phases.some((phase) => phase === "starting" || phase === "thinking")}
        positionRevision={positionRevision}
        onShow={() => {
          cheerAll();
        }}
      />
      {openAdmiral ? (
        <ChatCard
          admiral={openAdmiral}
          state={chats[MORPHS.indexOf(openAdmiral)]!.state}
          draft={chats[MORPHS.indexOf(openAdmiral)]!.draft}
          mascot={{ current: birdRefs.current[MORPHS.indexOf(openAdmiral)] ?? null }}
          moored={moored[MORPHS.indexOf(openAdmiral)] ?? false}
          locale={context.language}
          positionRevision={positionRevision}
          onAsk={(text) => void sessions[MORPHS.indexOf(openAdmiral)]!.ask(text)}
          onDraftChange={sessions[MORPHS.indexOf(openAdmiral)]!.setDraft}
          onToggleMoored={() => toggleMoored(MORPHS.indexOf(openAdmiral))}
          onClose={() => {
            const admiral = openAdmiral;
            setOpenAdmiral(null);
            focusAdmiral(admiral);
          }}
          onTuck={() => {
            const admiral = openAdmiral;
            setOpenAdmiral(null);
            focusAdmiral(admiral);
          }}
        />
      ) : null}
    </>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
