import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/i18n";
import { useT as useConsoleT } from "../../../core/client/src/i18n/index.js";
import { prefersReducedMotion } from "../../../core/client/src/integration/reduced-motion.js";
import { modelCoordinateDisplay, prettyModelId, type ModelCoordinateValue } from "../../ai-gateway/client/components/model-coordinate-picker.js";
import { launchProviderFromGroupId, launchProviderFromModelId } from "../../ai-gateway/client/components/launch-provider-glyphs.js";
import { findRosterRow, type ModelRoster } from "../../ai-gateway/shared/models.js";
import { resolveRowEffort } from "../../execution/client/composer-primitives/effort-track.js";
import type { ObjectiveLaunchVariantRow } from "../../objectives/shared/records/types.js";
import { COMMANDER_PRESET } from "../../objectives/shared/types.js";

import { commanderByJudgment, commanderCoordinates, commanderValue, commodoreCoordinates, commodoreValue } from "./commodore-controls.js";
import { CommodoreJudgmentMark } from "./commodore-glyphs.js";
import { CommodoreSessionSettings } from "./commodore-inbox-section.js";
import { ProviderMark, RoutingPoolGlyphStack, RoutingPoolHelpButton, RoutingPoolPanel, useRoutingPoolData, type RoutingPoolData } from "./commodore-routing-pool.js";
import { effortWord, qualifying, RankMark, roleGuide, RowIntelligence, rowLadder, rowScores, ScoreReadout, type RoleGuide } from "./commodore-intelligence.js";
import { setCommodoreCommander, setCommodoreCoordinates, useCommodoreName, useCommodoreRoster, type useCommodore } from "./commodore-state.js";
import { CommodoreTheaters } from "./commodore-theater-tab.js";
import { useCommodoreList } from "./commodore-list.js";
import { requestQuotaPanelOpen } from "../../quota/client/toolbar-summary.js";
import { isSavingGlobalSettingsField, setGlobalSettingsField, useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { Select } from "../../settings/client/mobile-host.js";
import type { CommodoreMessageKey } from "./i18n/index.js";

/**
 * 데스크톱 사령관·목표 그룹 대화의 설정 칩과 팝오버 — 사령관 모델 · 지휘관 모델 · 라우팅 풀 · 작전 구역 4개 칩이
 * 입력 캡슐 안 오른쪽에 서고, 쿼터는 위 줄에 선다. 시스템 지침·자동 메모리·서브에이전트는 작전 구역 칸 아래에 선다. 칩을 누르면 칩에 매달린 팝오버가 입력창 위로 뜬다.
 * 열린 동안 칩 줄 자체가 탭 줄이 되어 ←/→ 로 칸을 옮기고, 폰·TaskForce·Theater Inbox 입력창은 이 부품을 싣지 않는다.
 */

type T = Translate<CommodoreMessageKey>;
type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;
type Speed = "standard" | "fast" | "ultrafast";
type Coordinates = { readonly model?: string; readonly effort?: string; readonly speed?: Speed };

export type CommodoreComposerSettingsSection = "commodore" | "commander" | "pool" | "theaters";
const SECTIONS: readonly CommodoreComposerSettingsSection[] = ["commodore", "commander", "pool", "theaters"];
/** 칩 줄 표시 선호의 전역 설정 필드 — 서버 전역 설정의 한 boolean이다. */
const CHIPS_EXPANDED_FIELD = "commodoreComposerChipsExpanded" as const;

/* ── 바깥에서 여는 요청 — 빈 상태의 「작전 구역 추가」·만들기 창 착지가 이 사령관 대화의 팝오버를 연다 ── */

let pending: { readonly commodoreId: string; readonly section: CommodoreComposerSettingsSection; readonly nonce: number; readonly at: number } | null = null;
/** 대화가 서기까지 기다리는 상한 — 그보다 늦게 선 대화는 옛 요청으로 칸을 열지 않는다. */
const REQUEST_TTL_MS = 10_000;
let nonce = 0;
const listeners = new Set<() => void>();
const subscribeRequest = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const readRequest = () => pending;

/** 이 사령관 대화의 설정 팝오버를 연다. 대화가 아직 서지 않았으면 선 뒤에 연다. */
export function requestCommodoreComposerSettings(commodoreId: string, section: CommodoreComposerSettingsSection): void {
  pending = { commodoreId, section, nonce: ++nonce, at: Date.now() };
  for (const listener of listeners) listener();
}

function consumeRequest(requestNonce: number): void {
  if (pending?.nonce !== requestNonce) return;
  pending = null;
}

/** 열림·칸 전환·높이 흐름의 이징(--ease-spring)과 닫힘·페이드 이징(--ease-glide) — 승인 시안 v2 수치 그대로다. */
const OPEN_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const CLOSE_EASE = "cubic-bezier(0.4, 0.14, 0.2, 1)";
const MOTION_MS = { open: 340, openFade: 180, openContent: 360, section: 420, sectionContent: 360, content: 360, close: 200 } as const;
/** 접힌 요약 ↔ 펼친 줄의 폭 흐름 — 한 상자 안에서 겹쳐 둔 두 모습이 서로 자리를 바꾼다. */
const CHIPS_MORPH_MS = 240;
type HeightChange = "section" | "content";

interface SettingsPopoverPlacement {
  readonly left: number;
  readonly width: number;
  readonly bottom: number;
  readonly maxHeight: number;
  readonly nub: number;
}

const POPOVER_MAX_WIDTH = 520;
const POPOVER_MAX_HEIGHT = 480;
const POPOVER_GAP = 6;
const POPOVER_NUB_EDGE = 18;
const POPOVER_TOP_RESERVE = 52;
const VIEWPORT_MARGIN = 8;

function placeSettingsPopover(chips: HTMLElement, chip: HTMLElement): SettingsPopoverPlacement {
  const conv = chips.closest(".objectives-commodore-conversation") ?? chips.closest(".group-chat") ?? chips.parentElement;
  const topRow = chips.closest(".conversation-composer-top") ?? chips;
  const convR = conv?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0, width: window.innerWidth };
  const chipR = chip.getBoundingClientRect();
  const topR = topRow.getBoundingClientRect();
  const gutter = Math.max(16, Math.min(48, convR.width * 0.04));
  const width = Math.max(0, Math.min(POPOVER_MAX_WIDTH, convR.width - gutter * 2, window.innerWidth - VIEWPORT_MARGIN * 2));
  const cx = chipR.left + chipR.width / 2;
  let left = Math.max(convR.left + gutter, Math.min(cx - width / 2, convR.right - gutter - width));
  // 꼬리가 모서리 반경과 겹치지 않게 칩 중심이 팝오버 끝에서 18px 안쪽에 오도록 필요한 만큼만 여백 안쪽으로(대화 칸 끝 8px까지) 민다.
  if (cx - left > width - POPOVER_NUB_EDGE) left = Math.min(convR.right - VIEWPORT_MARGIN - width, cx + POPOVER_NUB_EDGE - width);
  if (cx - left < POPOVER_NUB_EDGE) left = Math.max(convR.left + VIEWPORT_MARGIN, cx - POPOVER_NUB_EDGE);
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));
  const edge = Math.max(VIEWPORT_MARGIN, Math.min(topR.top - POPOVER_GAP, window.innerHeight - VIEWPORT_MARGIN));
  const minTop = Math.max(VIEWPORT_MARGIN, convR.top + POPOVER_TOP_RESERVE);
  const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.max(120, edge - minTop));
  const nub = Math.max(POPOVER_NUB_EDGE, Math.min(width - POPOVER_NUB_EDGE, cx - left));
  return { left, width, bottom: window.innerHeight - edge, maxHeight, nub };
}

/* ── 칩 줄 + 칩 앵커 팝오버 ── */

export function CommodoreComposerSettings({ t, commodoreId, view, disabled = false, onFail, onClear, onOpenChange }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly view: CommodoreView;
  readonly disabled?: boolean;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const ct = useConsoleT();
  const { state, defaults } = view;
  const [open, setOpen] = useState<CommodoreComposerSettingsSection | null>(null);
  const [poolHelp, setPoolHelp] = useState(false);
  const [closing, setClosing] = useState(false);
  const [placement, setPlacement] = useState<SettingsPopoverPlacement | null>(null);
  const [popoverSlide, setPopoverSlide] = useState(false);
  /** 외부 열기 요청이 접힌 줄을 잠깐 펼친 상태 — 저장값은 그대로 두고, 팝오버가 닫히면 다시 접힌다. */
  const [tempExpanded, setTempExpanded] = useState(false);
  /** Esc로 닫고 칩에 초점이 돌아온 순간의 이름표 말풍선을 한 번만 눌러 둔다. */
  const [tipMuted, setTipMuted] = useState(false);
  /** 저장이 끝나기 전에 누른 마지막 토글 목표 — 화면은 이 목표를 즉시 따르고, 저장은 직렬로 한 번 더 나간다. */
  const [chipsIntent, setChipsIntent] = useState<boolean | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const switchRef = useRef<HTMLDivElement | null>(null);
  const chipsMorphRef = useRef<Animation | null>(null);
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const unfoldRef = useRef<HTMLButtonElement | null>(null);
  /** 명시적 접기/펼치기 액션만 초점을 옮긴다 — 마운트·새로고침·창 전환은 건드리지 않는다. */
  const toggleFocusRef = useRef<"unfold" | "summary" | null>(null);
  /** 저장 중에 눌린 마지막 목표 — 그 필드의 저장이 끝난 뒤 한 번 더 저장한다. */
  const pendingChipsExpandedRef = useRef<boolean | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<CommodoreComposerSettingsSection, HTMLButtonElement>());
  const panelId = useId();
  const titleId = useId();
  const settingsStore = useGlobalSettingsStore();
  const chipsExpanded = tempExpanded || (chipsIntent ?? settingsStore.state?.commodoreComposerChipsExpanded === true);
  const name = useCommodoreName(commodoreId, t);
  const theaterCount = useCommodoreList().find((row) => row.commodoreId === commodoreId)?.theaters.length ?? 0;
  const agentRoster = useCommodoreRoster("agent");
  const launchRoster = useCommodoreRoster("launch");
  const pool = useRoutingPoolData(launchRoster, t);
  const labels = launchLabels(t);

  const chipIndicator = useSlidingIndicator(chipsRef, open !== null && !closing ? `[data-section="${open}"]` : null, `${open ?? ""}:${commodoreDisplayKey(state)}:${theaterCount}:${pool.signature}`);

  // 접힌 요약과 펼친 줄을 한 상자에 겹쳐 두고 폭만 흐르게 한다 — 조건부 교체 없이 전환해 초점이 DOM에서 사라지지 않는다.
  useLayoutEffect(() => {
    const wrapper = switchRef.current;
    if (!wrapper) return;
    const active = chipsToggleContent(wrapper, chipsExpanded);
    if (!active) return;
    const from = wrapper.getBoundingClientRect().width;
    const target = active.getBoundingClientRect().width;
    const running = chipsMorphRef.current;
    chipsMorphRef.current = null;
    running?.cancel();
    wrapper.classList.remove("is-morphing");
    if (!(target > 0)) return;
    wrapper.style.width = `${target}px`;
    if (from <= 0 || prefersReducedMotion() || typeof wrapper.animate !== "function" || Math.abs(from - target) < 1) return;
    // 폭이 흐르는 동안만 넘치는 쪽을 자른다. 끝나면 overflow를 풀어 말풍선이 클리핑되지 않는다.
    wrapper.classList.add("is-morphing");
    const anim = wrapper.animate([{ width: `${from}px` }, { width: `${target}px` }], { duration: CHIPS_MORPH_MS, easing: OPEN_EASE });
    chipsMorphRef.current = anim;
    const settle = () => {
      if (chipsMorphRef.current !== anim) return;
      chipsMorphRef.current = null;
      wrapper.classList.remove("is-morphing");
      const settled = chipsToggleContent(wrapper, chipsExpanded)?.getBoundingClientRect().width ?? 0;
      if (settled > 0) wrapper.style.width = `${settled}px`;
    };
    anim.onfinish = settle;
    anim.oncancel = settle;
  }, [chipsExpanded]);

  // 같은 모습 안에서 내용(모델명·구역 수·테마 폭)이 바뀌면 상자 폭도 따라간다 — 흐름 중에는 건드리지 않는다.
  useLayoutEffect(() => {
    const wrapper = switchRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return;
    const active = chipsToggleContent(wrapper, chipsExpanded);
    if (!active) return;
    const observer = new ResizeObserver(() => {
      if (chipsMorphRef.current) return;
      const width = active.getBoundingClientRect().width;
      if (width > 0) wrapper.style.width = `${width}px`;
    });
    observer.observe(active);
    return () => observer.disconnect();
  }, [chipsExpanded]);

  useEffect(() => {
    onOpenChange?.(open !== null && !closing);
  }, [open, closing, onOpenChange]);

  // 칸 높이의 흐름 — 칸 전환(420ms)·내용 변화(360ms) 때 마지막 자연 높이에서 새 자연 높이로 흐르고, 끝나면 height:auto 로 돌아간다.
  const motion = useRef<{ anim: Animation | null; natural: number; section: CommodoreComposerSettingsSection | null }>({ anim: null, natural: 0, section: null });
  const closingRef = useRef(false);
  const flowHeight = useCallback((change: HeightChange) => {
    const panel = panelRef.current;
    if (!panel || closingRef.current) return;
    const m = motion.current;
    const running = m.anim !== null && m.anim.playState === "running";
    const from = running ? panel.getBoundingClientRect().height : m.natural;
    m.anim?.cancel();
    m.anim = null;
    const to = panel.getBoundingClientRect().height;
    m.natural = to;
    if (prefersReducedMotion() || typeof panel.animate !== "function" || from <= 0 || Math.abs(from - to) < 1) {
      panel.classList.remove("is-flowing");
      return;
    }
    // 높이 보간 중 본문이 넘쳐 잠깐 세로 스크롤바가 서지 않게 애니메이션이 끝날 때까지만 overflow를 숨긴다.
    panel.classList.add("is-flowing");
    const anim = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: MOTION_MS[change], easing: OPEN_EASE });
    m.anim = anim;
    const settle = () => { if (m.anim === anim) { m.anim = null; panel.classList.remove("is-flowing"); } };
    anim.onfinish = settle;
    anim.oncancel = settle;
  }, []);

  const syncPlacement = useCallback((section: CommodoreComposerSettingsSection) => {
    const chips = chipsRef.current;
    const chip = chipRefs.current.get(section);
    if (!chips || !chip) return;
    setPlacement(placeSettingsPopover(chips, chip));
  }, []);

  // 열려 있는 동안 창 크기·대화 폭·칩 너비 변화에 맞춰 팝오버 위치와 꼬리를 따라잡는다.
  useLayoutEffect(() => {
    if (open === null) { setPlacement(null); return; }
    syncPlacement(open);
    let frame = 0;
    let last = "";
    const track = () => {
      const chips = chipsRef.current;
      const chip = chipRefs.current.get(open);
      if (chips && chip) {
        const next = placeSettingsPopover(chips, chip);
        const key = `${next.left},${next.width},${next.bottom},${next.maxHeight},${next.nub}`;
        if (key !== last) {
          last = key;
          setPlacement(next);
        }
      }
      frame = window.requestAnimationFrame(track);
    };
    frame = window.requestAnimationFrame(track);
    return () => window.cancelAnimationFrame(frame);
  }, [open, syncPlacement]);

  const close = useCallback((refocus: boolean) => {
    if (open === null || closingRef.current) return;
    // 잠깐 펼친 줄은 닫히며 다시 접힌다 — 초점은 사라질 칩이 아니라 접힌 단추로 돌려준다.
    const collapsingTemp = tempExpanded;
    if (refocus && !collapsingTemp) chipRefs.current.get(open)?.focus({ preventScroll: true });
    const settleTemp = () => {
      if (!collapsingTemp) return;
      setTempExpanded(false);
      if (refocus) toggleFocusRef.current = "summary";
    };
    const panel = panelRef.current;
    if (!panel || prefersReducedMotion() || typeof panel.animate !== "function") {
      motion.current.anim?.cancel();
      motion.current.anim = null;
      panel?.classList.remove("is-flowing");
      setPopoverSlide(false);
      setPoolHelp(false);
      setOpen(null);
      settleTemp();
      return;
    }
    const m = motion.current;
    m.anim?.cancel();
    closingRef.current = true;
    setClosing(true);
    const anim = panel.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px) scale(0.98)" }],
      { duration: MOTION_MS.close, easing: CLOSE_EASE, fill: "forwards" },
    );
    m.anim = anim;
    anim.onfinish = () => {
      if (m.anim !== anim) return;
      m.anim = null;
      closingRef.current = false;
      setClosing(false);
      setPopoverSlide(false);
      setPoolHelp(false);
      setOpen(null);
      settleTemp();
    };
  }, [open, tempExpanded]);

  /**
   * 칩 줄 표시 선호 저장 — 저장 중이면 마지막 목표만 남겨 두고 그 필드의 저장이 끝난 뒤 한 번 더 보낸다.
   * 화면은 누른 목표를 즉시 따르므로 빠른 연속 토글(펼침→접기, 접기→펼침)도 조용히 버려지지 않는다.
   */
  const requestChipsExpanded = (next: boolean) => {
    setChipsIntent(next);
    pendingChipsExpandedRef.current = next;
    if (isSavingGlobalSettingsField(CHIPS_EXPANDED_FIELD)) return;
    pendingChipsExpandedRef.current = null;
    void setGlobalSettingsField(CHIPS_EXPANDED_FIELD, next);
  };

  // 닫히는 중에 칩을 다시 누르면 닫힘을 멈추고 지금 보이는 상태에서 그 칸으로 다시 연다.
  const reopen = (section: CommodoreComposerSettingsSection) => {
    if (closingRef.current) {
      motion.current.anim?.cancel();
      motion.current.anim = null;
      closingRef.current = false;
      setClosing(false);
      setPopoverSlide(open !== null && open !== section);
    }
    if (section !== "pool") setPoolHelp(false);
    setOpen(section);
  };

  const toggle = (section: CommodoreComposerSettingsSection) => {
    if (closingRef.current) { reopen(section); return; }
    if (open === section) { close(false); return; }
    setPopoverSlide(open !== null);
    if (section !== "pool") setPoolHelp(false);
    setOpen(section);
  };

  useLayoutEffect(() => {
    const m = motion.current;
    if (open === null) { m.section = null; m.natural = 0; return; }
    const previous = m.section;
    const change: "open" | HeightChange = previous === null ? "open" : previous !== open ? "section" : "content";
    m.section = open;
    if (closingRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (change === "open") {
      m.natural = panel.getBoundingClientRect().height;
      if (prefersReducedMotion()) return;
      panel.animate?.([{ transform: "translateY(8px) scale(0.96)" }, { transform: "none" }], { duration: MOTION_MS.open, easing: OPEN_EASE });
      panel.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS.openFade, easing: CLOSE_EASE });
      const head = panel.querySelector(".commodore-settings-popover-head");
      const items = Array.from(panel.querySelectorAll(".commodore-composer-panel-body > div > * > *"));
      [head, ...items].filter((node): node is Element => node !== null).slice(0, 8).forEach((child, index) => {
        child.animate?.(
          [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
          { duration: MOTION_MS.openContent, delay: 40 + index * 30, easing: OPEN_EASE, fill: "backwards" },
        );
      });
      return;
    }
    flowHeight(change);
    if (change === "section" && !prefersReducedMotion()) {
      const direction = previous !== null && SECTIONS.indexOf(open) < SECTIONS.indexOf(previous) ? -1 : 1;
      panel.querySelector(".commodore-composer-panel-body > *")?.animate?.(
        [{ opacity: 0, transform: `translateX(${direction * 18}px)` }, { opacity: 1, transform: "none" }],
        { duration: MOTION_MS.sectionContent, easing: OPEN_EASE },
      );
    }
  });

  // 칸 안의 내용이 스스로 바뀌어도(작전 구역 추가·설정 읽기·모델 고르기) 높이가 흐른다.
  useEffect(() => {
    const body = panelRef.current?.querySelector(".commodore-composer-panel-body > *");
    if (!body || typeof ResizeObserver === "undefined") return;
    let lastHeight = -1;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (Math.abs(height - lastHeight) < 0.5) return;
      const first = lastHeight < 0;
      lastHeight = height;
      if (first) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => flowHeight("content"));
    });
    observer.observe(body);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [open, flowHeight]);

  // 바깥에서 온 열기 요청(빈 상태 「작전 구역 추가」 등). 접힌 줄이면 저장값을 바꾸지 않고 잠깐 펼쳐 창을 연다.
  const request = useSyncExternalStore(subscribeRequest, readRequest, readRequest);
  useEffect(() => {
    if (!request || request.commodoreId !== commodoreId) return;
    consumeRequest(request.nonce);
    if (Date.now() - request.at > REQUEST_TTL_MS) return;
    // 이미 펼쳐 둔 사람에게는 잠깐 펼침을 얹지 않는다 — 닫을 때 칩 초점 복귀를 가로채지 않게.
    if (settingsStore.state?.commodoreComposerChipsExpanded !== true) setTempExpanded(true);
    // 방금 닫혀 접힌 단추로 초점이 돌아온 참이면, 다시 펼칠 때 그 단추가 inert가 되므로 초점을 펼친 줄로 넘긴다.
    if (document.activeElement === summaryRef.current) toggleFocusRef.current = "unfold";
    reopen(request.section);
  }, [request, commodoreId]); // eslint-disable-line react-hooks/exhaustive-deps -- reopen 은 최신 상태를 읽는다.

  // 명시적 토글·잠깐 펼침의 닫힘에서만 초점을 옮긴다 — 전환으로 사라지는 단추 대신 새로 선 단추로.
  // 마운트·새로고침·창 전환은 이 플래그를 세우지 않으므로 초점을 뺏지 않는다.
  useLayoutEffect(() => {
    const target = toggleFocusRef.current;
    if (target === null) return;
    if (target === "unfold" ? !chipsExpanded : chipsExpanded) return;
    toggleFocusRef.current = null;
    (target === "unfold" ? unfoldRef.current : summaryRef.current)?.focus({ preventScroll: true });
  }, [chipsExpanded]);

  // 저장 중 눌린 마지막 목표는 그 필드의 저장이 끝난 뒤 보낸다 — 두 번째 토글이 조용히 버려지지 않는다.
  useEffect(() => {
    if (isSavingGlobalSettingsField(CHIPS_EXPANDED_FIELD) || pendingChipsExpandedRef.current === null) return;
    const next = pendingChipsExpandedRef.current;
    pendingChipsExpandedRef.current = null;
    // 그 사이 서버가 같은 값으로 끝났으면(펼침→접기→펼침) 다시 보내지 않는다.
    if (settingsStore.state?.commodoreComposerChipsExpanded === next) return;
    void setGlobalSettingsField(CHIPS_EXPANDED_FIELD, next);
  }, [settingsStore.savingFields]);

  // 저장이 끝나면 화면은 서버가 확정한 값(실패 시 되돌림)을 따른다 — 낙관 목표를 거둔다.
  useEffect(() => {
    if (chipsIntent === null) return;
    if (isSavingGlobalSettingsField(CHIPS_EXPANDED_FIELD) || pendingChipsExpandedRef.current !== null) return;
    setChipsIntent(null);
  }, [chipsIntent, settingsStore.savingFields]);

  // Esc 뒤 초점이 돌아온 칩의 이름표 말풍선은 다음 누름·키 입력까지 눌러 둔다.
  useEffect(() => {
    if (!tipMuted) return;
    const clear = () => setTipMuted(false);
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", clear, true);
    return () => {
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", clear, true);
    };
  }, [tipMuted]);

  // 바깥 누름은 닫는다 — 팝오버·칩 줄과 칸이 연 모달·좌표 메뉴 포털 안의 누름은 열어 둔다. 캡슐 누름은 닫고 초점은 그대로 둔다.
  useEffect(() => {
    if (open === null || closing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || chipsRef.current?.contains(target)) return;
      // 칸이 연 body 포털(공용 Select 목록 포함) 안의 누름도 열어 둔다 — 목록은 팝오버의 자식이 아니다.
      if (target.closest?.("[aria-modal='true'], .fc-coord-menu, .fc-select__popup, [role='menu'], [role='listbox'], [role='dialog']")) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[aria-modal='true'], .quota-popover, .fc-coord-menu, [role='menu']")) return;
      event.preventDefault();
      event.stopPropagation();
      setTipMuted(true);
      close(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closing, close]);

  // 사령관이 바뀌거나 입력이 잠기면 즉시 닫는다.
  const dismiss = () => {
    motion.current.anim?.cancel();
    motion.current.anim = null;
    panelRef.current?.classList.remove("is-flowing");
    closingRef.current = false;
    setClosing(false);
    setPopoverSlide(false);
    setPoolHelp(false);
    setOpen(null);
    setTempExpanded(false);
    toggleFocusRef.current = null;
  };
  useEffect(dismiss, [commodoreId]);
  useEffect(() => { if (disabled) dismiss(); }, [disabled]);

  const onChipKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open !== null) {
      event.preventDefault();
      event.stopPropagation();
      setTipMuted(true);
      close(true);
      return;
    }
    // 포털이 body 끝에 서 있어도 Tab은 열린 창 안으로 들어간다 — 열린 동안 칩 줄 다음의 첫 조작으로 보낸다.
    if (event.key === "Tab" && open !== null && !closing && !event.shiftKey) {
      const first = focusableIn(panelRef.current)[0];
      if (first) {
        event.preventDefault();
        first.focus({ preventScroll: true });
        return;
      }
    }
    if (open === null || closing) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = SECTIONS.indexOf(open);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? SECTIONS.length - 1 : (at + (event.key === "ArrowRight" ? 1 : SECTIONS.length - 1)) % SECTIONS.length;
    const next = SECTIONS[nextIndex]!;
    setPopoverSlide(next !== open);
    if (next !== "pool") setPoolHelp(false);
    setOpen(next);
    chipRefs.current.get(next)?.focus({ preventScroll: true });
  };

  // 열린 창 안의 Tab은 칩 줄이 아니라 창의 조작 사이를 돈다 — 첫 조작에서 Shift+Tab, 마지막에서 Tab이 순환한다.
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || closing) return;
    const items = focusableIn(panelRef.current);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      return;
    }
    if (active === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  };

  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  const commodoreDisplay = modelCoordinateDisplay(agentRoster, commodoreValue(state), defaults, labels);
  const judgment = commanderByJudgment(state);
  const commanderDisplay = modelCoordinateDisplay(launchRoster, commanderValue(state), COMMANDER_PRESET, labels);
  const commanderWord = judgment ? t("commodore.settings.commanderJudgment") : commanderDisplay.words.model;
  // 접힌 단추의 경고 점 — 라우팅 풀을 쓸 수 없거나, 도는 모델이 꺼졌거나 공급자가 사라졌을 때만.
  const chipsWarning = commodoreDisplay.off || commanderDisplay.off || pool.unavailable || (pool.entries.length > 0 && pool.usableCount === 0);
  const commodoreGuide = roleGuide("overseer", pool.thresholds);
  const commanderGuide = roleGuide("lead", pool.thresholds);
  const openPoolSection = () => { setPopoverSlide(true); setPoolHelp(false); setOpen("pool"); };
  const tabLabel = (section: CommodoreComposerSettingsSection) => section === "commodore" ? t("commodore.settings.model")
    : section === "commander" ? t("commodore.settings.commander")
      : section === "pool" ? t("commodore.pool.title")
        : ct("theaterInbox.theaters.page");
  const chip = (section: CommodoreComposerSettingsSection, aria: string, tip: string, body: ReactNode) => (
    <button
      ref={(element) => { if (element) chipRefs.current.set(section, element); else chipRefs.current.delete(section); }}
      type="button"
      data-section={section}
      data-tip={tip}
      className="commodore-composer-chip"
      aria-expanded={open === section && !closing}
      aria-controls={open === section ? panelId : undefined}
      aria-label={aria}
      disabled={disabled}
      onClick={() => toggle(section)}
    >{body}</button>
  );
  const coordinateTitle = (display: ReturnType<typeof modelCoordinateDisplay>) => display.title;
  const togglePoolHelp = (next: boolean) => {
    setPoolHelp(next);
    if (!prefersReducedMotion()) {
      panelRef.current?.querySelector(".commodore-composer-panel-body > *")?.animate?.(
        [{ opacity: 0, transform: `translateX(${next ? 18 : -18}px)` }, { opacity: 1, transform: "none" }],
        { duration: MOTION_MS.sectionContent, easing: OPEN_EASE },
      );
    }
  };
  const openQuotaFromPool = () => {
    close(false);
    requestQuotaPanelOpen();
  };

  return (
    <>
      <div ref={switchRef} className={`commodore-composer-chips-switch${chipsExpanded ? " is-expanded" : ""}`}>
        <button
          ref={summaryRef}
          type="button"
          className="commodore-composer-chips-fold"
          aria-label={t("commodore.composerSettings.expandChipsAria", { commodore: commodoreDisplay.title, commander: judgment ? commanderWord : commanderDisplay.title, theaters: theaterCount })}
          aria-expanded={chipsExpanded}
          data-tip={tipMuted ? undefined : t("commodore.composerSettings.expandChips")}
          disabled={disabled}
          inert={chipsExpanded}
          onClick={() => { setTipMuted(false); toggleFocusRef.current = "unfold"; requestChipsExpanded(true); }}
        >
          <span className="commodore-composer-chips-duo" aria-hidden="true">
            <ProviderMark provider={commodoreDisplay.provider} />
            {judgment ? <CommodoreJudgmentMark /> : <ProviderMark provider={commanderDisplay.provider} />}
          </span>
          <svg className="commodore-composer-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z" /></svg>
          <span className="commodore-composer-chip-count">{theaterCount}</span>
          <svg className="commodore-composer-chips-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
          {chipsWarning ? <span className="commodore-composer-chips-warn" aria-hidden="true" /> : null}
        </button>
        <div className="commodore-composer-chips-expanded" inert={!chipsExpanded}>
          <button
            ref={unfoldRef}
            type="button"
            className="commodore-composer-chips-unfold"
            aria-label={t("commodore.composerSettings.collapseChips")}
            data-tip={tipMuted ? undefined : t("commodore.composerSettings.collapseChips")}
            disabled={disabled}
            onClick={() => { setTipMuted(false); toggleFocusRef.current = "summary"; close(false); requestChipsExpanded(false); }}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" /></svg>
          </button>
          <div ref={chipsRef} className={`commodore-composer-chips${open !== null && !closing ? " is-open" : ""}${tipMuted ? " is-tip-muted" : ""}`} role="group" aria-label={t("commodore.composerSettings.region", { name })} onKeyDown={onChipKeyDown}>
            <span
              className={`commodore-composer-chip-ind${open !== null && !closing ? " is-open" : ""}${chipIndicator?.placed ? " is-placed" : ""}`}
              style={chipIndicator ? { left: chipIndicator.left, width: chipIndicator.width } : undefined}
              aria-hidden="true"
            />
            {chip("commodore", `${t("commodore.settings.model")}: ${coordinateTitle(commodoreDisplay)}`, t("commodore.composerSettings.commodoreChip"), (
              <CoordinateWords display={commodoreDisplay} roleLabel={t("commodore.composerSettings.commodoreShort")} />
            ))}
            {chip("commander", `${t("commodore.settings.commander")}: ${judgment ? commanderWord : coordinateTitle(commanderDisplay)}`, t("commodore.composerSettings.commanderChip"), judgment ? (
              <>
                <CommodoreJudgmentMark />
                <span className="commodore-composer-chip-role" aria-hidden="true">{t("commodore.composerSettings.commanderShort")}</span>
                <span className="commodore-composer-chip-value">{commanderWord}</span>
              </>
            ) : (
              <CoordinateWords display={commanderDisplay} roleLabel={t("commodore.composerSettings.commanderShort")} />
            ))}
            {chip("pool", pool.chipAria(t), t("commodore.pool.title"), (
              <>
                <RoutingPoolGlyphStack providers={pool.poolProviders} />
                {pool.entries.length > 0 && pool.usableCount === 0 ? <span className="commodore-pool-chip-warn" aria-hidden="true" /> : null}
              </>
            ))}
            {chip("theaters", `${ct("theaterInbox.theaters.page")} ${theaterCount}`, ct("theaterInbox.theaters.page"), (
              <>
                <svg className="commodore-composer-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z" /></svg>
                <span className="commodore-composer-chip-count">{theaterCount}</span>
              </>
            ))}
          </div>
        </div>
      </div>
      {open !== null && typeof document !== "undefined" ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          data-covers-native-view=""
          className={`commodore-settings-popover${popoverSlide ? " is-placed" : ""}${closing ? " is-closing" : ""}`}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={onPanelKeyDown}
          style={placement === null ? { visibility: "hidden" } : {
            left: placement.left,
            width: placement.width,
            bottom: placement.bottom,
            maxHeight: placement.maxHeight,
            transformOrigin: `${placement.nub}px calc(100% + ${POPOVER_GAP}px)`,
          }}
        >
          <div className="commodore-settings-popover-clip">
            <div className="commodore-settings-popover-head">
              <div className="commodore-settings-popover-title">
                <span key={open} className="commodore-settings-popover-title-in">
                  <strong id={titleId}>{tabLabel(open)}</strong>
                  {open === "pool" ? (
                    <span className="commodore-settings-popover-scope is-global">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" /></svg>
                      {t("commodore.composerSettings.scopeGlobal")}
                    </span>
                  ) : (
                    <span className="commodore-settings-popover-scope"><b>{name}</b> · {t("commodore.composerSettings.scope")}</span>
                  )}
                </span>
              </div>
              {open === "pool" ? (
                <RoutingPoolHelpButton
                  pressed={poolHelp}
                  label={t("commodore.pool.helpOpenAria")}
                  title={t("commodore.pool.helpTitle")}
                  onClick={() => togglePoolHelp(!poolHelp)}
                />
              ) : null}
              <button type="button" className="commodore-composer-panel-close" aria-label={t("commodore.composerSettings.close")} title={t("commodore.composerSettings.close")} onClick={() => close(true)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
              </button>
            </div>
            <div className="commodore-composer-panel-body" role="tabpanel"><div key={open}>
              {open === "commodore" ? (
                <CoordinateList
                  t={t}
                  roster={agentRoster}
                  value={commodoreValue(state)}
                  fallback={defaults}
                  labels={labels}
                  ariaLabel={t("commodore.drawer.modelAria")}
                  guide={commodoreGuide}
                  onPick={(next) => act(() => setCommodoreCoordinates(commodoreId, commodoreCoordinates(state, defaults, next)))}
                />
              ) : null}
              {open === "commander" ? (
                <CoordinateList
                  t={t}
                  roster={launchRoster}
                  value={commanderValue(state)}
                  fallback={COMMANDER_PRESET}
                  labels={labels}
                  ariaLabel={t("commodore.settings.commanderAria")}
                  judgment={{ active: judgment, onPick: () => act(() => setCommodoreCommander(commodoreId, null)) }}
                  judgmentSummary={commanderGuide ? <JudgmentPoolSummary t={t} pool={pool} guide={commanderGuide} onOpenPool={openPoolSection} /> : null}
                  guide={commanderGuide}
                  autoEffort
                  onPick={(next) => act(() => setCommodoreCommander(commodoreId, commanderCoordinates(state, next)))}
                />
              ) : null}
              {open === "pool" ? (
                <RoutingPoolPanel
                  t={t}
                  pool={pool}
                  showHelp={poolHelp}
                  onCloseHelp={() => togglePoolHelp(false)}
                  onOpenQuota={openQuotaFromPool}
                />
              ) : null}
              {open === "theaters" ? (
                <>
                  <div className="commodore-composer-panel-theaters"><CommodoreTheaters commodoreId={commodoreId} /></div>
                  <div className="commodore-composer-panel-split" role="separator" />
                  <div className="commodore-composer-panel-advanced"><CommodoreSessionSettings key={commodoreId} t={t} commodoreId={commodoreId} state={state} inline /></div>
                </>
              ) : null}
            </div></div>
          </div>
          <span
            className="commodore-settings-popover-nub"
            style={placement ? { left: placement.nub } : undefined}
            aria-hidden="true"
          />
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function commodoreDisplayKey(state: CommodoreView["state"]): string {
  const speed = state.speed ?? (state.fast === true ? "fast" : state.fast === false ? "standard" : "");
  return `${state.model ?? ""}:${state.effort ?? ""}:${speed}:${state.commanderModel ?? ""}:${state.commanderEffort ?? ""}`;
}

function launchLabels(t: T) {
  return {
    auto: t("commodore.board.commander.effortAuto"),
    off: t("commodore.board.launch.off"),
    fallback: t("commodore.board.launch.fallback"),
    providerRemoved: t("commodore.board.launch.providerRemoved"),
  };
}


/** 칩의 좌표 낱말 — 글리프·모델·강도는 늘 보이고, 좁은 칩 줄에서는 역할 글자가 같은 공급자 글리프들을 구분한다. */
function CoordinateWords({ display, roleLabel }: { readonly display: ReturnType<typeof modelCoordinateDisplay>; readonly roleLabel: string }) {
  return (
    <>
      {display.struck && display.removedProvider ? <span className="fc-coord-provider-name">{display.removedProvider}</span> : <ProviderMark provider={display.provider} />}
      <span className="commodore-composer-chip-role" aria-hidden="true">{roleLabel}</span>
      <span className={`commodore-composer-chip-value fc-coord-trigger-model${display.struck ? " is-off" : ""}`}>{display.words.model}</span>
      {display.words.effort ? <><span className="fc-coord-trigger-dot" aria-hidden="true">·</span><span className="fc-coord-trigger-effort">{display.words.effort}</span></> : null}
      {display.badge ? <span className="fc-coord-trigger-badge">{display.badge}</span> : null}
    </>
  );
}

/** 지금 보여야 할 칩 줄 모습 — 접힌 요약 또는 펼친 줄. */
function chipsToggleContent(wrapper: HTMLElement, expanded: boolean): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(expanded ? ".commodore-composer-chips-expanded" : ".commodore-composer-chips-fold");
}

/** 열린 창 안에서 Tab이 도는 조작들 — 보이지 않는(display:none·숨은) 조작은 뺀다. */
function focusableIn(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  const selector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter((node) => node.getClientRects().length > 0);
}

/**
 * 고른 단추를 따라 미끄러지는 면 — 그 단추의 offsetLeft·offsetWidth 로 left·width 를 옮긴다(CSS 트랜지션).
 * 처음 자리에는 미끄러지지 않고 바로 선다(`placed` 전에는 트랜지션이 없다).
 * 목록 박스 폭은 그대로인데 칩만 호버로 넓어질 수 있어, 칩 너비도 함께 본다. 그 변화는 슬라이드 없이 바로 따라가 알약이 칩과 어긋나지 않는다.
 */
function useSlidingIndicator(listRef: { readonly current: HTMLElement | null }, selector: string | null, key: unknown): { readonly left: number; readonly width: number; readonly placed: boolean } | null {
  const [indicator, setIndicator] = useState<{ readonly left: number; readonly width: number; readonly placed: boolean } | null>(null);
  const measure = useCallback((allowSlide: boolean) => {
    if (!selector) { setIndicator(null); return; }
    const button = listRef.current?.querySelector<HTMLElement>(selector);
    if (!button) { setIndicator(null); return; }
    setIndicator((previous) => ({ left: button.offsetLeft, width: button.offsetWidth, placed: allowSlide && previous !== null }));
  }, [listRef, selector]);

  useLayoutEffect(() => {
    measure(true);
  }, [measure, key]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !selector || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(list);
    for (const button of list.querySelectorAll<HTMLElement>(".commodore-composer-chip")) observer.observe(button);
    return () => observer.disconnect();
  }, [listRef, selector, measure]);

  return indicator;
}

/**
 * 모델 좌표 목록 — 공급자 머리 아래 모델 행이 서고, 지금 모델 행은 같은 줄 오른쪽에 강도 트랙과 Fast 를 단다(두 줄로 나누지 않는다).
 * 원천은 공유 선택기와 같은 로스터·표시 규칙이다: 로스터 밖 저장값은 「꺼짐」(공급자가 사라졌으면 「공급자 제거됨」) 띠에 남고,
 * 로스터가 비면 실행이 서는 폴백 좌표를 「폴백」으로 말한다. 행·강도·Fast 를 누르면 곧 저장한다.
 */
function CoordinateList({ t, roster, value, fallback, labels, ariaLabel, judgment, judgmentSummary = null, guide = null, autoEffort = false, onPick }: {
  readonly t: T;
  readonly roster: ModelRoster | null;
  readonly value: ModelCoordinateValue;
  readonly fallback: ModelCoordinateValue;
  readonly labels: ReturnType<typeof launchLabels>;
  readonly ariaLabel: string;
  readonly judgment?: { readonly active: boolean; readonly onPick: () => void };
  /** 「라우팅」이 켜져 있을 때 그 행 아래에 서는 풀 요약. */
  readonly judgmentSummary?: ReactNode;
  /** 지능 점수 안내의 역할과 기준. null이면(기준값을 아직 모르면) 안내 없이 그린다. */
  readonly guide?: RoleGuide | null;
  readonly autoEffort?: boolean;
  readonly onPick: (next: Coordinates) => void;
}) {
  const display = modelCoordinateDisplay(roster, value, fallback, labels);
  const judgmentActive = judgment?.active === true;
  const activeModel = judgmentActive ? null : display.shown.model ?? null;
  const effortNow = display.shown.effort ?? null;
  // 그 모델이 받는 속도 등급만 보인다 — 속도를 받지 않는 모델에는 리스트박스가 서지 않는다.
  const speedSupported = (row: ObjectiveLaunchVariantRow) => row.fastSupported === true || row.ultrafastSupported === true;
  const speedForRow = (row: ObjectiveLaunchVariantRow): Speed => {
    if (value.speed === "ultrafast" && row.ultrafastSupported === true) return "ultrafast";
    if ((value.speed === "fast" || value.speed === "ultrafast") && row.fastSupported === true) return "fast";
    return "standard";
  };
  // 「자동」(강도 비움)은 저장값이 강도를 비울 수 있는 지휘관 좌표에만 선다 — 사령관 좌표는 늘 구체 강도로 저장된다.
  const pickEffort = (row: ObjectiveLaunchVariantRow, effort: string | null) => {
    const model = row.launch.model ?? row.id;
    onPick(effort ? { effort } : { model, ...(speedSupported(row) ? { speed: speedForRow(row) } : {}) });
  };
  const groups = roster ?? [];
  const pickRow = (row: ObjectiveLaunchVariantRow) => {
    const model = row.launch.model ?? row.id;
    if (!judgmentActive && activeModel && model === activeModel && !display.off) return;
    const effort = resolveRowEffort(row, effortNow) ?? undefined;
    onPick({ model, ...(effort ? { effort } : {}), ...(speedSupported(row) ? { speed: "standard" as const } : {}) });
  };
  const offRow = display.off && value.model ? { model: value.model, label: prettyModelId(value.model) } : null;

  return (
    <div className="commodore-composer-coord" role="radiogroup" aria-label={ariaLabel}>
      {guide && roster !== null ? <RecommendStrip t={t} guide={guide} roster={roster} activeModel={activeModel} activeEffort={effortNow} onPick={(row, effort) => {
        const model = row.launch.model ?? row.id;
        onPick({ model, effort, ...(speedSupported(row) ? { speed: "standard" as const } : {}) });
      }} /> : null}
      {judgment ? (
        <button type="button" role="radio" aria-checked={judgmentActive} className={`commodore-composer-row is-extra${judgmentActive ? " is-active" : ""}`} onClick={() => { if (!judgmentActive) judgment.onPick(); }}>
          <CommodoreJudgmentMark />
          <span className="commodore-composer-row-label is-inline">
            <span className="commodore-composer-row-title">{t("commodore.settings.commanderJudgment")}</span>
            <small>{t("commodore.settings.commanderJudgmentHint")}</small>
          </span>
          <Check on={judgmentActive} />
        </button>
      ) : null}
      {judgmentActive && judgmentSummary ? judgmentSummary : null}
      {roster === null ? <p className="commodore-composer-panel-note">{t("commodore.board.launch.loading")}</p> : null}
      {roster !== null && roster.length === 0 ? (
        <p className="roster-fallback-note"><span className="roster-fallback-badge">{labels.fallback}</span><span className="roster-fallback-copy">{t("commodore.board.launch.empty")}</span></p>
      ) : null}
      {groups.map((group) => {
        const provider = launchProviderFromGroupId(group.id);
        return (
          <div key={group.id} className="commodore-composer-group">
            <p className="commodore-composer-group-caption">{group.label}</p>
            {group.rows.map((row) => {
              const model = row.launch.model ?? row.id;
              const active = activeModel !== null && !display.off && findRosterRow(roster, activeModel) === row;
              const hasTrack = active && (row.chips?.length ?? 0) > 0;
              const readout = active && guide ? (
                <ScoreReadout
                  key={`${row.id}:readout`}
                  t={t}
                  guide={guide}
                  row={row}
                  effort={hasTrack ? resolveRowEffort(row, effortNow) : null}
                />
              ) : null;
              return [
                <div key={row.id} className={`commodore-composer-row-line${active ? " is-active" : ""}`}>
                  <button type="button" role="radio" aria-checked={active} className={`commodore-composer-row${active ? " is-active" : ""}`} onClick={() => pickRow(row)}>
                    <ProviderMark provider={provider ?? launchProviderFromModelId(model)} />
                    <span className="commodore-composer-row-label">{row.label}</span>
                    {!active && guide ? <RowIntelligence t={t} guide={guide} row={row} /> : null}
                    {active && !hasTrack && !speedSupported(row) ? <Check on /> : null}
                  </button>
                  {hasTrack ? (
                    <EffortSegment
                      row={row}
                      value={resolveRowEffort(row, effortNow)}
                      auto={autoEffort ? labels.auto : null}
                      ariaLabel={t("commodore.board.commander.effortAria")}
                      qualifies={guide ? (effort) => (rowScores(row)[effort] ?? -1) >= guide.threshold : null}
                      scoreTitle={guide ? (effort) => {
                        const score = rowScores(row)[effort];
                        return typeof score === "number" ? t("commodore.intel.effortTitle", { effort: effortWord(effort), n: score }) : t("commodore.intel.effortTitleNone", { effort: effortWord(effort) });
                      } : null}
                      onPick={(effort) => pickEffort(row, effort)}
                    />
                  ) : null}
                  {active && speedSupported(row) ? (
                    <Select
                      className="commodore-composer-speed"
                      popupClassName="commodore-composer-speed-popup"
                      compact
                      label={t("commodore.settings.speedAria")}
                      value={speedForRow(row)}
                      options={[
                        { value: "standard", label: t("commodore.settings.speedStandard") },
                        ...(row.fastSupported === true ? [{ value: "fast", label: t("commodore.settings.fast") }] : []),
                        ...(row.ultrafastSupported === true ? [{ value: "ultrafast", label: t("commodore.settings.ultrafast") }] : []),
                      ]}
                      onChange={(next) => onPick({ model, ...(effortNow ? { effort: effortNow } : {}), speed: next as Speed })}
                    />
                  ) : null}
                </div>,
                readout,
              ];
            })}
          </div>
        );
      })}
      {offRow ? (
        <div className="commodore-composer-group">
          <p className="commodore-composer-group-caption is-off">{display.removedProvider ? labels.providerRemoved : labels.off}</p>
          <div className="commodore-composer-row-line is-active">
            <span className="commodore-composer-row is-active is-off" aria-current="true">
              {display.removedProvider ? <span className="fc-coord-provider-name">{display.removedProvider}</span> : null}
              <span className="commodore-composer-row-label">{offRow.label}</span>
            </span>
          </div>
          <p className="commodore-composer-panel-note">{t("commodore.board.launch.chooseAnotherModel")}</p>
        </div>
      ) : null}
    </div>
  );
}

function Check({ on }: { readonly on: boolean }) {
  return <svg className={`commodore-composer-check${on ? " is-on" : ""}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>;
}

/**
 * 같은 줄 오른쪽의 강도 알약 — 행이 내놓는 강도 낱말(로스터 칩)이 한 줄에 서고, 고른 단 밑을 면 하나가 미끄러진다. 누르면 곧 저장하고,
 * 저장이 돌아오기 전에도 고른 자리로 먼저 옮긴다. 방향키로 옮기며 고른다.
 */
function EffortSegment({ row, value, auto, ariaLabel, qualifies = null, scoreTitle = null, onPick }: {
  readonly row: ObjectiveLaunchVariantRow;
  readonly value: string | null;
  readonly auto: string | null;
  readonly ariaLabel: string;
  /** 지능 점수가 역할 기준에 닿는 강도 — 그 단 아래에 점을 찍는다. */
  readonly qualifies?: ((effort: string) => boolean) | null;
  readonly scoreTitle?: ((effort: string) => string) | null;
  readonly onPick: (effort: string | null) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [optimistic, setOptimistic] = useState<{ readonly effort: string | null } | null>(null);
  useEffect(() => { setOptimistic(null); }, [value]);
  const options: readonly { readonly id: string | null; readonly label: string }[] = [
    ...(auto !== null ? [{ id: null, label: auto }] : []),
    ...(row.chips ?? []).map((chip) => ({ id: chip.id, label: chip.label })),
  ];
  const current = optimistic ? optimistic.effort : value;
  const indicator = useSlidingIndicator(listRef, `[data-effort="${current ?? "auto"}"]`, `${row.id}:${current ?? "auto"}:${options.length}`);
  const choose = (effort: string | null) => {
    if (effort === current) return;
    setOptimistic({ effort });
    onPick(effort);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = Math.max(0, options.findIndex((option) => option.id === current));
    const next = options[Math.min(options.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)))];
    if (!next) return;
    choose(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-effort="${next.id ?? "auto"}"]`)?.focus();
  };
  return (
    <div ref={listRef} className="commodore-composer-effort" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {indicator ? <span className={`commodore-composer-indicator${indicator.placed ? " is-placed" : ""}`} style={{ left: indicator.left, width: indicator.width }} aria-hidden="true" /> : null}
      {options.map((option) => (
        <button
          key={option.id ?? "auto"}
          type="button"
          role="radio"
          data-effort={option.id ?? "auto"}
          className={option.id !== null && qualifies?.(option.id) ? "is-qualified" : undefined}
          title={option.id !== null && scoreTitle ? scoreTitle(option.id) : undefined}
          aria-checked={option.id === current}
          tabIndex={option.id === current ? 0 : -1}
          onClick={() => choose(option.id)}
        >{option.label}</button>
      ))}
    </div>
  );
}

/**
 * 추천 바로가기 줄 — 역할 기준에 닿는 모델을 그 가장 낮은 강도와 함께 모은다. 그 강도의 점수가 높은 순이고,
 * 같으면 로스터 순서다. 누르면 그 모델·강도로 바로 바뀐다.
 */
function RecommendStrip({ t, guide, roster, activeModel, activeEffort, onPick }: {
  readonly t: T;
  readonly guide: RoleGuide;
  readonly roster: ModelRoster;
  readonly activeModel: string | null;
  readonly activeEffort: string | null;
  readonly onPick: (row: ObjectiveLaunchVariantRow, effort: string) => void;
}) {
  const picks = roster.flatMap((group) => group.rows.flatMap((row) => {
    const pick = qualifying(rowScores(row), rowLadder(row), guide.threshold);
    return pick ? [{ row, provider: launchProviderFromGroupId(group.id) ?? launchProviderFromModelId(row.launch.model ?? row.id), ...pick }] : [];
  })).map((item, index) => ({ ...item, index })).sort((left, right) => right.score - left.score || left.index - right.index);
  if (picks.length === 0) return null;
  return (
    <div className="commodore-intel-rec" role="group" aria-label={t("commodore.intel.recHead")}>
      <div className="commodore-intel-rec-head">
        <RankMark role={guide.role} />
        <span>{t("commodore.intel.recHead")}</span>
        <small>{t("commodore.intel.recNote", { n: guide.threshold })}</small>
      </div>
      <div className="commodore-intel-rec-list">
        {picks.map((item) => {
          const model = item.row.launch.model ?? item.row.id;
          const on = activeModel !== null && findRosterRow(roster, activeModel) === item.row && activeEffort === item.effort;
          return (
            <button
              key={item.row.id}
              type="button"
              className={`commodore-intel-rec-chip${on ? " is-on" : ""}`}
              aria-pressed={on}
              title={t("commodore.intel.recPickTitle", { model: item.row.label, effort: effortWord(item.effort), n: item.score })}
              data-model={model}
              onClick={() => onPick(item.row, item.effort)}
            >
              <ProviderMark provider={item.provider} />
              <span>{item.row.label}</span>
              <span className="commodore-intel-rec-eff">{effortWord(item.effort)}</span>
              <span className="commodore-intel-rec-score">{item.score}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 지휘관 「라우팅」 행 아래 — 지금 풀의 추천 모델(켜 둔 강도 기준, MAX 포함)과 지금 못 쓰는 모델 수. 없어도 경고하지 않는다. */
function JudgmentPoolSummary({ t, pool, guide, onOpenPool }: {
  readonly t: T;
  readonly pool: RoutingPoolData;
  readonly guide: RoleGuide;
  readonly onOpenPool: () => void;
}) {
  if (pool.loading || pool.unavailable) return null;
  if (pool.entries.length === 0) {
    return (
      <p className="commodore-intel-judge">
        <span className="commodore-intel-dot" aria-hidden="true" />
        {t("commodore.intel.judgeEmpty")}
        <button type="button" className="commodore-intel-link" onClick={onOpenPool}>{t("commodore.intel.openPool")}</button>
      </p>
    );
  }
  const ready = pool.entries.filter((item) => item.status.kind === "ok" && item.lead);
  const resting = pool.entries.filter((item) => item.status.kind !== "ok" && item.lead);
  if (ready.length === 0) {
    return (
      <p className="commodore-intel-judge">
        <span className="commodore-intel-dot" aria-hidden="true" />
        {t("commodore.intel.judgeNone", { t: guide.threshold })}
        <button type="button" className="commodore-intel-link" onClick={onOpenPool}>{t("commodore.intel.openPool")}</button>
      </p>
    );
  }
  return (
    <p className="commodore-intel-judge">
      <RankMark role="lead" />
      {t("commodore.intel.judgeSome", { n: ready.length, total: pool.entries.length })}
      {ready.map((item) => (
        <span key={item.entry.id} className="commodore-intel-judge-who">
          <ProviderMark provider={item.provider} />
          {item.name}
          {item.lead ? <small>{t("commodore.intel.from", { effort: effortWord(item.lead.effort) })}</small> : null}
        </span>
      ))}
      {resting.length > 0 ? <small>· {t("commodore.intel.judgeResting", { n: resting.length })}</small> : null}
      {ready.some((item) => item.lead?.effort === "max") ? <small>· {t("commodore.intel.insMaxOnly")}</small> : null}
    </p>
  );
}
