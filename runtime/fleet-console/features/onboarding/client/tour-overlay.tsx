import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingTour, OnboardingTourStep } from "@fleet-console/sdk/onboarding";
import { ONBOARDING_BOUNDARY_ATTRIBUTE, ONBOARDING_BOUNDARY_SELECTOR, ONBOARDING_TOUR_LAYER_ATTRIBUTE, ONBOARDING_WORK_SURFACE_SELECTOR } from "@fleet-console/sdk/onboarding/anchors";

import { setGlobalSettingsField, useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { isGlobalBrowserOpen, subscribeGlobalBrowserOpen } from "../../browser/client/global-browser-store.js";
import { onboardingT } from "./i18n.js";
import { appendSeen, persistSeen, tourSeenKey, type TourPhase } from "./seen-store.js";
import { resolveTourCardPosition, type TourCardPosition } from "./tour-placement.js";

interface TourPresentation {
  readonly tour: OnboardingTour;
  readonly phase: TourPhase;
  readonly steps: readonly OnboardingTourStep[];
}

interface LockedTour {
  readonly tourId: string;
  readonly phase: TourPhase;
}

interface CompletedTour {
  readonly tourId: string;
  /** 끝낸 순간 열려 있던 작업 표면 — 이 집합이 달라지면 사용자가 그 화면을 떠난 것이다. */
  readonly surfaces: readonly HTMLElement[];
}

/**
 * 투어 오버레이 — 기여들이 등록한 투어를 등록 순서(코어 먼저)로 훑어, 앵커가 화면에 선 첫 투어를 재생한다.
 *
 * blocked는 엔진의 앞 단계(엔트리 힌트)가 아직 남았다는 뜻이다. 막혀 있는 동안에는 새 투어를 시작하지 않고,
 * 이미 재생 중인 투어는 끊지 않는다.
 */
export function TourOverlay({ tours, language, blocked, suspended = false }: {
  readonly tours: readonly OnboardingTour[];
  readonly language: ConsoleLocale;
  readonly blocked: () => boolean;
  readonly suspended?: boolean;
}) {
  const settings = useGlobalSettingsStore();
  const t = onboardingT(language);
  const [lockedTour, setLockedTour] = useState<LockedTour | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [domRevision, setDomRevision] = useState(0);
  const [position, setPosition] = useState<TourCardPosition>({ left: 0, top: 0, centered: true });
  const cardRef = useRef<HTMLElement | null>(null);
  // 마지막으로 끝낸 투어와 끝낸 순간의 화면 — deferAfterAnotherTour가 붙은 투어는 그 화면을 떠나기 전까지 시작하지 않는다.
  // 오버레이는 라우트 밖에 한 번만 마운트되므로 "이 마운트에서 끝냈다"로 재면 미뤄둔 안내가 새로고침 전까지 영영 뜨지 않는다.
  // 앵커가 사라지는 것만으로 떠남을 재도 같다 — 모드 스위치처럼 화면에 상주하는 앵커는 사라지지 않는다. 그래서 작업 표면이
  // 열리거나 닫히는 전이도 떠남으로 친다.
  const completedTourRef = useRef<CompletedTour | null>(null);
  const seen = settings.state?.seenFeatureTours ?? [];

  useEffect(() => {
    const refresh = () => setDomRevision((revision) => revision + 1);
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden", "aria-modal", "aria-pressed", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    // 앵커를 품은 표면이 열리며 미끄러져 들어오는 동안(레일 패널·확대 표면의 전환) 잰 자리는 전환이 끝나면 틀린다.
    // 전환은 DOM 변경도 창 크기 변화도 아니어서 위 신호로는 다시 재지 않으므로, 전환이 끝난 순간 한 번 더 잰다.
    window.addEventListener("transitionend", refresh, true);
    window.addEventListener("animationend", refresh, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("transitionend", refresh, true);
      window.removeEventListener("animationend", refresh, true);
    };
  }, []);

  // 시청 기록이 줄어드는 유일한 경로는 사용자가 "화면 안내 다시 보기"를 부른 것이다. 그때는 완료 표시도 함께 풀어야
  // 미뤄둔 투어까지 요청한 자리에서 재생된다.
  const seenCountRef = useRef(seen.length);
  useEffect(() => {
    if (seen.length < seenCountRef.current) completedTourRef.current = null;
    seenCountRef.current = seen.length;
  }, [seen.length]);

  // 끝낸 투어의 화면을 떠난 순간 완료 표시를 푼다 — 그래야 미뤄둔 안내가 "다음 방문"에 뜬다.
  useEffect(() => {
    if (completedTourRef.current === null) return;
    if (!isCompletedTourScreenVisible(completedTourRef.current, tours, document)) completedTourRef.current = null;
  }, [domRevision, tours]);

  // 전역 Fleet 브라우저 시트가 열려 있으면 Operation 브라우저 투어는 미룬다 —
  // 짚는 캡션 지구본이 시트 아래에 가려져 보인다 해도 누를 수 없다. 닫히면 다음 판정에서 다시 선다.
  const globalSheetOpen = useSyncExternalStore(subscribeGlobalBrowserOpen, () => isGlobalBrowserOpen(), () => false);

  const resolved = useMemo(() => {
    if (suspended || domRevision === 0 || !settings.state) return null;
    const nextTour = () => blocked()
      ? null
      : resolveNextTour(tours, seen, document, isCompletedTourScreenVisible(completedTourRef.current, tours, document));
    if (lockedTour) {
      const tour = tours.find((entry) => entry.id === lockedTour.tourId);
      if (!tour || seen.includes(tourSeenKey(tour.id, lockedTour.phase))) return null;
      // 존재를 알리던 스포트라이트는 사용자가 그 기능의 화면에 들어온 순간 할 일을 다 했다. 그대로 두면 카드가 칩 아래에
      // 떠 그 화면의 컨트롤을 덮으므로, 같은 투어의 워크스루로 넘겨 안내를 화면 안의 카드 곁으로 옮긴다.
      if (lockedTour.phase === "spotlight" && !seen.includes(tourSeenKey(tour.id, "walkthrough"))) {
        const walkthrough = resolveWalkthrough(tour, document);
        if (walkthrough) return walkthrough;
      }
      const steps = lockedTour.phase === "spotlight"
        ? tour.spotlight && resolveAnchor(tour.spotlight, document) ? [tour.spotlight] : []
        : availableSteps(tour.walkthrough, document);
      if (steps.length === 0) {
        // 표면이 닫혀 물러난 워크스루는 다른 투어에 양보한다 — 잠금을 쥐고 있으면 사용자가 새로 연 표면의 안내가 시작하지
        // 못한다. 양보할 투어가 없으면 잠금과 스텝 위치를 그대로 두어 표면이 다시 열리면 이어진다.
        if (lockedTour.phase === "spotlight") return null;
        const next = nextTour();
        return next && next.tour.id !== tour.id ? next : null;
      }
      // 재생 중에도 발동과 같은 기준으로 다시 잰다 — 안내가 걸린 표면 위로 다른 모달이 열리면 물러난다.
      const anchor = resolveAnchor(steps[0]!, document);
      if (isBlockedByModal(document, anchor)) return null;
      if (lockedTour.phase === "spotlight" && anchor && isBlockedByWorkSurface(document, anchor)) return null;
      if (tour.id === "operation-browser" && globalSheetOpen) return null;
      return { tour, phase: lockedTour.phase, steps } satisfies TourPresentation;
    }
    const next = nextTour();
    if (next && next.tour.id === "operation-browser" && globalSheetOpen) return null;
    return next;
  }, [blocked, domRevision, globalSheetOpen, lockedTour, seen, settings.state, tours, suspended]);

  // 작업 표면에 물러난 스포트라이트는 잠금을 놓는다. 쥐고 있으면 사용자가 연 그 표면 안의 워크스루가 시작하지 못한다.
  // 시청 기록은 그대로라 표면이 닫히면 다음 판정에서 다시 선다.
  useEffect(() => {
    if (lockedTour?.phase !== "spotlight") return;
    const spotlight = tours.find((entry) => entry.id === lockedTour.tourId)?.spotlight;
    const anchor = spotlight ? resolveAnchor(spotlight, document) : null;
    if (anchor && isBlockedByWorkSurface(document, anchor)) setLockedTour(null);
  }, [domRevision, lockedTour, tours]);

  useEffect(() => {
    if (!resolved || (lockedTour?.tourId === resolved.tour.id && lockedTour.phase === resolved.phase)) return;
    setLockedTour({ tourId: resolved.tour.id, phase: resolved.phase });
    setStepIndex(0);
  }, [lockedTour, resolved]);

  // 재생 중에 스텝이 줄면 진행 위치가 범위를 넘을 수 있다. 보이는 스텝과 진행 표시는 같은 위치를 쓴다 — 따로 읽으면 "3 / 1"로 샌다.
  const currentIndex = resolved ? Math.min(stepIndex, Math.max(0, resolved.steps.length - 1)) : 0;
  const currentStep = resolved?.steps[currentIndex] ?? null;
  const anchor = currentStep ? resolveAnchor(currentStep, document) : null;

  // 스크롤되는 표면 안에서는 앵커가 보이는 영역 밖에 있을 수 있다. 스텝이 바뀐 순간 한 번만 가장 가까운 보이는 위치로
  // 끌어온다. 자리 재기처럼 스크롤마다 다시 부르면 사용자가 굴린 화면을 매번 앵커로 되돌려, 앵커 밖의 컨트롤에는
  // 스크롤로 닿을 수 없게 된다. nearest는 이미 보이는 앵커에는 아무 일도 하지 않는다.
  useLayoutEffect(() => {
    anchor?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [anchor, currentStep]);

  useLayoutEffect(() => {
    if (!currentStep) return;
    if (!anchor) {
      setPosition({ left: window.innerWidth / 2, top: window.innerHeight / 2, centered: true });
      return;
    }
    anchor.classList.add("is-feature-tour-anchor");
    const boundary = anchor.closest<HTMLElement>(ONBOARDING_BOUNDARY_SELECTOR);
    // 카드 크기는 레이아웃 크기로 잰다 — 변형이 걸린 순간에도 흔들리지 않는다.
    const card = cardRef.current;
    setPosition(resolveTourCardPosition({
      anchor: anchor.getBoundingClientRect(),
      boundary: boundary?.getBoundingClientRect() ?? null,
      alignToAnchor: boundary?.getAttribute(ONBOARDING_BOUNDARY_ATTRIBUTE) === "anchor",
      cardWidth: card?.offsetWidth ?? 320,
      cardHeight: card?.offsetHeight ?? 180,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
    return () => anchor.classList.remove("is-feature-tour-anchor");
  }, [anchor, currentStep, domRevision]);

  const finish = useCallback(async () => {
    if (!resolved) return;
    const key = tourSeenKey(resolved.tour.id, resolved.phase);
    // 워크스루를 끝내면 같은 투어의 스포트라이트도 본 것이다 — 다 익힌 사람에게 존재 알림이 뒤늦게 서지 않게.
    const base = resolved.phase === "walkthrough" && resolved.tour.spotlight
      ? appendSeen(seen, tourSeenKey(resolved.tour.id, "spotlight"))
      : seen;
    completedTourRef.current = { tourId: resolved.tour.id, surfaces: visibleWorkSurfaces(document) };
    setStepIndex(0);
    // 시청 기록 저장이 끝나기 전에 락을 풀면 뒤따르는 투어가 같은 필드에 대한 동시 저장을 시작해, 뒤쪽 저장이
    // 같은-필드 가드에 밀려나 '사용자당 1회' 기록이 유실된다. 저장을 먼저 마치고 락을 푼다.
    await persistSeen(base, key, (next) => setGlobalSettingsField("seenFeatureTours", next));
    setLockedTour(null);
  }, [resolved, seen]);

  if (!resolved || !currentStep) return null;
  const lastStep = currentIndex >= resolved.steps.length - 1;
  const cardStyle = position.centered ? undefined : { left: position.left, top: position.top } as CSSProperties;

  return (
    <div
      className={`feature-tour-layer is-${resolved.phase} ${position.centered ? "is-centered" : ""}`}
      {...{ [ONBOARDING_TOUR_LAYER_ATTRIBUTE]: "" }}
      data-feature-tour-id={resolved.tour.id}
      data-feature-tour-phase={resolved.phase}
    >
      <section aria-labelledby="feature-tour-title" className="feature-tour-card" ref={cardRef} role="dialog" style={cardStyle}>
        {resolved.phase === "walkthrough"
          ? <span className="feature-tour-progress">{t("tour.progress", { current: currentIndex + 1, total: resolved.steps.length })}</span>
          : null}
        <h2 id="feature-tour-title">{resolveLocalizedText(currentStep.title, language)}</h2>
        <p>{resolveLocalizedText(currentStep.body, language)}</p>
        {currentStep.example ? (
          <p className="feature-tour-example">
            <span className="feature-tour-example-lead">{t("tour.exampleLead")}</span>
            <em>{resolveLocalizedText(currentStep.example, language)}</em>
          </p>
        ) : null}
        <div className="feature-tour-actions">
          <button className="feature-tour-skip" onClick={() => void finish()} type="button">{t("tour.skip")}</button>
          {resolved.phase === "spotlight"
            ? <button className="feature-tour-primary" onClick={() => void finish()} type="button">{t("tour.gotIt")}</button>
            : (
                <button
                  className="feature-tour-primary"
                  onClick={() => {
                    if (lastStep) void finish();
                    else setStepIndex((index) => advanceTourStep(index, resolved.steps.length));
                  }}
                  type="button"
                >
                  {t(lastStep ? "tour.done" : "tour.next")}
                </button>
              )}
        </div>
      </section>
    </div>
  );
}

// 다음 스텝은 마지막 스텝을 넘지 않는다 — 진행 버튼의 '마지막인가' 판정은 렌더 시점 값이라, 리렌더 전에 두 번 눌리면
// 두 번 다 '마지막이 아니다'로 읽혀 진행 표시가 "4 / 3"으로 새어 나간다.
function advanceTourStep(index: number, total: number): number {
  return Math.min(index + 1, Math.max(0, total - 1));
}

// 앵커 없는 스텝은 투어의 표면 위에 얹힌 설명이다. 앵커가 선 스텝이 하나도 남지 않았다면 표면이 닫힌 것이므로 함께
// 물러난다 — 남겨 두면 재생 중에 패널을 닫았을 때 설명 카드만 화면 가운데에 떠 남는다. 잠금과 스텝 위치는 그대로라
// 표면이 다시 열리면 닫힌 스텝에서 이어진다.
function availableSteps(steps: readonly OnboardingTourStep[], root: ParentNode): readonly OnboardingTourStep[] {
  const available = steps.filter((step) => step.anchor === null || root.querySelector(step.anchor) !== null);
  return available.some((step) => step.anchor !== null) ? available : [];
}

function resolveNextTour(
  tours: readonly OnboardingTour[],
  seen: readonly string[],
  root: ParentNode,
  completedAnotherTour: boolean,
): TourPresentation | null {
  for (const tour of tours) {
    if (seen.includes(tourSeenKey(tour.id, "walkthrough"))) continue;
    if (tour.deferAfterAnotherTour === true && completedAnotherTour) continue;
    const walkthrough = resolveWalkthrough(tour, root);
    if (walkthrough) return walkthrough;
  }
  // 스포트라이트는 방금 다른 투어를 끝낸 화면에서는 뜨지 않는다 — 한 스텝짜리 곁가지가 방금 끝낸 안내 뒤에 바로 붙으면
  // 사용자에게는 스텝을 합친 것과 다르지 않다. 끝낸 투어의 화면을 떠나면 다음 방문에 제 순서로 뜬다.
  if (completedAnotherTour) return null;
  for (const tour of tours) {
    if (!tour.spotlight || seen.includes(tourSeenKey(tour.id, "spotlight"))) continue;
    const anchor = resolveAnchor(tour.spotlight, root);
    if (anchor !== null && !isBlockedByModal(root, anchor) && !isBlockedByWorkSurface(root, anchor)) return { tour, phase: "spotlight", steps: [tour.spotlight] };
  }
  return null;
}

// 워크스루는 첫 앵커가 선 스텝(활성 앵커)이 화면에 있고 모달에 가려지지 않았을 때만 시작한다.
function resolveWalkthrough(tour: OnboardingTour, root: ParentNode): TourPresentation | null {
  const activationStep = tour.walkthrough.find((step) => step.anchor !== null);
  if (!activationStep?.anchor) return null;
  const activationAnchor = root.querySelector(activationStep.anchor);
  if (activationAnchor === null || isBlockedByModal(root, activationAnchor)) return null;
  const steps = availableSteps(tour.walkthrough, root);
  return steps.length > 0 ? { tour, phase: "walkthrough", steps } : null;
}

// 방금 끝낸 투어의 화면에 아직 머물러 있는가 — 미뤄둔 투어가 같은 방문에서 이어 재생되는 것만 막는다.
// 활성 앵커가 사라졌거나 끝낸 뒤 작업 표면이 열리거나 닫혔으면 떠난 것이다.
function isCompletedTourScreenVisible(completed: CompletedTour | null, tours: readonly OnboardingTour[], root: ParentNode): boolean {
  if (completed === null) return false;
  const tour = tours.find((entry) => entry.id === completed.tourId);
  if (!tour) return false;
  const activation = tour.walkthrough.find((step) => step.anchor !== null)?.anchor ?? tour.spotlight?.anchor ?? null;
  if (activation === null || root.querySelector(activation) === null) return false;
  const surfaces = visibleWorkSurfaces(root);
  return surfaces.length === completed.surfaces.length && surfaces.every((surface) => completed.surfaces.includes(surface));
}

function resolveAnchor(step: OnboardingTourStep, root: ParentNode): HTMLElement | null {
  return step.anchor === null ? null : root.querySelector<HTMLElement>(step.anchor);
}

export function visibleModals(root: ParentNode): readonly HTMLElement[] {
  return visibleElements(root, '[aria-modal="true"]');
}

function visibleElements(root: ParentNode, selector: string): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

// 스포트라이트는 사용자가 열어 둔 작업 표면(레일 패널 등) 바깥을 가리키는 동안 물러난다. 칩 아래에 매달린 카드가 그
// 표면의 컨트롤을 덮기 때문이다. 시청 기록은 남기지 않으므로 표면이 닫히면 다시 선다.
function isBlockedByWorkSurface(root: ParentNode, anchor: Element): boolean {
  return visibleWorkSurfaces(root).some((surface) => !surface.contains(anchor));
}

function visibleWorkSurfaces(root: ParentNode): readonly HTMLElement[] {
  return visibleElements(root, ONBOARDING_WORK_SURFACE_SELECTOR);
}

// 열려 있는 모달은 안내를 막는다. 다만 그 모달 안의 컨트롤을 짚는 안내까지 막지는 않는다 — 사용자가 직접 연 표면에서
// 그 표면의 컨트롤을 가리키는 것은 안내가 가장 잘 닿는 순간이다.
function isBlockedByModal(root: ParentNode, anchor: Element | null): boolean {
  return visibleModals(root).some((modal) => anchor === null || !modal.contains(anchor));
}
