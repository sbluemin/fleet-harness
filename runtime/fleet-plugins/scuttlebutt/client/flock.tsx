import type { FloatingWidgetContext } from "@fleet-console/sdk/floating";
import { React, usePluginApi, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { AnswerBubble } from "./answer-bubble.js";
import { ArrivalBubble } from "./arrival-bubble.js";
import { birdVisual } from "./bird-state.js";
import { ChatCard } from "./chat-card.js";
import { readConsoleSnapshot } from "./console-read.js";
import { createChatSession, type AdmiralId } from "./chat-session.js";
import { DepartureBubble } from "./departure-bubble.js";
import { connectScuttlebuttMentions } from "./mention-bridge.js";
import { getT, type ScuttlebuttMessageKey } from "./scuttlebutt-catalog.js";
import { QuakerFigure } from "./quaker-figure.js";
import {
  birdSize,
  createBirdBody,
  parkedLayout,
  PERSONAS,
  pickWaypoint,
  placeStayPut,
  stayPutFractions,
  stepFlock,
  type BirdBody,
  type BirdFrame,
} from "./roaming.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
  writeAideStayPut,
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
    left: body.x - body.size.halfWidth,
    top: body.y - body.size.halfHeight,
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
    console: readConsoleSnapshot,
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
    const stored = getScuttlebuttSettings();
    bodiesRef.current = MORPHS.map((morph, index) => {
      const body = createBirdBody(index, viewportRef.current, Math.random, stored.sizes[morph]);
      const stay = stored.stayPut[morph];
      body.moored = stay.enabled;
      if (stay.enabled && stay.nx != null && stay.ny != null) {
        placeStayPut(body, viewportRef.current, stay.nx, stay.ny);
      }
      return body;
    });
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
  // Quick Launch에서 물은 답이 떠 있는 부관들. 카드와 달리 이 말풍선은 시간으로 사라지지 않는다.
  // 한 자리로 두면 뒤에 물은 부관이 앞 부관의 답을 덮어써, 도착한 답이 어디에도 서지 못한다.
  const [answering, setAnswering] = React.useState<readonly AdmiralId[]>([]);
  // 답을 세우려고 우리가 정박시킨 부관들. 사용자가 직접 세운 정박과 구분해야 되돌릴 때 남의 것을 내리지 않는다.
  const mentionMooredRef = React.useRef(new Set<AdmiralId>());
  // 사용자가 켠 정박은 설정에 남긴다 — 멘션이 답을 읽으라고 잠깐 세운 정박만 이 세션에서 끝난다.
  const [moored, setMoored] = React.useState<readonly boolean[]>(() =>
    MORPHS.map((morph) => getScuttlebuttSettings().stayPut[morph].enabled),
  );
  const [positionRevision, setPositionRevision] = React.useState(0);

  const applyMoored = React.useCallback((index: number, resolve: (current: boolean) => boolean) => {
    setMoored((current) => {
      const nextValue = resolve(current[index] ?? false);
      const next = replaceAt(current, index, nextValue);
      if (next === current) return current;
      const body = bodiesRef.current?.[index];
      if (body) {
        body.moored = nextValue;
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

  const toggleMoored = React.useCallback((index: number) => {
    const admiral = MORPHS[index]!;
    let next = false;
    applyMoored(index, (current) => {
      next = !current;
      return next;
    });
    const body = bodiesRef.current?.[index];
    const fractions = body ? stayPutFractions(body, viewportRef.current) : { nx: null, ny: null };
    // 저장 실패의 화면 복구는 스토어가 진다. 거절을 여기서 받아 두지 않으면 실패한 저장이
    // unhandled rejection으로 새어 나간다.
    writeAideStayPut(admiral, next
      ? { enabled: true, nx: fractions.nx, ny: fractions.ny }
      : { enabled: false, nx: null, ny: null }).catch(() => undefined);
  }, [applyMoored]);

  /**
   * Quick Launch에서 온 질문 하나.
   *
   * 답하는 동안 정박시킨다 — 말풍선은 새 좌표를 매 프레임 따라가므로, 순항하는 새 위의 360px
   * 상자를 읽게 두면 멘션이 없앤 추격을 읽기 단계에서 되살린다. 정박은 이미 있는 상태를 그대로
   * 쓰고(카드의 "제자리에 두기"와 같은 값), 말풍선을 닫을 때 함께 풀린다.
   */
  const askFromMention = React.useCallback(async (admiral: AdmiralId, text: string) => {
    const index = MORPHS.indexOf(admiral);
    if (index < 0) throw new Error("mention_target_gone");
    // 앞 질문에 답하는 중인 부관은 새 질문을 **버린다**(ChatSession.ask가 그 단계에서 그냥 돌아온다).
    // 그대로 성공으로 넘기면 컴포저가 초안을 지워 사용자의 문장이 사라진다 — 거절해서 초안을 지킨다.
    const phase = sessions[index]!.snapshot().state.phase;
    if (phase === "starting" || phase === "thinking") throw new Error("destination_busy");
    applyMoored(index, (current) => {
      // 사용자가 이미 세워 둔 정박은 우리 것이 아니다 — 답을 거두며 그 스위치를 대신 내리면
      // 사용자가 켠 설정이 조용히 꺼진다.
      if (!current) mentionMooredRef.current.add(admiral);
      return true;
    });
    setAnswering((current) => (current.includes(admiral) ? current : [...current, admiral]));
    // 답의 도착은 말풍선이 말한다 — 여기서 기다리면 닫히는 컴포저가 스트림을 소유하게 되고,
    // SSE 연결이 끝내 열리지 않는 회차에서는 그 약속이 영영 정착하지 않아 바가 잠긴 채 남는다.
    // 전달의 의미는 "이 부관이 질문을 맡았다"까지다.
    void sessions[index]!.ask(text);
  }, [applyMoored, sessions]);

  /**
   * 답을 읽으라고 세운 정박을 되돌린다. 말풍선을 닫든 카드로 넘기든, 그 답을 위해 세운 것이
   * 끝나면 함께 풀린다 — 풀지 않으면 멘션 한 번이 새를 영구히 붙박아 둔다.
   */
  const releaseMentionMoor = React.useCallback((admiral: AdmiralId) => {
    if (!mentionMooredRef.current.delete(admiral)) return;
    applyMoored(MORPHS.indexOf(admiral), () => getScuttlebuttSettings().stayPut[admiral].enabled);
  }, [applyMoored]);

  // 설정 읽기가 늦게 도착해도 첫 페인트 전에 정박을 얹는다 — 한 프레임 순항했다가 붙으면 튄다.
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const bodies = bodiesRef.current;
    if (!bodies) return;
    const frames = [...motionFramesRef.current];
    let placed = false;
    for (let index = 0; index < MORPHS.length; index += 1) {
      const admiral = MORPHS[index]!;
      if (mentionMooredRef.current.has(admiral)) continue;
      const stay = settings.stayPut[admiral];
      applyMoored(index, () => stay.enabled);
      const body = bodies[index]!;
      if (stay.enabled && stay.nx != null && stay.ny != null) {
        placeStayPut(body, viewport, stay.nx, stay.ny);
        const left = body.x - body.size.halfWidth;
        const top = body.y - body.size.halfHeight;
        frames[index] = { left, top, tilt: 0, flight: "hover", mode: body.mode };
        const element = birdRefs.current[index];
        if (element) element.style.transform = `translate(${left}px, ${top}px) rotate(0deg)`;
        placed = true;
      }
    }
    if (placed) {
      motionFramesRef.current = frames;
      setMotionFrames(frames);
    }
  }, [applyMoored, settings.stayPut]);

  const closeAnswer = React.useCallback((admiral: AdmiralId) => {
    setAnswering((current) => current.filter((candidate) => candidate !== admiral));
    releaseMentionMoor(admiral);
  }, [releaseMentionMoor]);

  const askFromMentionRef = React.useRef(askFromMention);
  askFromMentionRef.current = askFromMention;
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  // 답이 떠 있는 부관을 설정에서 끄면 말풍선이 사라진 새 위에 남는다 — 함께 거둔다. 정박도 같이
  // 푼다: 소유 기록만 지우면 다시 켰을 때 그 새가 영문 없이 붙박여 있다.
  React.useEffect(() => {
    setAnswering((current) => {
      const kept = current.filter((admiral) => settings[admiral]);
      if (kept.length === current.length) return current;
      for (const admiral of current) if (!settings[admiral]) releaseMentionMoor(admiral);
      return kept;
    });
  }, [releaseMentionMoor, settings]);

  // 다리는 마운트 동안 한 번만 건다 — 매 렌더 재연결하면 싱글턴이 프레임마다 갈린다.
  React.useEffect(() => connectScuttlebuttMentions({
    onDuty: () => MORPHS.filter((morph) => settingsRef.current[morph]),
    label: (admiral) => getT(localeRef.current)(`bird.${admiral}`),
    locale: () => localeRef.current,
    ask: (admiral, text) => askFromMentionRef.current(admiral, text),
  }), []);

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

  const saluteAll = React.useCallback(() => {
    for (const index of activeIndices) {
      triggerOneShot(index, "salute", SALUTE_DURATION_MS);
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
    const slots = parkedLayout(
      activeIndices.map((index) => bodies[index]!.size),
      viewport,
      PARKED_GAP,
    );
    const parkedFrames = [...motionFramesRef.current];
    activeIndices.forEach((index, activeIndex) => {
      const body = bodies[index]!;
      const { left, top } = slots[activeIndex]!;
      body.x = left + body.size.halfWidth;
      body.y = top + body.size.halfHeight;
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

  /**
   * 설정에서 고른 폭을 엔진 몸체에 싣는다. 크기는 렌더 값이 아니라 엔진 입력이므로 이 동기화가
   * 없으면 화면만 커지고 경계·바닥·반발력은 옛 치수에 남는다.
   *
   * 크기가 바뀌면 좌표도 다시 잡아야 한다 — 커진 부관은 방금까지 유효하던 자리가 화면 밖이 되고,
   * 정박 중이면 저장된 화면비 좌표를 새 치수의 경계로 다시 clamp해야 한다. 모션을 줄인 화면에서는
   * 편대 루프가 돌지 않아 아무도 자리를 고쳐 주지 않으므로 주차 줄을 직접 다시 세운다 — 그러지
   * 않으면 커진 부관이 제자리에서 이웃을 파고든 채로 남는다.
   *
   * 마지막으로 positionRevision을 올려 열려 있는 채팅 카드가 새 상자 기준으로 다시 앉게 한다 —
   * 말풍선들은 매 프레임 rect를 다시 재지만 카드만은 이 신호로만 움직인다.
   */
  React.useLayoutEffect(() => {
    const bodies = bodiesRef.current;
    if (!bodies) return;
    const viewport = viewportRef.current;
    let changed = false;
    const frames = [...motionFramesRef.current];
    for (let index = 0; index < MORPHS.length; index += 1) {
      const morph = MORPHS[index]!;
      const body = bodies[index]!;
      const width = settings.sizes[morph];
      if (body.size.width === width) continue;
      changed = true;
      body.size = birdSize(width);
      const stay = settings.stayPut[morph];
      if (body.moored && stay.enabled && stay.nx != null && stay.ny != null) {
        placeStayPut(body, viewport, stay.nx, stay.ny);
      } else if (!body.moored && !fleetSignals.reducedMotion) {
        // 새 치수로는 지금 목적지가 닿지 않는 자리일 수 있다.
        pickWaypoint(body, viewport, Math.random);
      }
      const left = body.x - body.size.halfWidth;
      const top = body.y - body.size.halfHeight;
      frames[index] = { ...frames[index]!, left, top };
      const element = birdRefs.current[index];
      if (element) {
        element.style.width = `${width}px`;
        element.style.transform = `translate(${left}px, ${top}px) rotate(0deg)`;
      }
    }
    if (!changed) return;
    if (fleetSignals.reducedMotion) {
      parkBirds();
    } else {
      motionFramesRef.current = frames;
      setMotionFrames(frames);
    }
    setPositionRevision((revision) => revision + 1);
  }, [fleetSignals.reducedMotion, parkBirds, settings.sizes, settings.stayPut]);

  React.useEffect(() => {
    const resize = () => {
      viewportRef.current = { width: window.innerWidth, height: window.innerHeight };
      if (fleetSignals.reducedMotion) parkBirds();
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [fleetSignals.reducedMotion, parkBirds]);

  React.useEffect(() => {
    if (activeIndices.length === 0) return;
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
  }, [activeIndices, fleetSignals.reducedMotion, parkBirds]);

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
    const admiral = MORPHS[index]!;
    if (body.moored && !mentionMooredRef.current.has(admiral) && moved >= 7) {
      const { nx, ny } = stayPutFractions(body, viewportRef.current);
      writeAideStayPut(admiral, { enabled: true, nx, ny }).catch(() => undefined);
    }
  }, [clearTimer, clickAction]);

  const t = getT(context.language);
  // 근무 중인 제독이 하나도 없으면 레이어에 아무것도 남기지 않는다.
  if (activeIndices.length === 0) return null;

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
          // 보리는 입력 대기·단절만 경보로 든다. 완료 도착은 onShow 만세 뒤 idle로 돌아간다.
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
            // 폭은 엔진이 싣는다 — 스타일시트에 상수로 두면 물리와 두 곳에서 갈린다.
            width: `${settings.sizes[morph]}px`,
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
        operations={context.operations}
        locale={context.language}
        mascot={announcerRef}
        quiet={!openAdmiral && !phases.some((phase) => phase === "starting" || phase === "thinking")}
        positionRevision={positionRevision}
        onShow={() => {
          cheerAll();
        }}
      />
      {settings.departureBell ? (
        <DepartureBubble
          departures={context.departures}
          operations={context.operations}
          locale={context.language}
          mascot={announcerRef}
          quiet={!openAdmiral && !phases.some((phase) => phase === "starting" || phase === "thinking")}
          positionRevision={positionRevision}
          onShow={saluteAll}
        />
      ) : null}
      {/* Quick Launch 답변. 카드가 열리면 카드가 전문을 맡으므로 그 부관의 말풍선만 물러난다. */}
      {answering.filter((admiral) => admiral !== openAdmiral).map((admiral) => (
        <AnswerBubble
          key={admiral}
          admiral={admiral}
          state={chats[MORPHS.indexOf(admiral)]!.state}
          mascot={{ current: birdRefs.current[MORPHS.indexOf(admiral)] ?? null }}
          locale={context.language}
          positionRevision={positionRevision}
          onExpand={() => {
            // 카드는 자기 "제자리에 두기" 스위치로 정박을 소유한다 — 말풍선이 세운 것을 그대로
            // 넘기면 사용자가 켜지 않은 스위치가 켜진 채 남는다.
            closeAnswer(admiral);
            setOpenAdmiral(admiral);
          }}
          onDismiss={(restoreFocus) => {
            // 정박은 이 답을 읽으라고 세운 것이다 — 답을 닫으면 함께 풀려 다시 순항한다.
            closeAnswer(admiral);
            // 키보드로 닫았을 때만 새로 돌아간다 — 마우스로 닫고도 포커스를 옮기면 새를 감싼
            // 링이 남는다(그 링은 포인터 사용자가 부른 적 없는 표식이다).
            if (restoreFocus) focusAdmiral(admiral);
          }}
        />
      ))}
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
