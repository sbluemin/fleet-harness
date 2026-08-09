import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  FEATURE_TOURS,
  FEATURE_TOUR_BOUNDARY_SELECTOR,
  FEATURE_TOUR_LAYER_ATTRIBUTE,
  type FeatureTour,
  type FeatureTourStep,
} from "../feature-tour-catalog.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";

export type FeatureTourPhase = "spotlight" | "walkthrough";

export interface FeatureTourPresentation {
  readonly tour: FeatureTour;
  readonly phase: FeatureTourPhase;
  readonly steps: readonly FeatureTourStep[];
}

interface LockedTour {
  readonly tourId: string;
  readonly phase: FeatureTourPhase;
}

interface CardPosition {
  readonly left: number;
  readonly top: number;
  readonly centered: boolean;
}

export function FeatureTourOverlay() {
  const settings = useGlobalSettingsStore();
  const t = useT();
  const [lockedTour, setLockedTour] = useState<LockedTour | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [domRevision, setDomRevision] = useState(0);
  const [position, setPosition] = useState<CardPosition>({ left: 0, top: 0, centered: true });
  const cardRef = useRef<HTMLElement | null>(null);
  // 마지막으로 끝낸 투어 — deferAfterAnotherTour가 붙은 투어는 그 투어의 화면을 떠나기 전까지
  // 시작하지 않는다. 오버레이는 라우트 밖에 한 번만 마운트되므로(app.tsx) "이 마운트에서 끝냈다"로
  // 재면 화면을 몇 번 오가도 값이 그대로라 미뤄둔 안내가 새로고침 전까지 영영 뜨지 않는다.
  const completedTourIdRef = useRef<string | null>(null);
  const seen = settings.state?.seenFeatureTours ?? [];

  useEffect(() => {
    const refresh = () => setDomRevision((revision) => revision + 1);
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden", "aria-modal", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, []);

  // 시청 기록이 줄어드는 유일한 경로는 사용자가 "화면 안내 다시 보기"를 부른 것이다. 그때는
  // 완료 표시도 함께 풀어야 미뤄둔 투어까지 요청한 자리에서 재생된다.
  const seenCountRef = useRef(seen.length);
  useEffect(() => {
    if (seen.length < seenCountRef.current) completedTourIdRef.current = null;
    seenCountRef.current = seen.length;
  }, [seen.length]);

  // 끝낸 투어의 화면을 떠난 순간 완료 표시를 푼다 — 그래야 미뤄둔 안내가 "다음 방문"에 뜬다.
  useEffect(() => {
    if (completedTourIdRef.current === null) return;
    if (!isCompletedTourScreenVisible(completedTourIdRef.current, FEATURE_TOURS, document)) {
      completedTourIdRef.current = null;
    }
  }, [domRevision]);

  const resolved = useMemo(() => {
    if (domRevision === 0 || !settings.state || hasVisibleModal(document)) return null;
    if (lockedTour) {
      const tour = FEATURE_TOURS.find((entry) => entry.id === lockedTour.tourId);
      if (!tour || seen.includes(featureTourSeenKey(tour.id, lockedTour.phase))) return null;
      const steps = lockedTour.phase === "spotlight"
        ? tour.spotlight && resolveFeatureTourAnchor(tour.spotlight, document) ? [tour.spotlight] : []
        : availableFeatureTourSteps(tour.walkthrough, document);
      return steps.length > 0 ? { tour, phase: lockedTour.phase, steps } satisfies FeatureTourPresentation : null;
    }
    return resolveNextFeatureTour(
      FEATURE_TOURS,
      seen,
      document,
      isCompletedTourScreenVisible(completedTourIdRef.current, FEATURE_TOURS, document),
    );
  }, [domRevision, lockedTour, seen, settings.state]);

  useEffect(() => {
    if (lockedTour || !resolved) return;
    setLockedTour({ tourId: resolved.tour.id, phase: resolved.phase });
    setStepIndex(0);
  }, [lockedTour, resolved]);

  const currentStep = resolved?.steps[Math.min(stepIndex, Math.max(0, resolved.steps.length - 1))] ?? null;
  const anchor = currentStep ? resolveFeatureTourAnchor(currentStep, document) : null;

  useLayoutEffect(() => {
    if (!currentStep) return;
    if (!anchor) {
      setPosition({ left: window.innerWidth / 2, top: window.innerHeight / 2, centered: true });
      return;
    }
    anchor.classList.add("is-feature-tour-anchor");
    // 스크롤되는 메뉴 안에서는 앵커가 보이는 영역 밖에 있을 수 있다. 가리키는 대상이 보이지 않으면
    // 안내가 성립하지 않으므로, 카드 자리를 잡기 전에 가장 가까운 보이는 위치로 끌어온다.
    // nearest는 이미 보이는 앵커에는 아무 일도 하지 않아 평소 배치를 흔들지 않는다.
    anchor.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const updatePosition = () => {
      const boundary = anchor.closest<HTMLElement>(FEATURE_TOUR_BOUNDARY_SELECTOR);
      const card = cardRef.current?.getBoundingClientRect();
      setPosition(resolveFeatureTourCardPosition({
        anchor: anchor.getBoundingClientRect(),
        boundary: boundary?.getBoundingClientRect() ?? null,
        cardWidth: card?.width ?? 320,
        cardHeight: card?.height ?? 180,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }));
    };
    updatePosition();
    return () => anchor.classList.remove("is-feature-tour-anchor");
  }, [anchor, currentStep, domRevision]);

  const finish = useCallback(async () => {
    if (!resolved) return;
    const key = featureTourSeenKey(resolved.tour.id, resolved.phase);
    const completionBase = featureTourCompletionBase(seen, resolved.tour, resolved.phase);
    completedTourIdRef.current = resolved.tour.id;
    setStepIndex(0);
    // 시청 기록 저장이 끝나기 전에 락을 풀면 뒤따르는 투어(예: claude-operations 직후의
    // Classic 폐지 안내)가 같은 seenFeatureTours 필드에 대한 동시 저장을 시작해, 뒤쪽 저장이
    // savingField 가드에 밀려나 '사용자당 1회' 기록이 조용히 유실된다. 저장을 먼저 마치고
    // 락을 풀어 연속 재생되는 투어의 시청 기록이 안전하게 직렬화되도록 한다.
    await persistFeatureTourSeen(completionBase, key, (next) => setGlobalSettingsField("seenFeatureTours", next));
    setLockedTour(null);
  }, [resolved, seen]);

  if (!resolved || !currentStep) return null;
  const lastStep = stepIndex >= resolved.steps.length - 1;
  const cardStyle = position.centered
    ? undefined
    : { left: position.left, top: position.top } as CSSProperties;

  return (
    <div
      className={`feature-tour-layer is-${resolved.phase} ${position.centered ? "is-centered" : ""}`}
      {...{ [FEATURE_TOUR_LAYER_ATTRIBUTE]: "" }}
      data-feature-tour-id={resolved.tour.id}
      data-feature-tour-phase={resolved.phase}
    >
      <section
        aria-labelledby="feature-tour-title"
        className="feature-tour-card"
        ref={cardRef}
        role="dialog"
        style={cardStyle}
      >
        {resolved.phase === "walkthrough"
          ? <span className="feature-tour-progress">{t("featureTour.progress", { current: stepIndex + 1, total: resolved.steps.length })}</span>
          : null}
        <h2 id="feature-tour-title">{t(currentStep.titleKey as CoreMessageKey)}</h2>
        <p>{t(currentStep.bodyKey as CoreMessageKey)}</p>
        <div className="feature-tour-actions">
          <button className="feature-tour-skip" onClick={() => void finish()} type="button">
            {t("featureTour.skip")}
          </button>
          {resolved.phase === "spotlight"
            ? (
                <button className="feature-tour-primary" onClick={() => void finish()} type="button">
                  {t("featureTour.gotIt")}
                </button>
              )
            : (
                <button
                  className="feature-tour-primary"
                  onClick={() => {
                    if (lastStep) {
                      void finish();
                    } else {
                      setStepIndex((index) => advanceFeatureTourStep(index, resolved.steps.length));
                    }
                  }}
                  type="button"
                >
                  {t(lastStep ? "featureTour.done" : "featureTour.next")}
                </button>
              )}
        </div>
      </section>
    </div>
  );
}

export function resolveFeatureTourCardPosition(options: {
  readonly anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">;
  readonly boundary: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> | null;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): CardPosition {
  const { anchor, boundary, cardWidth, cardHeight, viewportWidth, viewportHeight } = options;
  const gap = 12;
  const margin = 12;
  const clampLeft = (left: number) => Math.min(viewportWidth - cardWidth - margin, Math.max(margin, left));
  const clampTop = (top: number) => Math.min(viewportHeight - cardHeight - margin, Math.max(margin, top));
  if (boundary) {
    const centeredTop = clampTop(boundary.top + boundary.height / 2 - cardHeight / 2);
    if (boundary.right + gap + cardWidth <= viewportWidth - margin) {
      return { left: boundary.right + gap, top: centeredTop, centered: false };
    }
    if (boundary.left - gap - cardWidth >= margin) {
      return { left: boundary.left - gap - cardWidth, top: centeredTop, centered: false };
    }
    const centeredLeft = clampLeft(boundary.left + boundary.width / 2 - cardWidth / 2);
    if (boundary.bottom + gap + cardHeight <= viewportHeight - margin) {
      return { left: centeredLeft, top: boundary.bottom + gap, centered: false };
    }
    return { left: centeredLeft, top: Math.max(margin, boundary.top - cardHeight - gap), centered: false };
  }
  const below = anchor.bottom + gap;
  const top = below + cardHeight <= viewportHeight - margin
    ? below
    : Math.max(margin, anchor.top - cardHeight - gap);
  return {
    left: clampLeft(anchor.left + anchor.width / 2 - cardWidth / 2),
    top,
    centered: false,
  };
}

export function featureTourCompletionBase(
  seen: readonly string[],
  tour: FeatureTour,
  phase: FeatureTourPhase,
): readonly string[] {
  return phase === "walkthrough" && tour.spotlight
    ? appendSeenFeatureTour(seen, featureTourSeenKey(tour.id, "spotlight"))
    : seen;
}

// 다음 스텝은 마지막 스텝을 넘지 않는다 — 진행 버튼의 '마지막인가' 판정은 렌더 시점 값이라,
// 리렌더 전에 두 번 눌리면 두 번 다 '마지막이 아니다'로 읽혀 인덱스가 총수를 넘어간다.
// 본문은 어차피 clamp되지만 진행 표시는 그대로 새어 나가 "4 / 3"이 된다.
export function advanceFeatureTourStep(index: number, total: number): number {
  return Math.min(index + 1, Math.max(0, total - 1));
}

export function featureTourSeenKey(tourId: string, phase: FeatureTourPhase): string {
  return `${tourId}.${phase}`;
}

export function appendSeenFeatureTour(seen: readonly string[], key: string): readonly string[] {
  return seen.includes(key) ? seen : [...seen, key].slice(-64);
}

export async function persistFeatureTourSeen(
  seen: readonly string[],
  key: string,
  persist: (next: readonly string[]) => Promise<boolean>,
): Promise<readonly string[]> {
  const next = appendSeenFeatureTour(seen, key);
  if (next === seen) return seen;
  await persist(next);
  return next;
}

export function availableFeatureTourSteps(
  steps: readonly FeatureTourStep[],
  root: ParentNode,
): readonly FeatureTourStep[] {
  return steps.filter((step) => step.anchor === null || root.querySelector(step.anchor) !== null);
}

export function resolveNextFeatureTour(
  tours: readonly FeatureTour[],
  seen: readonly string[],
  root: ParentNode,
  completedAnotherTour = false,
): FeatureTourPresentation | null {
  if (hasVisibleModal(root)) return null;
  for (const tour of tours) {
    if (seen.includes(featureTourSeenKey(tour.id, "walkthrough"))) continue;
    if (tour.deferAfterAnotherTour === true && completedAnotherTour) continue;
    const activationStep = tour.walkthrough.find((step) => step.anchor !== null);
    if (!activationStep?.anchor || root.querySelector(activationStep.anchor) === null) continue;
    const steps = availableFeatureTourSteps(tour.walkthrough, root);
    if (steps.length > 0) return { tour, phase: "walkthrough", steps };
  }
  // 스포트라이트는 방금 다른 투어를 끝낸 마운트에서는 뜨지 않는다. 워크스루의
  // deferAfterAnotherTour와 같은 이유이고, 여기서는 플래그 없이 항상 적용한다 — 스포트라이트는
  // "이런 것도 있다"는 한 스텝짜리 곁가지라, 방금 끝낸 안내 뒤에 바로 붙으면 사용자에게는 스텝을
  // 합친 것과 다르지 않다. 끝낸 투어의 화면을 떠나면 그 다음 방문에 제 순서로 뜬다.
  //
  // 플래그로 만들지 않는 이유: 플래그는 워크스루 루프도 함께 가두므로, 칩 스포트라이트를 미루려고
  // 붙이면 설정 화면의 워크스루까지 같은 마운트에서 사라진다.
  if (completedAnotherTour) return null;
  for (const tour of tours) {
    if (!tour.spotlight || seen.includes(featureTourSeenKey(tour.id, "spotlight"))) continue;
    if (resolveFeatureTourAnchor(tour.spotlight, root)) {
      return { tour, phase: "spotlight", steps: [tour.spotlight] };
    }
  }
  return null;
}

// 방금 끝낸 투어의 화면에 아직 머물러 있는가 — 미뤄둔 투어가 같은 방문에서 이어 재생되는 것만
// 막고, 화면을 떠났다 돌아오면 제 순서에 뜨게 하는 판정이다.
export function isCompletedTourScreenVisible(
  completedTourId: string | null,
  tours: readonly FeatureTour[],
  root: ParentNode,
): boolean {
  if (completedTourId === null) return false;
  const completed = tours.find((tour) => tour.id === completedTourId);
  return completed !== undefined && isFeatureTourAnchored(completed, root);
}

// 투어가 지금 화면에 걸려 있는지 — 발동 판정과 같은 기준(첫 non-null 앵커)을 쓴다.
function isFeatureTourAnchored(tour: FeatureTour, root: ParentNode): boolean {
  const activationAnchor = tour.walkthrough.find((step) => step.anchor !== null)?.anchor
    ?? tour.spotlight?.anchor
    ?? null;
  return activationAnchor !== null && root.querySelector(activationAnchor) !== null;
}

export function forgetSeenFeatureTours(
  seen: readonly string[],
  tourIds: readonly string[],
): readonly string[] {
  const drop = new Set(tourIds.flatMap((id) => [featureTourSeenKey(id, "walkthrough"), featureTourSeenKey(id, "spotlight")]));
  const next = seen.filter((key) => !drop.has(key));
  return next.length === seen.length ? seen : next;
}

// "화면 안내 다시 보기" — 카탈로그 전체 투어의 시청 기록을 지운다. 화면에 닻을 건 투어 하나만
// 되살리던 이전 동작과 달리, 온보딩 전체를 처음부터 다시 보게 하는 것이 버튼의 뜻이다.
export function forgetAllFeatureTours(seen: readonly string[]): readonly string[] {
  return forgetSeenFeatureTours(
    seen,
    FEATURE_TOURS.map((tour) => tour.id),
  );
}

function resolveFeatureTourAnchor(step: FeatureTourStep, root: ParentNode): HTMLElement | null {
  return step.anchor === null ? null : root.querySelector<HTMLElement>(step.anchor);
}

function hasVisibleModal(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}
