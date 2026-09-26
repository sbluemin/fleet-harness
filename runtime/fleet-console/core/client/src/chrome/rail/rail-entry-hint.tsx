import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { useT, type CoreMessageKey } from "../../i18n/index.js";
import { FEATURE_TOUR_LAYER_SELECTOR } from "../../integration/feature-tour-catalog.js";
import { shortcutCommandLabel, useShortcutOverrides } from "../../integration/shortcut-bindings.js";
import { rememberSeenFeatureTour } from "../components/feature-tour.js";

/**
 * 레일 아이콘 옆에 한 번 서는 온보딩 말풍선.
 *
 * 피처 투어와는 다른 층이다: 투어는 사용자가 연 화면 안의 컨트롤을 차례로 짚고, 말풍선은 아직 열어 본
 * 적 없는 레일 진입점이 "여기 있다"는 것만 알린다. 그래서 투어 카탈로그가 아니라 레일이 소유하고,
 * 화면을 가리지 않으며, 다른 안내(모달·소개 카드·투어)가 떠 있는 동안에는 물러나 있다가 다시 선다.
 *
 * 닫기·열어 보기, 또는 사용자가 어떤 경로로든 그 진입점을 연 순간 본 것으로 영속된다 — 이미 찾은 문을
 * 다시 가리키면 안내가 아니라 소음이다.
 */
interface RailEntryHint {
  readonly entryId: string;
  readonly seenKey: string;
  readonly titleKey: CoreMessageKey;
  readonly bodyKey: CoreMessageKey;
  readonly shortcutKey: CoreMessageKey;
  readonly shortcutCommand: string;
}

export const OBJECTIVES_RAIL_HINT_SEEN_KEY = "objectives.rail-hint";

const RAIL_ENTRY_HINTS: readonly RailEntryHint[] = [
  {
    entryId: "objectives",
    seenKey: OBJECTIVES_RAIL_HINT_SEEN_KEY,
    titleKey: "railHint.objectives.title",
    bodyKey: "railHint.objectives.body",
    shortcutKey: "railHint.objectives.shortcut",
    shortcutCommand: "console.toggle-objectives",
  },
];

export const RAIL_ENTRY_HINT_SEEN_KEYS: readonly string[] = RAIL_ENTRY_HINTS.map((hint) => hint.seenKey);

// 조건이 이만큼 이어져야 선다 — 부팅 직후 What's New·소개 카드가 뜨기 전 틈에 잠깐 번쩍이지 않게 한다.
const SETTLE_MS = 1200;
const POLL_MS = 400;

type HintPlacement = { readonly top: number; readonly right: number };

export function RailEntryHints() {
  const settings = useGlobalSettingsStore();
  const seen = settings.state?.seenFeatureTours ?? null;
  const hint = seen ? RAIL_ENTRY_HINTS.find((entry) => !seen.includes(entry.seenKey)) ?? null : null;
  return hint ? <RailEntryHintBubble key={hint.entryId} hint={hint} /> : null;
}

function RailEntryHintBubble({ hint }: { readonly hint: RailEntryHint }) {
  const t = useT();
  useShortcutOverrides();
  const [placement, setPlacement] = useState<HintPlacement | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const readySinceRef = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const dismiss = () => {
    setDismissed(true);
    rememberSeenFeatureTour(hint.seenKey);
  };

  useEffect(() => {
    if (dismissed) return;
    const tick = () => {
      const icon = document.getElementById(`rail-tab-${hint.entryId}`);
      // 진입점을 스스로 연 사용자에게는 가리킬 것이 남지 않는다 — 말풍선을 거친 적이 없어도 본 것으로 친다.
      if (icon?.getAttribute("aria-pressed") === "true") {
        dismiss();
        return;
      }
      const target = icon && isHintTargetVisible(icon) && !isAnotherGuideShowing(document, bubbleRef.current) ? icon : null;
      if (!target) {
        readySinceRef.current = null;
        setPlacement(null);
        return;
      }
      const now = Date.now();
      readySinceRef.current ??= now;
      if (now - readySinceRef.current < SETTLE_MS) return;
      const rect = target.getBoundingClientRect();
      setPlacement((current) => {
        const next = { top: Math.round(rect.top + rect.height / 2), right: Math.round(window.innerWidth - rect.left + 10) };
        return current && current.top === next.top && current.right === next.right ? current : next;
      });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", tick);
    };
    // dismiss는 매 렌더 새로 만들어지지만 같은 일을 한다 — 폴링을 다시 걸 이유가 아니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, hint.entryId]);

  // 말풍선이 뷰포트 아래로 넘치면 위로 끌어올린다 — 레일 아래쪽 아이콘에서도 본문이 잘리지 않게.
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble || !placement) return;
    const half = bubble.offsetHeight / 2;
    const overflowBottom = placement.top + half - (window.innerHeight - 12);
    const overflowTop = 12 - (placement.top - half);
    setLift(overflowBottom > 0 ? -overflowBottom : overflowTop > 0 ? overflowTop : 0);
  }, [placement]);

  if (dismissed || !placement) return null;
  const shortcut = shortcutCommandLabel(hint.shortcutCommand);
  const open = () => {
    dismiss();
    document.getElementById(`rail-tab-${hint.entryId}`)?.click();
  };
  const style = { top: placement.top + lift, right: placement.right, "--rail-hint-arrow-shift": `${-lift}px` } as CSSProperties;

  return (
    <div
      ref={bubbleRef}
      className="rail-entry-hint"
      role="status"
      aria-live="polite"
      data-rail-entry-hint={hint.entryId}
      style={style}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}
    >
      <div className="rail-entry-hint-head">
        <span className="rail-entry-hint-title">{t(hint.titleKey)}</span>
        <button type="button" className="rail-entry-hint-close" onClick={dismiss} aria-label={t("railHint.dismiss")}>×</button>
      </div>
      <p className="rail-entry-hint-body">{t(hint.bodyKey)}</p>
      <div className="rail-entry-hint-foot">
        {shortcut ? <kbd className="rail-entry-hint-kbd">{t(hint.shortcutKey, { shortcut })}</kbd> : <span />}
        <button type="button" className="rail-entry-hint-open" onClick={open}>{t("railHint.open")}</button>
      </div>
    </div>
  );
}

function isHintTargetVisible(icon: HTMLElement): boolean {
  if (icon.closest("[hidden], [inert]")) return false;
  if ((icon as HTMLButtonElement).disabled) return false;
  const style = getComputedStyle(icon);
  if (style.visibility !== "visible" || style.display === "none") return false;
  const rect = icon.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
}

// 다른 안내가 먼저다 — 모달(What's New·소개 카드·설정 가이드)이나 투어가 떠 있으면 물러난다.
function isAnotherGuideShowing(root: Document, self: HTMLElement | null): boolean {
  if (root.querySelector(FEATURE_TOUR_LAYER_SELECTOR)) return true;
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some((modal) => {
    if (self?.contains(modal)) return false;
    if (modal.hidden || modal.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(modal);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}
