import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingEntryHint } from "@fleet-console/sdk/onboarding";
import { ONBOARDING_TOUR_LAYER_SELECTOR } from "@fleet-console/sdk/onboarding/anchors";

import { onboardingT } from "./i18n.js";
import { rememberSeen } from "./seen-store.js";
import { visibleModals } from "./tour-overlay.js";

/**
 * 엔트리 힌트 — 아직 열어 본 적 없는 레일 진입점 옆에 한 번 서는 말풍선.
 *
 * 투어와는 다른 층이다: 투어는 사용자가 연 화면 안의 컨트롤을 차례로 짚고, 힌트는 그 화면으로 들어가는 문이 "여기 있다"는
 * 것만 알린다. 화면을 가리지 않고, 모달이나 투어가 떠 있는 동안에는 물러나 있다가 다시 선다.
 * 닫기·열어 보기, 또는 사용자가 어떤 경로로든 그 진입점을 연 순간 본 것으로 영속된다 — 이미 찾은 문을 다시 가리키면 소음이다.
 */
export interface EntryHintCandidate {
  readonly seenKey: string;
  readonly hint: OnboardingEntryHint;
}

export interface EntryHintPorts {
  /** 레일 진입점 버튼. 없으면(플러그인 미설치·Theater 없음 등) 힌트는 서지 않는다. */
  readonly railEntryElement: (railEntryId: string) => HTMLElement | null;
  readonly shortcutLabel: (commandId: string) => string;
}

// 조건이 이만큼 이어져야 선다 — 부팅 직후 What's New·웰컴 카드가 뜨기 전 틈에 잠깐 번쩍이지 않게 한다.
const SETTLE_MS = 1200;
const POLL_MS = 400;

type Placement = { readonly top: number; readonly right: number };

/** 지금 가리킬 수 있는 첫 힌트. 등록 순서(코어 먼저)를 따르고, 문이 보이지 않는 힌트는 건너뛴다. */
export function findShowableHint(candidates: readonly EntryHintCandidate[], seen: readonly string[], ports: EntryHintPorts): EntryHintCandidate | null {
  for (const candidate of candidates) {
    if (seen.includes(candidate.seenKey)) continue;
    const target = ports.railEntryElement(candidate.hint.railEntryId);
    if (target && isHintTargetVisible(target)) return candidate;
  }
  return null;
}

export function EntryHints({ candidates, seen, language, ports, held }: {
  readonly candidates: readonly EntryHintCandidate[];
  readonly seen: readonly string[] | null;
  readonly language: ConsoleLocale;
  readonly ports: EntryHintPorts;
  /** 앞 단계(웰컴)가 아직 끝나지 않았다 — 힌트는 서지 않고 기다린다. */
  readonly held: boolean;
}) {
  const [active, setActive] = useState<EntryHintCandidate | null>(null);
  useEffect(() => {
    if (!seen) return;
    const tick = () => {
      // 사용자가 스스로 연 문에는 가리킬 것이 남지 않는다 — 말풍선을 거친 적이 없어도 본 것으로 친다.
      const opened = candidates.filter((candidate) => !seen.includes(candidate.seenKey)
        && ports.railEntryElement(candidate.hint.railEntryId)?.getAttribute("aria-pressed") === "true");
      if (opened.length > 0) rememberSeen(opened.map((candidate) => candidate.seenKey));
      const next = held ? null : findShowableHint(candidates.filter((candidate) => !opened.includes(candidate)), seen, ports);
      setActive((current) => (current?.seenKey === next?.seenKey ? current : next));
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [candidates, held, ports, seen]);

  return active ? <EntryHintBubble key={active.seenKey} candidate={active} language={language} ports={ports} /> : null;
}

function EntryHintBubble({ candidate, language, ports }: {
  readonly candidate: EntryHintCandidate;
  readonly language: ConsoleLocale;
  readonly ports: EntryHintPorts;
}) {
  const t = onboardingT(language);
  const { hint } = candidate;
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const readySinceRef = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const dismiss = () => {
    setDismissed(true);
    rememberSeen([candidate.seenKey]);
  };

  useEffect(() => {
    if (dismissed) return;
    const tick = () => {
      const icon = ports.railEntryElement(hint.railEntryId);
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
  }, [dismissed, hint.railEntryId, ports]);

  // 말풍선이 뷰포트 끝을 넘으면 안쪽으로 끌어오고, 꼬리는 그만큼 거꾸로 옮겨 여전히 아이콘 가운데를 가리킨다.
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
  const shortcut = hint.shortcutCommandId ? ports.shortcutLabel(hint.shortcutCommandId) : "";
  const open = () => {
    dismiss();
    ports.railEntryElement(hint.railEntryId)?.click();
  };
  const style = { top: placement.top + lift, right: placement.right, "--onboarding-hint-arrow-shift": `${-lift}px` } as CSSProperties;

  return (
    <div
      ref={bubbleRef}
      className="onboarding-hint"
      role="status"
      aria-live="polite"
      data-onboarding-hint={hint.railEntryId}
      style={style}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}
    >
      <div className="onboarding-hint-head">
        <span className="onboarding-hint-title">{resolveLocalizedText(hint.title, language)}</span>
        <button type="button" className="onboarding-hint-close" onClick={dismiss} aria-label={t("hint.dismiss")}>×</button>
      </div>
      <p className="onboarding-hint-body">{resolveLocalizedText(hint.body, language)}</p>
      <div className="onboarding-hint-foot">
        {shortcut ? <kbd className="onboarding-hint-kbd">{t("hint.shortcut", { shortcut })}</kbd> : <span />}
        <button type="button" className="onboarding-hint-open" onClick={open}>{t("hint.open")}</button>
      </div>
    </div>
  );
}

function isHintTargetVisible(icon: HTMLElement): boolean {
  if (icon.closest("[hidden], [inert]")) return false;
  if ((icon as HTMLButtonElement).disabled) return false;
  if (icon.getAttribute("aria-pressed") === "true") return false;
  const style = getComputedStyle(icon);
  if (style.visibility !== "visible" || style.display === "none") return false;
  const rect = icon.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
}

// 앞 단계와 다른 안내가 먼저다 — 모달(What's New·웰컴 카드·설정 가이드)이나 투어가 떠 있으면 물러난다.
function isAnotherGuideShowing(root: Document, self: HTMLElement | null): boolean {
  if (root.querySelector(ONBOARDING_TOUR_LAYER_SELECTOR)) return true;
  return visibleModals(root).some((modal) => !self?.contains(modal));
}
