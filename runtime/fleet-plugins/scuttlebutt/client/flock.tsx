import type { FloatingWidgetContext } from "@fleet-console/sdk/floating";
import { React, usePluginApi, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { AnswerBubble } from "./answer-bubble.js";
import { birdVisual } from "./bird-state.js";
import { ChatCard } from "./chat-card.js";
import { readConsoleSnapshot } from "./console-read.js";
import { connectDockActivate, firstDockGlyph, readDockGlyph, readDockSnapshot, subscribeDock, writeDock } from "./dock-store.js";
import { createChatSession, type AdmiralId } from "./chat-session.js";
import { IntroBubble } from "./intro-bubble.js";
import { connectScuttlebuttMentions } from "./mention-bridge.js";
import { NoticeBubble } from "./notice-bubble.js";
import { getT, type ScuttlebuttMessageKey } from "./scuttlebutt-catalog.js";
import { QuakerFigure } from "./quaker-figure.js";
import {
  birdSize,
  clampToViewport,
  createBirdBody,
  insideKeepOut,
  parkedLayout,
  PERSONAS,
  pickWaypoint,
  placeStayPut,
  stayPutFractions,
  stayPutPoint,
  stepFlock,
  type BirdBody,
  type BirdFrame,
  type KeepOutRect,
} from "./roaming.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
  writeAideDocked,
  writeAideStayPut,
  writeScuttlebuttSettings,
} from "./settings-store.js";

const MORPHS = ["tori", "bori", "dori"] as const;
type OneShot = "cheer" | "salute" | null;
const FLOCK_PERSONAS = MORPHS.map((morph) => PERSONAS[morph]);

const SALUTE_DURATION_MS = 1_700;
const CHEER_DURATION_MS = 2_400;
const SAY_DURATION_MS = 1_700;
const CLICK_DELAY_MS = 260;
const PARKED_GAP = 8;
/** 회피 영역 재측정 주기. 레일 페인처럼 스토어 밖에서 여닫히는 표면은 이 주기로 따라잡는다. */
const KEEP_OUT_POLL_MS = 400;
const KEYBOARD_STEP_PX = 24;
/** 이 높이 안으로 새를 끌고 오면 밴드에 내려놓는 제스처다(밴드 36px + 여유). */
const DOCK_DROP_Y = 44;
const KEYBOARD_STEP_FAST_PX = 96;

function isAideShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === "KeyQ";
}

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
    // 글리프는 다른 리액트 트리(밴드)에 산다 — 스토어를 거쳐야 언어 변경에 다시 그린다.
    writeDock({ locale: context.language });
  }, [context.language]);

  // 대화는 카드보다 오래 산다 — 카드를 닫아도 답이 끝까지 도착해야 완료 연출이 나온다.
  const sessions = React.useMemo(() => MORPHS.map((admiral) => createChatSession({
    admiral,
    fetch: (path, init) => pluginApi.fetch(path, init),
    locale: () => localeRef.current,
    launch: () => {
      const current = getScuttlebuttSettings();
      return { model: current.model, effort: current.effort };
    },
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
  // 저장된 「상단 바에 두기」는 글리프가 설 밴드 슬롯이 있을 때만 유효하다 — 모바일 배치처럼 밴드가
  // 없는 곳에서는 새로 남는다(글리프도 떼어내기도 없는 곳에 숨기면 되찾을 길이 없다).
  const dockHost = useStoreSnapshot(subscribeDock, readDockSnapshot).host;
  const docked = React.useMemo<Record<AdmiralId, boolean>>(() => ({
    tori: dockHost && settings.docked.tori,
    bori: dockHost && settings.docked.bori,
    dori: dockHost && settings.docked.dori,
  }), [dockHost, settings.docked]);

  // 슬롯이 사라지면(모바일·Zen) 고정 부관은 새로 돌아간다 — 그때 밴드 아래 서 있던 답 말풍선은 거둔다.
  // 고정 답은 정박을 세우지 않았으므로 두면 나는 새를 따라다닌다. 글리프의 점은 시트가 이어받지 못하니
  // 답이 정착한 것은 다음 열림에서 카드로 읽는다.
  const dockHostRef = React.useRef(dockHost);
  React.useEffect(() => {
    const lost = dockHostRef.current && !dockHost;
    dockHostRef.current = dockHost;
    if (!lost) return;
    setAnswering((current) => current.filter((admiral) => !settings.docked[admiral]));
  }, [dockHost, settings.docked]);
  // 캔버스에 나는 부관만 편대에 든다 — 상단 바에 둔 부관은 근무 중이지만 새가 아니라 글리프다.
  const activeIndices = React.useMemo(
    () => MORPHS.map((morph, index) => settings[morph] && !docked[morph] ? index : -1).filter((index) => index >= 0),
    [settings.bori, settings.dori, settings.tori, docked],
  );
  const dockedAides = React.useMemo(
    () => MORPHS.filter((morph) => settings[morph] && docked[morph]),
    [settings.bori, settings.dori, settings.tori, docked],
  );

  const [fleetSignals, setFleetSignals] = React.useState(() => context.signals.read());
  React.useEffect(() => context.signals.subscribe(setFleetSignals), [context.signals]);

  // 회피 영역은 ref로 든다 — 프레임마다 읽히는 값이라 상태로 두면 리렌더가 따라온다. 스토어가
  // 알리는 여닫힘은 즉시, 그 밖은 주기로 다시 잰다.
  const keepOutRef = React.useRef<readonly KeepOutRect[]>([]);
  const [keepOutRevision, setKeepOutRevision] = React.useState(0);
  React.useEffect(() => {
    const read = () => {
      const next = context.keepOut.list();
      if (!sameRects(keepOutRef.current, next)) {
        keepOutRef.current = next;
        setKeepOutRevision((revision) => revision + 1);
      }
    };
    read();
    const unsubscribe = context.keepOut.subscribe(read);
    const timer = window.setInterval(read, KEEP_OUT_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [context.keepOut]);

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
    // 캔버스에 새가 없으면 상단 바의 첫 글리프가 소식을 전한다 — 말풍선은 그 아래로 내려온다.
    const bird = index === undefined ? null : birdRefs.current[index];
    announcerRef.current = bird ?? firstDockGlyph();
  });

  const [motionFrames, setMotionFrames] = React.useState(motionFramesRef.current);
  const [grabbed, setGrabbed] = React.useState<readonly boolean[]>([false, false, false]);
  const [oneShots, setOneShots] = React.useState<readonly OneShot[]>([null, null, null]);
  const [lines, setLines] = React.useState<readonly string[]>(["", "", ""]);
  const [saying, setSaying] = React.useState<readonly boolean[]>([false, false, false]);
  const [openAdmiral, setOpenAdmiral] = React.useState<AdmiralId | null>(null);
  // 단축키가 여는 부관 — 마지막으로 말을 건 쪽. 없으면 근무 중인 첫 부관.
  const lastSpokenRef = React.useRef<AdmiralId | null>(null);
  // 보조 기술에 읽어 줄 지저귐. 보이는 말풍선은 aria-hidden이라 여기서 한 번 알린다.
  const [announcedLine, setAnnouncedLine] = React.useState("");
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
  // 밴드 아래 말풍선 몇 개가 나란히 설 수 있는지는 창 폭이 정한다 — 창이 좁아지면 접는 계산이 다시 돈다.
  const [viewportWidth, setViewportWidth] = React.useState(() => window.innerWidth);

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
          pickWaypoint(body, viewportRef.current, Math.random, keepOutRef.current);
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
    // 상단 바에 둔 부관의 답도 말풍선(읽기 표면)이다 — 닻만 새가 아니라 글리프라 늘 같은 자리에
    // 선다. 정박은 새에게만 뜻이 있으므로 세우지 않는다.
    if (readDockSnapshot().host && getScuttlebuttSettings().docked[admiral]) {
      lastSpokenRef.current = admiral;
      setAnswering((current) => (current.includes(admiral) ? current : [...current, admiral]));
      void sessions[index]!.ask(text);
      return;
    }
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

  /**
   * 상단 바에 두기. 답을 위해 세운 정박과 말풍선은 거둔다 — 그 답은 시트가 이어받는다. 사용자의
   * 「제자리에 두기」 좌표는 지우지 않는다: 떼어낼 때 그 자리로 돌아간다.
   */
  const dockAide = React.useCallback((admiral: AdmiralId) => {
    closeAnswer(admiral);
    writeAideDocked(admiral, true).catch(() => undefined);
    setPositionRevision((revision) => revision + 1);
  }, [closeAnswer]);

  const undockAide = React.useCallback((admiral: AdmiralId) => {
    // 시트 뒤에 숨어 있던 Quick Launch 말풍선은 거둔다 — 시트가 이미 그 답을 보였고, 새로 돌아간
    // 부관은 정박이 없어 말풍선이 나는 새를 따라다니게 된다.
    closeAnswer(admiral);
    const body = bodiesRef.current?.[MORPHS.indexOf(admiral)];
    if (body) {
      body.grab = null;
      body.pauseUntil = 0;
      pickWaypoint(body, viewportRef.current, Math.random, keepOutRef.current);
    }
    writeAideDocked(admiral, false).catch(() => undefined);
    setPositionRevision((revision) => revision + 1);
  }, [closeAnswer]);

  // 글리프가 서고 사라지는 것도 닻의 변화다 — 시트가 다시 재게 한다.
  React.useEffect(() => subscribeDock(() => setPositionRevision((revision) => revision + 1)), []);

  // 글리프 클릭은 새 클릭과 같은 뜻이다 — 그 부관의 표면을 여닫는다.
  React.useEffect(() => connectDockActivate((admiral) => {
    lastSpokenRef.current = admiral;
    setOpenAdmiral((current) => current === admiral ? null : admiral);
  }), []);

  // 글리프가 그릴 상태: 열림·답하는 중·읽지 않은 답. 읽지 않음은 시트가 닫힌 채 답이 정착한
  // 부관에게만 서고, 그 시트를 여는 순간 걷힌다.
  const unreadRef = React.useRef(new Set<AdmiralId>());
  const phaseKey = phases.join("|");
  React.useEffect(() => {
    const previous = previousPhasesRef.current;
    for (let index = 0; index < MORPHS.length; index += 1) {
      const admiral = MORPHS[index]!;
      if (!docked[admiral]) {
        unreadRef.current.delete(admiral);
        continue;
      }
      const settled = phases[index] === "ready" && (previous[index] === "starting" || previous[index] === "thinking");
      // 말풍선이나 시트가 이미 답을 보이고 있으면 읽지 않은 것이 아니다.
      const showing = openAdmiral === admiral || answering.includes(admiral);
      if (settled && !showing) unreadRef.current.add(admiral);
      if (showing) unreadRef.current.delete(admiral);
    }
    writeDock({
      open: openAdmiral !== null && docked[openAdmiral] ? openAdmiral : null,
      busy: MORPHS.filter((admiral, index) => docked[admiral] && (phases[index] === "starting" || phases[index] === "thinking")),
      unread: MORPHS.filter((admiral) => unreadRef.current.has(admiral)),
    });
    // 완료 만세 효과와 같은 순서로 이전 단계를 갱신한다 — 여기서 먼저 갱신하면 그 효과가 전이를 놓친다.
  }, [answering, openAdmiral, phaseKey, docked]);

  // 밴드 아래 말풍선은 오른쪽부터 나란히 선다 — 화면 폭을 넘기면 가장 오래된 답부터 접어 글리프의
  // 점으로 남긴다(글리프를 누르면 시트에서 읽는다). 세로로 쌓이면 둘째 답이 화면 밖으로 밀린다.
  React.useEffect(() => {
    const showing = answering.filter((admiral) => docked[admiral]);
    const fit = Math.max(1, Math.floor((viewportWidth - 8) / (420 + 8)));
    if (showing.length <= fit) return;
    const folded = showing.slice(0, showing.length - fit);
    for (const admiral of folded) {
      if (phases[MORPHS.indexOf(admiral)] === "ready") unreadRef.current.add(admiral);
    }
    setAnswering((current) => current.filter((admiral) => !folded.includes(admiral)));
  }, [answering, phaseKey, settings.docked, viewportWidth]);


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
    const line = getT(localeRef.current)(key);
    setAnnouncedLine(`${getT(localeRef.current)(`bird.${morph}`)}: ${line}`);
    setLines((current) => replaceAt(current, index, line));
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
    lastSpokenRef.current = admiral;
    setOpenAdmiral((current) => current === admiral ? null : admiral);
  }, [triggerOneShot]);

  // Ctrl/⌘+Shift+Q — 마지막으로 말을 건 부관의 카드를 여닫는다. 모달이 입력을 독점 중이면 받지 않는다.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAideShortcut(event) || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const onDuty = MORPHS.filter((morph) => settingsRef.current[morph]);
      if (onDuty.length === 0) return;
      const target = lastSpokenRef.current && onDuty.includes(lastSpokenRef.current) ? lastSpokenRef.current : onDuty[0]!;
      event.preventDefault();
      clickAction(MORPHS.indexOf(target));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clickAction]);

  /** 방향키로 옮기기. 정박 중이면 새 자리를 저장하고, 아니면 그 자리를 다음 목적지로 삼는다. */
  const nudge = React.useCallback((index: number, dx: number, dy: number) => {
    const body = bodiesRef.current?.[index];
    if (!body) return;
    const viewport = viewportRef.current;
    body.x += dx;
    body.y += dy;
    // 모션을 줄인 화면에서는 편대 루프의 경계 clamp가 돌지 않는다 — 여기서 화면 안에 붙든다.
    clampToViewport(body, viewport);
    body.vx = 0;
    body.vy = 0;
    body.mode = "fly";
    body.pauseUntil = performance.now() / 1000 + 1.2;
    body.tx = body.x;
    body.ty = body.y;
    const admiral = MORPHS[index]!;
    if (body.moored && !mentionMooredRef.current.has(admiral)) {
      const { nx, ny } = stayPutFractions(body, viewport);
      writeAideStayPut(admiral, { enabled: true, nx, ny }).catch(() => undefined);
    }
    const element = birdRefs.current[index];
    if (element) {
      element.style.transform = `translate(${body.x - body.size.halfWidth}px, ${body.y - body.size.halfHeight}px) rotate(0deg)`;
    }
    setPositionRevision((revision) => revision + 1);
  }, []);

  const focusAdmiral = React.useCallback((admiral: AdmiralId) => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      (birdRefs.current[MORPHS.indexOf(admiral)] ?? readDockGlyph(admiral))?.focus();
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
      keepOutRef.current,
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
        pickWaypoint(body, viewport, Math.random, keepOutRef.current);
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
      setViewportWidth(window.innerWidth);
      if (fleetSignals.reducedMotion) parkBirds();
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [fleetSignals.reducedMotion, parkBirds]);

  // 모션을 줄인 화면에서는 편대 루프가 돌지 않으므로 표면이 여닫힐 때 주차 줄을 직접 다시 세운다.
  React.useEffect(() => {
    if (fleetSignals.reducedMotion && activeIndices.length > 0) parkBirds();
  }, [activeIndices.length, fleetSignals.reducedMotion, keepOutRevision, parkBirds]);

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
      pickWaypoint(body, viewportRef.current, Math.random, keepOutRef.current);
    }
    let animationFrame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const activeBodies = activeIndices.map((index) => bodies[index]!);
      const activePersonas = activeIndices.map((index) => FLOCK_PERSONAS[index]!);
      const keepOut = keepOutRef.current;
      // 비켜섰던 정박 부관은 표면이 닫히면 저장된 자리로 돌아간다 — stepFlock은 정박 부관을 움직이지
      // 않으므로 여기서 되돌린다. 저장된 자리가 아직 막혀 있으면 그대로 둔다.
      for (const index of activeIndices) {
        const body = bodies[index]!;
        if (!body.moored || body.grab) continue;
        const stay = settingsRef.current.stayPut[MORPHS[index]!];
        if (!stay.enabled || stay.nx == null || stay.ny == null) continue;
        const home = stayPutPoint(body, viewportRef.current, stay.nx, stay.ny);
        const dist = Math.hypot(home.x - body.x, home.y - body.y);
        if (dist < 1 || insideKeepOut(home.x, home.y, body.size, keepOut)) continue;
        const step = Math.min(dist, 220 * dt);
        body.x += ((home.x - body.x) / dist) * step;
        body.y += ((home.y - body.y) / dist) * step;
      }
      const activeFrames = stepFlock(
        activeBodies,
        activePersonas,
        viewportRef.current,
        dt,
        now / 1000,
        Math.random,
        keepOut,
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

  const dropArmedRef = React.useRef(false);
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
    // 밴드까지 끌어올리면 내려놓을 자리를 보인다 — 「상단 바에 두기」의 손 제스처.
    const armed = readDockSnapshot().host && event.clientY < DOCK_DROP_Y;
    if (armed !== dropArmedRef.current) {
      dropArmedRef.current = armed;
      writeDock({ dropArmed: armed });
    }
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
    pickWaypoint(body, viewportRef.current, Math.random, keepOutRef.current);
    gesturesRef.current[index] = null;
    setGrabbed((current) => replaceAt(current, index, false));
    const admiral = MORPHS[index]!;
    if (dropArmedRef.current) {
      dropArmedRef.current = false;
      writeDock({ dropArmed: false });
      if (!cancelled && moved >= 7) {
        dockAide(admiral);
        return;
      }
    }
    if (body.moored && !mentionMooredRef.current.has(admiral) && moved >= 7) {
      const { nx, ny } = stayPutFractions(body, viewportRef.current);
      writeAideStayPut(admiral, { enabled: true, nx, ny }).catch(() => undefined);
    }
  }, [clearTimer, clickAction, dockAide]);

  const t = getT(context.language);
  // 근무 중인 제독이 하나도 없으면 레이어에 아무것도 남기지 않는다. 상단 바에 둔 부관은 새가
  // 아니어도 시트·소식이 이 레이어에 서므로 남긴다.
  if (activeIndices.length === 0 && dockedAides.length === 0) return null;
  const quiet = !openAdmiral && !phases.some((phase) => phase === "starting" || phase === "thinking");

  return (
    <>
      {MORPHS.map((morph, index) => {
        if (!settings[morph] || docked[morph]) return null;
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
            <span className="scuttlebutt-visually-hidden" id={`scuttlebutt-bird-hint-${morph}`}>
              {t("bird.keyboardHint", { name: t(`bird.${morph}`) })}
            </span>
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
            aria-describedby={`scuttlebutt-bird-hint-${morph}`}
            onClick={(event) => {
              if (event.detail === 0) clickAction(index);
            }}
            onKeyDown={(event) => {
              // 방향키는 자리를, Space는 정박을 맡는다. Enter는 버튼 기본 동작(click)으로 카드를 연다.
              const fast = event.shiftKey ? KEYBOARD_STEP_FAST_PX : KEYBOARD_STEP_PX;
              const move: Record<string, readonly [number, number]> = {
                ArrowLeft: [-fast, 0],
                ArrowRight: [fast, 0],
                ArrowUp: [0, -fast],
                ArrowDown: [0, fast],
              };
              const delta = move[event.key];
              if (delta) {
                event.preventDefault();
                nudge(index, delta[0], delta[1]);
                return;
              }
              if (event.key === " " || event.code === "Space") {
                event.preventDefault();
                toggleMoored(index);
              }
            }}
            onKeyUp={(event) => {
              // keydown에서 막아도 keyup의 기본 click이 남는다 — 둘 다 막아야 카드가 열리지 않는다.
              if (event.key === " " || event.code === "Space") event.preventDefault();
            }}
          >
            {children}
          </button>
        );
      })}
      <span className="scuttlebutt-visually-hidden" aria-live="polite" aria-atomic="true">{announcedLine}</span>
      <NoticeBubble
        kind="arrival"
        source={context.arrivals}
        operations={context.operations}
        locale={context.language}
        mascot={announcerRef}
        quiet={quiet}
        positionRevision={positionRevision}
        onShow={cheerAll}
      />
      {settings.departureBell ? (
        <NoticeBubble
          kind="departure"
          source={context.departures}
          operations={context.operations}
          locale={context.language}
          mascot={announcerRef}
          quiet={quiet}
          positionRevision={positionRevision}
          onShow={saluteAll}
        />
      ) : null}
      <NoticeBubble
        kind="awaiting"
        source={context.awaitings}
        operations={context.operations}
        locale={context.language}
        mascot={announcerRef}
        quiet={quiet}
        positionRevision={positionRevision}
        onShow={saluteAll}
      />
      {!settings.introduced && quiet && (activeIndices.length > 0 || dockedAides.length > 0) ? (
        <IntroBubble
          admiral={activeIndices.length > 0 ? MORPHS[activeIndices[0]!]! : dockedAides[0]!}
          locale={context.language}
          mascot={announcerRef}
          positionRevision={positionRevision}
          onDismiss={() => {
            writeScuttlebuttSettings({ introduced: true }).catch(() => undefined);
          }}
        />
      ) : null}
      {/* Quick Launch 답변. 카드가 열리면 카드가 전문을 맡으므로 그 부관의 말풍선만 물러난다. */}
      {answering.filter((admiral) => admiral !== openAdmiral).map((admiral) => (
        <AnswerBubble
          key={admiral}
          admiral={admiral}
          state={chats[MORPHS.indexOf(admiral)]!.state}
          mascot={{ current: docked[admiral] ? readDockGlyph(admiral) : birdRefs.current[MORPHS.indexOf(admiral)] ?? null }}
          docked={docked[admiral]}
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
          mascot={{ current: docked[openAdmiral] ? readDockGlyph(openAdmiral) : birdRefs.current[MORPHS.indexOf(openAdmiral)] ?? null }}
          moored={moored[MORPHS.indexOf(openAdmiral)] ?? false}
          docked={docked[openAdmiral]}
          canDock={dockHost}
          onDock={() => dockAide(openAdmiral)}
          onUndock={() => undockAide(openAdmiral)}
          locale={context.language}
          positionRevision={positionRevision}
          onAsk={(text) => {
            lastSpokenRef.current = openAdmiral;
            void sessions[MORPHS.indexOf(openAdmiral)]!.ask(text);
          }}
          onRetry={() => void sessions[MORPHS.indexOf(openAdmiral)]!.retry()}
          onStop={() => void sessions[MORPHS.indexOf(openAdmiral)]!.stop()}
          onClear={() => sessions[MORPHS.indexOf(openAdmiral)]!.clear()}
          onHandoff={(text) => {
            setOpenAdmiral(null);
            context.composer.open({ draft: text });
          }}
          onDraftChange={sessions[MORPHS.indexOf(openAdmiral)]!.setDraft}
          onToggleMoored={() => toggleMoored(MORPHS.indexOf(openAdmiral))}
          onClose={(restoreFocus) => {
            const admiral = openAdmiral;
            setOpenAdmiral(null);
            if (restoreFocus) focusAdmiral(admiral);
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

function sameRects(left: readonly KeepOutRect[], right: readonly KeepOutRect[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (Math.abs(a.left - b.left) > 0.5 || Math.abs(a.top - b.top) > 0.5
      || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5) return false;
  }
  return true;
}
