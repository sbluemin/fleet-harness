import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";
import { useT as useConsoleT } from "../../../core/client/src/i18n/index.js";
import { modelCoordinateDisplay, prettyModelId, type ModelCoordinateValue } from "../../ai-gateway/client/components/model-coordinate-picker.js";
import { launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "../../ai-gateway/client/components/launch-provider-glyphs.js";
import { findRosterRow, type ModelRoster } from "../../ai-gateway/shared/models.js";
import { resolveRowEffort } from "../../execution/client/composer-primitives/effort-track.js";
import type { ObjectiveLaunchVariantRow } from "../../objectives/shared/records/types.js";
import { COMMANDER_PRESET } from "../../objectives/shared/types.js";

import { commanderByJudgment, commanderCoordinates, commanderValue, commodoreCoordinates, commodoreValue } from "./commodore-controls.js";
import { CommodoreJudgmentMark } from "./commodore-judgment-glyph.js";
import { CommodoreSessionSettings } from "./commodore-inbox-section.js";
import { setCommodoreCommander, setCommodoreCoordinates, useCommodoreRoster, type useCommodore } from "./commodore-state.js";
import { CommodoreTheaters } from "./commodore-theater-tab.js";
import { useCommodoreList } from "./commodore-list.js";
import { useCommodoreName } from "./commodore-name.js";
import type { CommodoreMessageKey } from "./i18n/index.js";

/**
 * 데스크톱 사령관 대화의 입력창 설정 — 옛 오른쪽 「설정」 탭의 전부(사령관 모델 · 지휘관 모델 · 작전 구역 · 고급 옵션)가 입력 캡슐 안에 선다.
 * 칩 줄은 캡슐의 정상 흐름(「+」 옆)이라 독 높이 측정이 그 자연 높이를 잰다. 칩을 누르면 같은 캡슐의 맨 위에 칸이 서고(한 테두리·한 면),
 * 캡슐은 닫힌 높이를 지키는 자리(`CommodoreComposerSlot`) 바닥에 붙은 채 위로 자란다 — 열고 닫아도 대화 스크롤·메시지 자리가 밀리지 않는다. 폰 사령관 화면과 TaskForce·Theater Inbox 입력창은 이 부품을 싣지 않는다.
 */

type T = Translate<CommodoreMessageKey>;
type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;
type Coordinates = { readonly model?: string; readonly effort?: string; readonly fast?: boolean };

export type CommodoreComposerSettingsSection = "commodore" | "commander" | "theaters" | "advanced";
const SECTIONS: readonly CommodoreComposerSettingsSection[] = ["commodore", "commander", "theaters", "advanced"];

/* ── 바깥에서 여는 요청 — 빈 상태의 「작전 구역 추가」·만들기 창 착지가 이 사령관 입력창의 칸을 연다 ── */

let pending: { readonly commodoreId: string; readonly section: CommodoreComposerSettingsSection; readonly nonce: number; readonly at: number } | null = null;
/** 대화가 서기까지 기다리는 상한 — 그보다 늦게 선 대화는 옛 요청으로 칸을 열지 않는다. */
const REQUEST_TTL_MS = 10_000;
let nonce = 0;
const listeners = new Set<() => void>();
const subscribeRequest = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const readRequest = () => pending;

/** 이 사령관 대화의 입력창 설정 칸을 연다. 대화가 아직 서지 않았으면 선 뒤에 연다. */
export function requestCommodoreComposerSettings(commodoreId: string, section: CommodoreComposerSettingsSection): void {
  pending = { commodoreId, section, nonce: ++nonce, at: Date.now() };
  for (const listener of listeners) listener();
}

function consumeRequest(requestNonce: number): void {
  if (pending?.nonce !== requestNonce) return;
  pending = null;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
/** 열림·칸 전환·높이 흐름의 이징(--ease-spring)과 닫힘 이징(--ease-glide) — 시안 ①의 수치 그대로다. */
const OPEN_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const CLOSE_EASE = "cubic-bezier(0.4, 0.14, 0.2, 1)";
const MOTION_MS = { open: 460, openContent: 520, section: 420, sectionContent: 360, content: 360, close: 320 } as const;
type HeightChange = "open" | "section" | "content";

/* ── 칩 줄 + 칸 ── */

export function CommodoreComposerSettings({ t, commodoreId, view, disabled = false, onFail, onClear }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly view: CommodoreView;
  readonly disabled?: boolean;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}) {
  const ct = useConsoleT();
  const { state, defaults } = view;
  const [open, setOpen] = useState<CommodoreComposerSettingsSection | null>(null);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<CommodoreComposerSettingsSection, HTMLButtonElement>());
  const panelId = useId();
  const name = useCommodoreName(commodoreId, t);
  const theaterCount = useCommodoreList().find((row) => row.commodoreId === commodoreId)?.theaters.length ?? 0;
  const agentRoster = useCommodoreRoster("agent");
  const launchRoster = useCommodoreRoster("launch");
  const labels = launchLabels(t);

  // 칸 높이의 흐름 — 높이 애니메이션 하나를 쥐고, 마지막 자연 높이(auto)를 기억한다. 열림은 0에서, 칸 전환·내용 바뀜은 앞 높이에서
  // 새 자연 높이로 흐르고, 끝나면 애니메이션을 걷어 height:auto 로 돌아간다. 캡슐은 닫힌 높이를 지키는 자리 바닥에 붙어 위로 자라므로 이 높이가 대화를 밀지 않는다.
  const motion = useRef<{ anim: Animation | null; natural: number; section: CommodoreComposerSettingsSection | null }>({ anim: null, natural: 0, section: null });
  const closingRef = useRef(false);
  const flowHeight = useCallback((change: HeightChange) => {
    const panel = panelRef.current;
    if (!panel || closingRef.current) return;
    const state = motion.current;
    const running = state.anim !== null && state.anim.playState === "running";
    const from = change === "open" ? 0 : running ? panel.getBoundingClientRect().height : state.natural;
    state.anim?.cancel();
    state.anim = null;
    const to = panel.getBoundingClientRect().height;
    state.natural = to;
    if (reducedMotion() || typeof panel.animate !== "function" || Math.abs(from - to) < 1) {
      panel.classList.remove("is-flowing");
      return;
    }
    // 높이 보간 중 본문이 넘쳐 잠깐 세로 스크롤바가 서지 않게 애니메이션이 끝날 때까지만 overflow를 숨긴다.
    panel.classList.add("is-flowing");
    const anim = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: MOTION_MS[change], easing: OPEN_EASE });
    state.anim = anim;
    const settle = () => { if (state.anim === anim) { state.anim = null; panel.classList.remove("is-flowing"); } };
    anim.onfinish = settle;
    anim.oncancel = settle;
  }, []);
  const close = useCallback((refocus: boolean) => {
    if (open === null || closingRef.current) return;
    if (refocus) chipRefs.current.get(open)?.focus({ preventScroll: true });
    const panel = panelRef.current;
    if (!panel || reducedMotion() || typeof panel.animate !== "function") { motion.current.anim?.cancel(); motion.current.anim = null; panel?.classList.remove("is-flowing"); setOpen(null); return; }
    const state = motion.current;
    const height = panel.getBoundingClientRect().height;
    state.anim?.cancel();
    closingRef.current = true;
    setClosing(true);
    panel.classList.add("is-flowing");
    const anim = panel.animate([{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: MOTION_MS.close, easing: CLOSE_EASE, fill: "forwards" });
    state.anim = anim;
    anim.onfinish = () => {
      if (state.anim !== anim) return;
      state.anim = null;
      panel.classList.remove("is-flowing");
      closingRef.current = false;
      setClosing(false);
      setOpen(null);
    };
  }, [open]);
  // 닫히는 중에 칩을 다시 누르면 닫힘을 멈추고 그 칸으로 다시 연다 — 높이는 지금 보이는 높이에서 흐른다.
  const reopen = (section: CommodoreComposerSettingsSection) => {
    closingRef.current = false;
    setClosing(false);
    setOpen(section);
  };
  const toggle = (section: CommodoreComposerSettingsSection) => {
    if (closingRef.current) { reopen(section); return; }
    if (open === section) { close(false); return; }
    setOpen(section);
  };
  useLayoutEffect(() => {
    const state = motion.current;
    if (open === null) { state.section = null; return; }
    const previous = state.section;
    const change: HeightChange = previous === null ? "open" : previous !== open ? "section" : "content";
    state.section = open;
    if (change === "content") { flowHeight(change); return; }
    if (closingRef.current) return;
    flowHeight(change);
    const panel = panelRef.current;
    if (!panel || reducedMotion()) return;
    if (change === "open") {
      for (const child of Array.from(panel.children)) child.animate?.([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: MOTION_MS.openContent, easing: OPEN_EASE });
      return;
    }
    const direction = previous !== null && SECTIONS.indexOf(open) < SECTIONS.indexOf(previous) ? -1 : 1;
    panel.querySelector(".commodore-composer-panel-body > *")?.animate?.([{ opacity: 0, transform: `translateX(${direction * 18}px)` }, { opacity: 1, transform: "none" }], { duration: MOTION_MS.sectionContent, easing: OPEN_EASE });
  });
  // 칸 안의 내용이 스스로 바뀌어도(작전 구역 추가·설정 읽기·모델 고르기) 높이가 흐른다.
  useEffect(() => {
    const body = panelRef.current?.querySelector(".commodore-composer-panel-body > *");
    if (!body || typeof ResizeObserver === "undefined") return;
    // 높이가 바뀔 때만, 다음 프레임에 흐른다 — 높이 애니메이션이 스크롤 막대를 세웠다 거두며 생기는 폭 변화나 같은 프레임 안의 재측정이
    // 관찰 고리를 만들지 않게 한다.
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

  // 바깥에서 온 열기 요청(빈 상태 「작전 구역 추가」 등).
  const request = useSyncExternalStore(subscribeRequest, readRequest, readRequest);
  useEffect(() => {
    if (!request || request.commodoreId !== commodoreId) return;
    consumeRequest(request.nonce);
    if (Date.now() - request.at > REQUEST_TTL_MS) return;
    reopen(request.section);
  }, [request, commodoreId]);

  // 바깥 누름은 닫는다 — 칸이 연 모달(폴더 고르기)·좌표 메뉴 같은 body 포털 안의 누름은 칸의 것이다.
  useEffect(() => {
    if (open === null || closing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // 칸은 캡슐의 일부다 — 캡슐 안(입력·「+」 포함)을 누르면 열어 둔다.
      if (!target || (rootRef.current?.closest(".fc-composer-capsule") ?? rootRef.current)?.contains(target)) return;
      if (target.closest?.("[aria-modal='true'], .fc-coord-menu, [role='menu'], [role='dialog']")) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, closing, close]);

  // 사령관이 바뀌거나 입력이 잠기면 칸을 닫는다.
  const dismiss = () => { motion.current.anim?.cancel(); motion.current.anim = null; panelRef.current?.classList.remove("is-flowing"); closingRef.current = false; setClosing(false); setOpen(null); };
  useEffect(dismiss, [commodoreId]);
  useEffect(() => { if (disabled) dismiss(); }, [disabled]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 칸이 연 모달은 body 포털이다 — React 이벤트는 여기로 올라와도 그 키는 모달의 것이다.
    if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  const onChipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open !== null) { event.preventDefault(); event.stopPropagation(); close(true); }
  };

  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  const commodoreDisplay = modelCoordinateDisplay(agentRoster, commodoreValue(state), defaults, labels);
  const judgment = commanderByJudgment(state);
  const commanderDisplay = modelCoordinateDisplay(launchRoster, commanderValue(state), COMMANDER_PRESET, labels);
  const commanderWord = judgment ? t("commodore.settings.commanderJudgment") : commanderDisplay.words.model;
  const tabLabel = (section: CommodoreComposerSettingsSection) => section === "commodore" ? t("commodore.settings.model")
    : section === "commander" ? t("commodore.settings.commander")
      : section === "theaters" ? ct("theaterInbox.theaters.page") : t("commodore.settings.advanced");
  const chip = (section: CommodoreComposerSettingsSection, aria: string, body: ReactNode, extra = "") => (
    <button
      ref={(element) => { if (element) chipRefs.current.set(section, element); else chipRefs.current.delete(section); }}
      type="button"
      className={`commodore-composer-chip${extra}`}
      aria-expanded={open === section && !closing}
      aria-controls={open === section ? panelId : undefined}
      aria-label={aria}
      title={aria}
      disabled={disabled}
      onClick={() => toggle(section)}
      onKeyDown={onChipKeyDown}
    >{body}</button>
  );
  const coordinateTitle = (display: ReturnType<typeof modelCoordinateDisplay>) => display.title;

  return (
    <div ref={rootRef} className="commodore-composer-tools">
      {open !== null ? (
        <div
          ref={panelRef}
          id={panelId}
          className={`commodore-composer-panel${closing ? " is-closing" : ""}`}
          role="dialog"
          aria-label={t("commodore.composerSettings.region", { name })}
          onKeyDown={onPanelKeyDown}
        >
          <div className="commodore-composer-panel-in">
          <div className="commodore-composer-panel-head">
            <span className="commodore-composer-panel-scope"><b>{name}</b>{t("commodore.composerSettings.scope")}</span>
            <SectionTabs sections={SECTIONS} active={open} label={(section) => tabLabel(section)} onSelect={(section) => { if (!closingRef.current) setOpen(section); }} />
            <button type="button" className="commodore-composer-panel-close" aria-label={t("commodore.composerSettings.close")} title={t("commodore.composerSettings.close")} onClick={() => close(true)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
            </button>
          </div>
          <div className="commodore-composer-panel-body" role="tabpanel"><div key={open}>
            {open === "commodore" ? (
              <CoordinateList
                t={t}
                hint={t("commodore.settings.modelHint")}
                roster={agentRoster}
                value={commodoreValue(state)}
                fallback={defaults}
                labels={labels}
                ariaLabel={t("commodore.drawer.modelAria")}
                reset={state.model !== undefined ? { label: t("commodore.settings.useDefault"), description: wordsOf(modelCoordinateDisplay(agentRoster, {}, defaults, labels)), onSelect: () => act(() => setCommodoreCoordinates(commodoreId, null)) } : null}
                onPick={(next) => act(() => setCommodoreCoordinates(commodoreId, commodoreCoordinates(state, defaults, next)))}
              />
            ) : null}
            {open === "commander" ? (
              <CoordinateList
                t={t}
                hint={t("commodore.settings.commanderHint")}
                roster={launchRoster}
                value={commanderValue(state)}
                fallback={COMMANDER_PRESET}
                labels={labels}
                ariaLabel={t("commodore.settings.commanderAria")}
                judgment={{ active: judgment, onPick: () => act(() => setCommodoreCommander(commodoreId, null)) }}
                autoEffort
                onPick={(next) => act(() => setCommodoreCommander(commodoreId, commanderCoordinates(state, next)))}
              />
            ) : null}
            {open === "theaters" ? <div className="commodore-composer-panel-theaters"><CommodoreTheaters commodoreId={commodoreId} /></div> : null}
            {open === "advanced" ? <div className="commodore-composer-panel-advanced"><CommodoreSessionSettings key={commodoreId} t={t} commodoreId={commodoreId} state={state} inline /></div> : null}
          </div></div>
          </div>
          <div className="commodore-composer-panel-rule" aria-hidden="true" />
        </div>
      ) : null}
      <div className="commodore-composer-chips">
      {chip("commodore", `${t("commodore.settings.model")}: ${coordinateTitle(commodoreDisplay)}`, <CoordinateWords display={commodoreDisplay} />)}
      {chip("commander", `${t("commodore.settings.commander")}: ${judgment ? commanderWord : coordinateTitle(commanderDisplay)}`, (
        <>
          {judgment ? <CommodoreJudgmentMark /> : <ProviderMark provider={commanderDisplay.provider} />}
          <span className="commodore-composer-chip-label">{t("commodore.composerSettings.commanderChip")}</span>
          <span className={`commodore-composer-chip-value${!judgment && commanderDisplay.struck ? " is-off" : ""}`}>{commanderWord}</span>
          {!judgment && commanderDisplay.badge ? <span className="fc-coord-trigger-badge">{commanderDisplay.badge}</span> : null}
        </>
      ))}
      {chip("theaters", `${ct("theaterInbox.theaters.page")} ${theaterCount}`, (
        <>
          <svg className="commodore-composer-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z" /></svg>
          <span className="commodore-composer-chip-label">{ct("theaterInbox.theaters.page")}</span>
          <span className="commodore-composer-chip-count">{theaterCount}</span>
        </>
      ))}
      {chip("advanced", t("commodore.settings.advanced"), (
        <svg className="commodore-composer-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h6M12 5h1M3 11h1M7 11h6" /><circle cx="10.5" cy="5" r="1.5" /><circle cx="5.5" cy="11" r="1.5" /></svg>
      ), " is-icon")}
      </div>
    </div>
  );
}

function launchLabels(t: T) {
  return {
    auto: t("commodore.board.commander.effortAuto"),
    off: t("commodore.board.launch.off"),
    fallback: t("commodore.board.launch.fallback"),
    providerRemoved: t("commodore.board.launch.providerRemoved"),
  };
}

const wordsOf = (display: ReturnType<typeof modelCoordinateDisplay>) => [display.words.model, display.words.effort].filter(Boolean).join(" · ");

function ProviderMark({ provider }: { readonly provider: LaunchProviderGlyphId | null }) {
  if (!provider) return null;
  return <span className={`objective-launch-provider-glyph fc-coord-trigger-provider is-${provider}`} aria-hidden="true">{launchProviderGlyph(provider)}</span>;
}

/** 칩의 좌표 낱말 — 공유 선택기 트리거와 같은 「[글리프] 모델 · 강도 [꺼짐·폴백]」 문법이다. */
function CoordinateWords({ display }: { readonly display: ReturnType<typeof modelCoordinateDisplay> }) {
  return (
    <>
      {display.struck && display.removedProvider ? <span className="fc-coord-provider-name">{display.removedProvider}</span> : <ProviderMark provider={display.provider} />}
      <span className={`commodore-composer-chip-value fc-coord-trigger-model${display.struck ? " is-off" : ""}`}>{display.words.model}</span>
      {display.words.effort ? <><span className="fc-coord-trigger-dot" aria-hidden="true">·</span><span className="fc-coord-trigger-effort">{display.words.effort}</span></> : null}
      {display.badge ? <span className="fc-coord-trigger-badge">{display.badge}</span> : null}
    </>
  );
}

/**
 * 고른 단추를 따라 미끄러지는 면 — 그 단추의 offsetLeft·offsetWidth 로 left·width 를 옮긴다(CSS 트랜지션). 처음 자리에는 미끄러지지 않고
 * 바로 선다(`placed` 전에는 트랜지션이 없다).
 */
function useSlidingIndicator(listRef: { readonly current: HTMLElement | null }, selector: string, key: unknown): { readonly left: number; readonly width: number; readonly placed: boolean } | null {
  const [indicator, setIndicator] = useState<{ readonly left: number; readonly width: number; readonly placed: boolean } | null>(null);
  useLayoutEffect(() => {
    const button = listRef.current?.querySelector<HTMLElement>(selector);
    if (!button) { setIndicator(null); return; }
    setIndicator((previous) => ({ left: button.offsetLeft, width: button.offsetWidth, placed: previous !== null }));
  }, [selector, key]); // eslint-disable-line react-hooks/exhaustive-deps -- listRef 는 고정 ref 다.
  return indicator;
}

/** 칸 이름 줄 — 고른 칸 밑을 미끄러지는 면 하나가 따라간다. 방향키로 칸을 옮긴다. */
function SectionTabs({ sections, active, label, onSelect }: {
  readonly sections: readonly CommodoreComposerSettingsSection[];
  readonly active: CommodoreComposerSettingsSection;
  readonly label: (section: CommodoreComposerSettingsSection) => string;
  readonly onSelect: (section: CommodoreComposerSettingsSection) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const indicator = useSlidingIndicator(listRef, `[data-section="${active}"]`, active);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = sections.indexOf(active);
    const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (at + (event.key === "ArrowRight" ? 1 : sections.length - 1)) % sections.length;
    const section = sections[next]!;
    onSelect(section);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`)?.focus();
  };
  return (
    <div ref={listRef} className="commodore-composer-tabs" role="tablist" onKeyDown={onKeyDown}>
      {indicator ? <span className={`commodore-composer-indicator${indicator.placed ? " is-placed" : ""}`} style={{ left: indicator.left, width: indicator.width }} aria-hidden="true" /> : null}
      {sections.map((section) => (
        <button key={section} type="button" role="tab" data-section={section} aria-selected={section === active} tabIndex={section === active ? 0 : -1} onClick={() => onSelect(section)}>{label(section)}</button>
      ))}
    </div>
  );
}

/**
 * 모델 좌표 목록 — 공급자 머리 아래 모델 행이 서고, 지금 모델 행은 같은 줄 오른쪽에 강도 트랙과 Fast 를 단다(두 줄로 나누지 않는다).
 * 원천은 공유 선택기와 같은 로스터·표시 규칙이다: 로스터 밖 저장값은 「꺼짐」(공급자가 사라졌으면 「공급자 제거됨」) 띠에 남고,
 * 로스터가 비면 실행이 서는 폴백 좌표를 「폴백」으로 말한다. 행·강도·Fast 를 누르면 곧 저장한다.
 */
function CoordinateList({ t, hint, roster, value, fallback, labels, ariaLabel, judgment, reset, autoEffort = false, onPick }: {
  readonly t: T;
  readonly hint: string;
  readonly roster: ModelRoster | null;
  readonly value: ModelCoordinateValue;
  readonly fallback: ModelCoordinateValue;
  readonly labels: ReturnType<typeof launchLabels>;
  readonly ariaLabel: string;
  readonly judgment?: { readonly active: boolean; readonly onPick: () => void };
  readonly reset?: { readonly label: string; readonly description: string; readonly onSelect: () => void } | null;
  readonly autoEffort?: boolean;
  readonly onPick: (next: Coordinates) => void;
}) {
  const display = modelCoordinateDisplay(roster, value, fallback, labels);
  const judgmentActive = judgment?.active === true;
  const activeModel = judgmentActive ? null : display.shown.model ?? null;
  const activeRow = activeModel ? findRosterRow(roster, activeModel) : null;
  const effortNow = display.shown.effort ?? null;
  const fastNow = value.fast === true;
  // 「자동」(강도 비움)은 저장값이 강도를 비울 수 있는 지휘관 좌표에만 선다 — 사령관 좌표는 늘 구체 강도로 저장된다.
  const pickEffort = (row: ObjectiveLaunchVariantRow, effort: string | null) => {
    const model = row.launch.model ?? row.id;
    onPick(effort ? { effort } : { model, ...(row.fastSupported === true ? { fast: fastNow } : {}) });
  };
  const groups = roster ?? [];
  const pickRow = (row: ObjectiveLaunchVariantRow) => {
    const model = row.launch.model ?? row.id;
    if (!judgmentActive && activeModel && model === activeModel && !display.off) return;
    const effort = resolveRowEffort(row, effortNow) ?? undefined;
    onPick({ model, ...(effort ? { effort } : {}), ...(row.fastSupported === true ? { fast: false } : {}) });
  };
  const offRow = display.off && value.model ? { model: value.model, label: prettyModelId(value.model) } : null;

  return (
    <div className="commodore-composer-coord" role="radiogroup" aria-label={ariaLabel}>
      <p className="commodore-composer-panel-hint">{hint}</p>
      {judgment ? (
        <button type="button" role="radio" aria-checked={judgmentActive} className={`commodore-composer-row is-extra${judgmentActive ? " is-active" : ""}`} onClick={() => { if (!judgmentActive) judgment.onPick(); }}>
          <CommodoreJudgmentMark />
          <span className="commodore-composer-row-label">{t("commodore.settings.commanderJudgment")}<small>{t("commodore.settings.commanderJudgmentHint")}</small></span>
          <Check on={judgmentActive} />
        </button>
      ) : null}
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
              return (
                <div key={row.id} className={`commodore-composer-row-line${active ? " is-active" : ""}`}>
                  <button type="button" role="radio" aria-checked={active} className={`commodore-composer-row${active ? " is-active" : ""}`} onClick={() => pickRow(row)}>
                    <ProviderMark provider={provider ?? launchProviderFromModelId(model)} />
                    <span className="commodore-composer-row-label">{row.label}</span>
                    {active && !hasTrack && row.fastSupported !== true ? <Check on /> : null}
                  </button>
                  {hasTrack ? (
                    <EffortSegment
                      row={row}
                      value={resolveRowEffort(row, effortNow)}
                      auto={autoEffort ? labels.auto : null}
                      ariaLabel={t("commodore.board.commander.effortAria")}
                      onPick={(effort) => pickEffort(row, effort)}
                    />
                  ) : null}
                  {active && row.fastSupported === true ? (
                    <button type="button" className="commodore-composer-fast" aria-pressed={fastNow} onClick={() => onPick({ model, ...(effortNow ? { effort: effortNow } : {}), fast: !fastNow })}>{t("commodore.settings.fast")}</button>
                  ) : null}
                </div>
              );
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
      {reset ? (
        <button type="button" className="commodore-composer-row is-reset" onClick={reset.onSelect}>
          <span className="commodore-composer-row-label">{reset.label}<small>{reset.description}</small></span>
        </button>
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
function EffortSegment({ row, value, auto, ariaLabel, onPick }: {
  readonly row: ObjectiveLaunchVariantRow;
  readonly value: string | null;
  readonly auto: string | null;
  readonly ariaLabel: string;
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
        <button key={option.id ?? "auto"} type="button" role="radio" data-effort={option.id ?? "auto"} aria-checked={option.id === current} tabIndex={option.id === current ? 0 : -1} onClick={() => choose(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}
