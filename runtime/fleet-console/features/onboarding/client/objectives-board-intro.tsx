import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { openCommandBoard } from "../../workspace/client/command-board/command-board-store.js";
import { MongleAvatar } from "../../workspace/client/components/mongle-avatar.js";
import { mongleBase } from "../../workspace/shared/avatars.js";
import type { FeatureCardContentProps, FeatureCardLinkProps } from "./feature-cards.js";
import "./objectives-board-intro.css";

type MiniColumnId = "fresh" | "active" | "review" | "done";
type MiniViewMode = "unified" | "commodore" | "matrix";
type MiniTone = "moss" | "crimson" | "cerulean" | "amber";

interface MiniObjective {
  readonly id: string;
  readonly col: MiniColumnId;
  readonly baseId: number;
  readonly tone: MiniTone;
  readonly ko: string;
  readonly en: string;
  readonly meta: string;
}

interface PresetAction {
  readonly label: string;
  readonly next: MiniColumnId | "archive";
}

interface ObjectivesBoardIntroCopy {
  readonly eyebrow: string;
  readonly badge: string;
  readonly title: string;
  readonly bodyPre: string;
  readonly bodyEm1: string;
  readonly bodyMid: string;
  readonly bodyEm2: string;
  readonly bodyPost: string;
  readonly link: string;
  readonly boardTitle: string;
  readonly summary: (commodores: number, total: number) => string;
  readonly views: Readonly<Record<MiniViewMode, string>>;
  readonly cols: Readonly<Record<MiniColumnId, string>>;
  readonly demoPlay: string;
  readonly demoStop: string;
  readonly demoReset: string;
  readonly allCommodores: string;
  readonly trayHint: (name: string) => string;
  readonly inputPlaceholder: string;
  readonly sendAria: string;
  readonly closeTrayAria: string;
  readonly presets: Readonly<Record<MiniColumnId, readonly PresetAction[]>>;
  readonly tags: Readonly<Record<Exclude<MiniColumnId, "fresh">, string>>;
  readonly toastMoved: (name: string, col: string) => string;
  readonly toastCustom: (name: string, text: string, col: string) => string;
  readonly toastArchived: (name: string) => string;
  readonly empty: string;
}

const isApplePlatform = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

const copyKo = (shortcut: string): ObjectivesBoardIntroCopy => ({
  eyebrow: "새 기능",
  badge: shortcut,
  title: "목표 보드: 모든 사령관의 목표를 한눈에 보고 바로 지시해요",
  bodyPre: "사이드바와 패널에 흩어져 있던 목표를 ",
  bodyEm1: "시작 전·진행 중·검토 대기·완료 4열",
  bodyMid: "로 모았어요. 통합·사령관별·매트릭스 보기를 오가며 ",
  bodyEm2: "카드에서 사령관에게 바로 지시",
  bodyPost: "할 수 있어요.",
  link: `목표 열기 (${shortcut})`,
  boardTitle: "목표",
  summary: (commodores, total) => `${commodores} 사령관 · ${total} 목표`,
  views: { unified: "통합", commodore: "사령관별", matrix: "매트릭스" },
  cols: { fresh: "시작 전", active: "진행 중", review: "검토 대기", done: "완료" },
  demoPlay: "시연",
  demoStop: "멈춤",
  demoReset: "초기화",
  allCommodores: "전체 사령관",
  trayHint: (name) => `${name}에게 바로 지시`,
  inputPlaceholder: "지시 입력 후 Enter…",
  sendAria: "지시 보내기",
  closeTrayAria: "지시 창 닫기",
  presets: {
    fresh: [{ label: "바로 시작해 줘", next: "active" }],
    active: [{ label: "검토로 올려 줘", next: "review" }],
    review: [
      { label: "승인 · 완료 처리", next: "done" },
      { label: "수정 요청", next: "active" },
    ],
    done: [{ label: "보관함 정리", next: "archive" }],
  },
  tags: { active: "진행 중", review: "확인 필요", done: "완료" },
  toastMoved: (name, col) => `${name}에게 지시 전달 → 「${col}」로 이동`,
  toastCustom: (name, text, col) => `${name}: “${text}” → ${col}`,
  toastArchived: (name) => `${name}의 완료 목표를 보관함으로 정리했어요`,
  empty: "비어 있음",
});

const copyEn = (shortcut: string): ObjectivesBoardIntroCopy => ({
  eyebrow: "New",
  badge: shortcut,
  title: "Objectives: Track every Commodore’s work and instruct inline",
  bodyPre: "All objectives now live in ",
  bodyEm1: "four columns — Not started, In progress, Awaiting review, and Done",
  bodyMid: ". Switch between Unified, By Commodore, and Matrix views, and ",
  bodyEm2: "instruct Commodores directly from any card",
  bodyPost: ".",
  link: `Open Objectives (${shortcut})`,
  boardTitle: "Objectives",
  summary: (commodores, total) => `${commodores} commodores · ${total} total`,
  views: { unified: "Unified", commodore: "By Commodore", matrix: "Matrix" },
  cols: { fresh: "Not started", active: "In progress", review: "Review", done: "Done" },
  demoPlay: "Demo",
  demoStop: "Stop",
  demoReset: "Reset",
  allCommodores: "All",
  trayHint: (name) => `Instruct ${name} inline`,
  inputPlaceholder: "Type instruction & press Enter…",
  sendAria: "Send instruction",
  closeTrayAria: "Close instruction tray",
  presets: {
    fresh: [{ label: "Start now", next: "active" }],
    active: [{ label: "Ready for review", next: "review" }],
    review: [
      { label: "Approve & finish", next: "done" },
      { label: "Request tweaks", next: "active" },
    ],
    done: [{ label: "Archive", next: "archive" }],
  },
  tags: { active: "Running", review: "Needs review", done: "Done" },
  toastMoved: (name, col) => `Sent to ${name} → moved to “${col}”`,
  toastCustom: (name, text, col) => `${name}: “${text}” → ${col}`,
  toastArchived: (name) => `Archived ${name}’s completed objective`,
  empty: "Empty",
});

function boardCopy(locale: ConsoleLocale): ObjectivesBoardIntroCopy {
  const shortcut = isApplePlatform() ? "⌘B" : "Ctrl+B";
  return locale === "ko" ? copyKo(shortcut) : copyEn(shortcut);
}

const INITIAL_ITEMS: readonly MiniObjective[] = [
  { id: "o1", col: "fresh", baseId: 16, tone: "moss", ko: "릴리스 노트 한·영 검수", en: "Review bilingual notes", meta: "D-1" },
  { id: "o2", col: "fresh", baseId: 1, tone: "cerulean", ko: "모바일 탭 전환 정리", en: "Polish mobile tab switch", meta: "2m" },
  { id: "o3", col: "active", baseId: 17, tone: "crimson", ko: "매트릭스 필터 최적화", en: "Optimize matrix filters", meta: "3/4" },
  { id: "o4", col: "active", baseId: 3, tone: "amber", ko: "다크·라이트 대비 점검", en: "Audit theme contrast", meta: "1/2" },
  { id: "o5", col: "review", baseId: 18, tone: "cerulean", ko: "원격 링크 동작 검증", en: "Verify remote link flow", meta: "PR" },
  { id: "o6", col: "done", baseId: 16, tone: "moss", ko: "프로스트 블러 적용", en: "Ship frosted blur scrim", meta: "✓" },
];

const COLUMNS: readonly MiniColumnId[] = ["fresh", "active", "review", "done"];
const LANE_BASES: readonly { readonly baseId: number; readonly tone: MiniTone }[] = [
  { baseId: 16, tone: "moss" },
  { baseId: 17, tone: "crimson" },
  { baseId: 18, tone: "cerulean" },
  { baseId: 1, tone: "cerulean" },
  { baseId: 3, tone: "amber" },
];

function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function BoardGlyph(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
      <rect x="6.4" y="2.5" width="3.2" height="7.5" rx="1" />
      <rect x="10.8" y="2.5" width="3.2" height="9.2" rx="1" />
    </svg>
  );
}

/** 목표 보드(칸반) 소개 카드 본문 — 추상 모션 대신 실제 4열·3종 보기·인라인 지시를 축소 보드로 직접 체험한다. */
export function ObjectivesBoardIntroCard({ titleId }: FeatureCardContentProps): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const copy = boardCopy(locale);
  const osReduced = useOsReducedMotion();
  const settingReduced = useGlobalSettingsStore().state?.reduceMotion === true;
  const reduced = osReduced || settingReduced;

  const [items, setItems] = useState<readonly MiniObjective[]>(INITIAL_ITEMS);
  const [viewMode, setViewMode] = useState<MiniViewMode>("unified");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [matrixFocus, setMatrixFocus] = useState<number | "all">("all");
  const [lastMovedId, setLastMovedId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);

  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopDemo = useCallback((): void => {
    for (const timer of demoTimersRef.current) clearTimeout(timer);
    demoTimersRef.current = [];
    setDemoRunning(false);
  }, []);

  useEffect(() => () => {
    for (const timer of demoTimersRef.current) clearTimeout(timer);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    if (movedTimerRef.current !== null) clearTimeout(movedTimerRef.current);
  }, []);

  const showToast = useCallback((message: string): void => {
    setToast(message);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2400);
  }, []);

  const nameOf = useCallback((baseId: number): string => {
    const preset = mongleBase(baseId);
    return locale === "ko" ? preset.name.ko : preset.name.en;
  }, [locale]);

  const dispatchCard = useCallback((item: MiniObjective, nextCol: MiniColumnId | "archive", customText?: string): void => {
    const ownerName = nameOf(item.baseId);
    if (nextCol === "archive") {
      setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      setSelectedId(null);
      setInputValue("");
      showToast(copy.toastArchived(ownerName));
      return;
    }
    setItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, col: nextCol } : entry)));
    setLastMovedId(item.id);
    if (movedTimerRef.current !== null) clearTimeout(movedTimerRef.current);
    movedTimerRef.current = setTimeout(() => {
      movedTimerRef.current = null;
      setLastMovedId(null);
    }, 520);
    setSelectedId(null);
    setInputValue("");
    const colLabel = copy.cols[nextCol];
    showToast(customText ? copy.toastCustom(ownerName, customText, colLabel) : copy.toastMoved(ownerName, colLabel));
  }, [copy, nameOf, showToast]);

  const isModified = items.length !== INITIAL_ITEMS.length
    || items.some((entry, idx) => entry.id !== INITIAL_ITEMS[idx]?.id || entry.col !== INITIAL_ITEMS[idx]?.col);

  const runDemo = useCallback((): void => {
    stopDemo();
    setItems(INITIAL_ITEMS);
    setViewMode("unified");
    setMatrixFocus("all");
    setSelectedId(null);
    setDemoRunning(true);

    const schedule = (ms: number, fn: () => void): void => {
      demoTimersRef.current.push(setTimeout(fn, ms));
    };
    const first = INITIAL_ITEMS[0]!;
    const fifth = INITIAL_ITEMS[4]!;
    schedule(500, () => setSelectedId(first.id));
    schedule(1650, () => dispatchCard(first, "active"));
    schedule(2750, () => setSelectedId(fifth.id));
    schedule(3900, () => dispatchCard(fifth, "done"));
    schedule(5050, () => setViewMode("commodore"));
    schedule(6750, () => {
      setViewMode("matrix");
      setMatrixFocus(16);
    });
    schedule(8500, () => {
      setViewMode("unified");
      setMatrixFocus("all");
      setDemoRunning(false);
    });
  }, [dispatchCard, stopDemo]);

  const handleDemoButton = (): void => {
    if (demoRunning) {
      stopDemo();
      return;
    }
    if (isModified) {
      setItems(INITIAL_ITEMS);
      setSelectedId(null);
      setViewMode("unified");
      setMatrixFocus("all");
      return;
    }
    runDemo();
  };

  const selectedItem = selectedId ? items.find((entry) => entry.id === selectedId) ?? null : null;
  const uniqueCommodores = Math.max(4, new Set(items.map((entry) => entry.baseId)).size);

  const renderCard = (item: MiniObjective): React.JSX.Element => {
    const ownerName = nameOf(item.baseId);
    const title = locale === "ko" ? item.ko : item.en;
    const isSelected = selectedId === item.id;
    const isJustMoved = lastMovedId === item.id;
    const avatarState = item.col === "active" ? "running" : item.col === "review" ? "review" : "idle";
    return (
      <button
        key={item.id}
        type="button"
        className={`obi-card${isSelected ? " is-selected" : ""}${isJustMoved ? " is-just-moved" : ""}`}
        onClick={() => {
          stopDemo();
          setSelectedId((cur) => (cur === item.id ? null : item.id));
          setInputValue("");
        }}
      >
        <div className="obi-card-top">
          <span className="obi-owner">
            <MongleAvatar base={item.baseId} role="commodore" state={avatarState} size={18} label={ownerName} decorative />
            <span className={`obi-owner-name obi-tone--${item.tone}`}>{ownerName}</span>
          </span>
        </div>
        <div className="obi-card-title">{title}</div>
        <div className="obi-card-meta">
          {item.col === "fresh" ? (
            <span>{item.meta}</span>
          ) : (
            <span className={`obi-tag obi-tag--${item.col}`}>{copy.tags[item.col]}</span>
          )}
          <span className="obi-card-hint" aria-hidden="true">↵</span>
        </div>
      </button>
    );
  };

  const renderFourColumns = (source: readonly MiniObjective[]): React.JSX.Element => (
    <div className="obi-grid">
      {COLUMNS.map((colId) => {
        const colItems = source.filter((entry) => entry.col === colId);
        return (
          <div key={colId} className="obi-col">
            <div className="obi-col-head">
              <span className="obi-col-title-wrap">
                <span className={`obi-dot obi-dot--${colId}`} aria-hidden="true" />
                <span className="obi-col-title">{copy.cols[colId]}</span>
              </span>
              <span className="obi-col-count">{colItems.length}</span>
            </div>
            <div className="obi-col-list">
              {colItems.length > 0 ? colItems.map(renderCard) : <div className="obi-empty">{copy.empty}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="tfi-head">
        <span className="tfi-eyebrow">{copy.eyebrow}</span>
        <span className="tfi-chip">{copy.badge}</span>
      </div>
      <h2 id={titleId} className="tfi-title">{copy.title}</h2>
      <div className={`obi-stage${reduced ? " is-reduced" : ""}`}>
        <div className="obi-shell">
          <div className="obi-topbar">
            <div className="obi-pill">
              <span className="obi-pill-mark"><BoardGlyph /></span>
              <span>{copy.boardTitle}</span>
              <span className="obi-pill-sub">{copy.summary(uniqueCommodores, items.length)}</span>
            </div>
            <div className="obi-topbar-right">
              <div className="obi-views" role="tablist" aria-label={copy.boardTitle}>
                {(["unified", "commodore", "matrix"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === mode}
                    className={`obi-view-btn${viewMode === mode ? " is-active" : ""}`}
                    onClick={() => {
                      stopDemo();
                      setViewMode(mode);
                      setSelectedId(null);
                    }}
                  >
                    {copy.views[mode]}
                  </button>
                ))}
              </div>
              {reduced ? null : (
                <button type="button" className="obi-demo-btn" onClick={handleDemoButton}>
                  {demoRunning ? copy.demoStop : isModified ? copy.demoReset : copy.demoPlay}
                </button>
              )}
            </div>
          </div>

          <div className="obi-board-area">
            {viewMode === "unified" ? renderFourColumns(items) : null}

            {viewMode === "commodore" ? (
              <div className="obi-lanes">
                {LANE_BASES.map((lane) => {
                  const laneItems = items.filter((entry) => entry.baseId === lane.baseId);
                  if (laneItems.length === 0) return null;
                  const ownerName = nameOf(lane.baseId);
                  return (
                    <div key={lane.baseId} className="obi-lane">
                      <div className="obi-lane-head">
                        <span className="obi-owner">
                          <MongleAvatar base={lane.baseId} role="commodore" state="idle" size={18} label={ownerName} decorative />
                          <span className={`obi-owner-name obi-tone--${lane.tone}`}>{ownerName}</span>
                        </span>
                        <span className="obi-col-count">{laneItems.length}</span>
                      </div>
                      <div className="obi-lane-cards">{laneItems.map(renderCard)}</div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {viewMode === "matrix" ? (
              <div className="obi-matrix">
                <div className="obi-rail">
                  <button
                    type="button"
                    className={`obi-rail-item${matrixFocus === "all" ? " is-active" : ""}`}
                    onClick={() => {
                      stopDemo();
                      setMatrixFocus("all");
                      setSelectedId(null);
                    }}
                  >
                    <span className="obi-rail-label">{copy.allCommodores}</span>
                    <span className="obi-rail-count">{items.length}</span>
                  </button>
                  {LANE_BASES.map((lane) => {
                    const count = items.filter((entry) => entry.baseId === lane.baseId).length;
                    const ownerName = nameOf(lane.baseId);
                    return (
                      <button
                        key={lane.baseId}
                        type="button"
                        className={`obi-rail-item${matrixFocus === lane.baseId ? " is-active" : ""}`}
                        onClick={() => {
                          stopDemo();
                          setMatrixFocus(lane.baseId);
                          setSelectedId(null);
                        }}
                      >
                        <span className="obi-owner">
                          <MongleAvatar base={lane.baseId} role="commodore" state="idle" size={16} label={ownerName} decorative />
                          <span className="obi-rail-label">{ownerName}</span>
                        </span>
                        <span className="obi-rail-count">{count}</span>
                      </button>
                    );
                  })}
                </div>
                {renderFourColumns(matrixFocus === "all" ? items : items.filter((entry) => entry.baseId === matrixFocus))}
              </div>
            ) : null}

            {selectedItem ? (
              <div className="obi-tray">
                <div className="obi-tray-head">
                  <span className="obi-owner">
                    <MongleAvatar
                      base={selectedItem.baseId}
                      role="commodore"
                      state="running"
                      size={18}
                      label={nameOf(selectedItem.baseId)}
                      decorative
                    />
                    <strong className={`obi-tone--${selectedItem.tone}`}>{copy.trayHint(nameOf(selectedItem.baseId))}</strong>
                    <span className="obi-tray-title">· {locale === "ko" ? selectedItem.ko : selectedItem.en}</span>
                  </span>
                  <button
                    type="button"
                    className="obi-tray-close"
                    aria-label={copy.closeTrayAria}
                    onClick={() => setSelectedId(null)}
                  >
                    ✕
                  </button>
                </div>
                <div className="obi-tray-chips">
                  {copy.presets[selectedItem.col].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="obi-preset-btn"
                      onClick={() => {
                        stopDemo();
                        dispatchCard(selectedItem, preset.next);
                      }}
                    >
                      ✦ {preset.label}
                    </button>
                  ))}
                </div>
                <form
                  className="obi-tray-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    stopDemo();
                    const trimmed = inputValue.trim();
                    const defaultNext = copy.presets[selectedItem.col][0]?.next ?? "done";
                    dispatchCard(selectedItem, defaultNext, trimmed || undefined);
                  }}
                >
                  <input
                    type="text"
                    className="obi-tray-input"
                    value={inputValue}
                    placeholder={copy.inputPlaceholder}
                    onChange={(event) => setInputValue(event.target.value)}
                  />
                  <button
                    type="submit"
                    className={`obi-send-btn obi-send--${selectedItem.tone}`}
                    aria-label={copy.sendAria}
                  >
                    ↑
                  </button>
                </form>
              </div>
            ) : null}
          </div>

          {toast ? <div className="obi-toast" role="status">✦ {toast}</div> : null}
        </div>
      </div>
      <p className="tfi-body">
        {copy.bodyPre}
        <strong>{copy.bodyEm1}</strong>
        {copy.bodyMid}
        <strong>{copy.bodyEm2}</strong>
        {copy.bodyPost}
      </p>
    </>
  );
}

/** 카드 아래 줄 왼쪽의 '목표 열기' — 카드를 닫고 목표 보드를 연다. */
export function ObjectivesBoardIntroLink({ onLeave }: FeatureCardLinkProps): React.JSX.Element {
  const copy = boardCopy(useConsoleLocale());
  const goBoard = (): void => {
    onLeave();
    openCommandBoard();
  };
  return (
    <button type="button" className="tfi-link" onClick={goBoard}>
      {copy.link} <span aria-hidden="true">→</span>
    </button>
  );
}
