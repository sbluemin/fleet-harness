import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingTour, OnboardingTourStep } from "@fleet-console/sdk/onboarding";
import { ONBOARDING_BOUNDARY_ATTRIBUTE, ONBOARDING_BOUNDARY_SELECTOR, ONBOARDING_TOUR_LAYER_ATTRIBUTE } from "@fleet-console/sdk/onboarding/anchors";

import { setGlobalSettingsField, useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
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

/**
 * 투어 오버레이 — 기여들이 등록한 투어를 등록 순서(코어 먼저)로 훑어, 앵커가 화면에 선 첫 투어를 재생한다.
 *
 * blocked는 엔진의 앞 단계(엔트리 힌트)가 아직 남았다는 뜻이다. 막혀 있는 동안에는 새 투어를 시작하지 않고,
 * 이미 재생 중인 투어는 끊지 않는다.
 */
export function TourOverlay({ tours, language, blocked }: {
  readonly tours: readonly OnboardingTour[];
  readonly language: ConsoleLocale;
  readonly blocked: () => boolean;
}) {
  const settings = useGlobalSettingsStore();
  const t = onboardingT(language);
  const [lockedTour, setLockedTour] = useState<LockedTour | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [domRevision, setDomRevision] = useState(0);
  const [position, setPosition] = useState<TourCardPosition>({ left: 0, top: 0, centered: true });
  const cardRef = useRef<HTMLElement | null>(null);
  // 마지막으로 끝낸 투어 — deferAfterAnotherTour가 붙은 투어는 그 투어의 화면을 떠나기 전까지 시작하지 않는다.
  // 오버레이는 라우트 밖에 한 번만 마운트되므로 "이 마운트에서 끝냈다"로 재면 화면을 몇 번 오가도 값이 그대로라
  // 미뤄둔 안내가 새로고침 전까지 영영 뜨지 않는다.
  const completedTourIdRef = useRef<string | null>(null);
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
    if (seen.length < seenCountRef.current) completedTourIdRef.current = null;
    seenCountRef.current = seen.length;
  }, [seen.length]);

  // 끝낸 투어의 화면을 떠난 순간 완료 표시를 푼다 — 그래야 미뤄둔 안내가 "다음 방문"에 뜬다.
  useEffect(() => {
    if (completedTourIdRef.current === null) return;
    if (!isCompletedTourScreenVisible(completedTourIdRef.current, tours, document)) completedTourIdRef.current = null;
  }, [domRevision, tours]);

  const resolved = useMemo(() => {
    if (domRevision === 0 || !settings.state) return null;
    if (lockedTour) {
      const tour = tours.find((entry) => entry.id === lockedTour.tourId);
      if (!tour || seen.includes(tourSeenKey(tour.id, lockedTour.phase))) return null;
      const steps = lockedTour.phase === "spotlight"
        ? tour.spotlight && resolveAnchor(tour.spotlight, document) ? [tour.spotlight] : []
        : availableSteps(tour.walkthrough, document);
      if (steps.length === 0) return null;
      // 재생 중에도 발동과 같은 기준으로 다시 잰다 — 안내가 걸린 표면 위로 다른 모달이 열리면 물러난다.
      if (isBlockedByModal(document, resolveAnchor(steps[0]!, document))) return null;
      return { tour, phase: lockedTour.phase, steps } satisfies TourPresentation;
    }
    if (blocked()) return null;
    return resolveNextTour(tours, seen, document, isCompletedTourScreenVisible(completedTourIdRef.current, tours, document));
  }, [blocked, domRevision, lockedTour, seen, settings.state, tours]);

  useEffect(() => {
    if (lockedTour || !resolved) return;
    setLockedTour({ tourId: resolved.tour.id, phase: resolved.phase });
    setStepIndex(0);
  }, [lockedTour, resolved]);

  const currentStep = resolved?.steps[Math.min(stepIndex, Math.max(0, resolved.steps.length - 1))] ?? null;
  const anchor = currentStep ? resolveAnchor(currentStep, document) : null;

  useLayoutEffect(() => {
    if (!currentStep) return;
    if (!anchor) {
      setPosition({ left: window.innerWidth / 2, top: window.innerHeight / 2, centered: true });
      return;
    }
    anchor.classList.add("is-feature-tour-anchor");
    // 스크롤되는 표면 안에서는 앵커가 보이는 영역 밖에 있을 수 있다. 카드 자리를 잡기 전에 가장 가까운 보이는
    // 위치로 끌어온다. nearest는 이미 보이는 앵커에는 아무 일도 하지 않는다.
    anchor.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
    completedTourIdRef.current = resolved.tour.id;
    setStepIndex(0);
    // 시청 기록 저장이 끝나기 전에 락을 풀면 뒤따르는 투어가 같은 필드에 대한 동시 저장을 시작해, 뒤쪽 저장이
    // 같은-필드 가드에 밀려나 '사용자당 1회' 기록이 유실된다. 저장을 먼저 마치고 락을 푼다.
    await persistSeen(base, key, (next) => setGlobalSettingsField("seenFeatureTours", next));
    setLockedTour(null);
  }, [resolved, seen]);

  if (!resolved || !currentStep) return null;
  const lastStep = stepIndex >= resolved.steps.length - 1;
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
          ? <span className="feature-tour-progress">{t("tour.progress", { current: stepIndex + 1, total: resolved.steps.length })}</span>
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

function availableSteps(steps: readonly OnboardingTourStep[], root: ParentNode): readonly OnboardingTourStep[] {
  return steps.filter((step) => step.anchor === null || root.querySelector(step.anchor) !== null);
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
    const activationStep = tour.walkthrough.find((step) => step.anchor !== null);
    if (!activationStep?.anchor) continue;
    const activationAnchor = root.querySelector(activationStep.anchor);
    if (activationAnchor === null || isBlockedByModal(root, activationAnchor)) continue;
    const steps = availableSteps(tour.walkthrough, root);
    if (steps.length > 0) return { tour, phase: "walkthrough", steps };
  }
  // 스포트라이트는 방금 다른 투어를 끝낸 화면에서는 뜨지 않는다 — 한 스텝짜리 곁가지가 방금 끝낸 안내 뒤에 바로 붙으면
  // 사용자에게는 스텝을 합친 것과 다르지 않다. 끝낸 투어의 화면을 떠나면 다음 방문에 제 순서로 뜬다.
  if (completedAnotherTour) return null;
  for (const tour of tours) {
    if (!tour.spotlight || seen.includes(tourSeenKey(tour.id, "spotlight"))) continue;
    const anchor = resolveAnchor(tour.spotlight, root);
    if (anchor !== null && !isBlockedByModal(root, anchor)) return { tour, phase: "spotlight", steps: [tour.spotlight] };
  }
  return null;
}

// 방금 끝낸 투어의 화면에 아직 머물러 있는가 — 미뤄둔 투어가 같은 방문에서 이어 재생되는 것만 막는다.
function isCompletedTourScreenVisible(completedTourId: string | null, tours: readonly OnboardingTour[], root: ParentNode): boolean {
  if (completedTourId === null) return false;
  const completed = tours.find((tour) => tour.id === completedTourId);
  if (!completed) return false;
  const activation = completed.walkthrough.find((step) => step.anchor !== null)?.anchor ?? completed.spotlight?.anchor ?? null;
  return activation !== null && root.querySelector(activation) !== null;
}

function resolveAnchor(step: OnboardingTourStep, root: ParentNode): HTMLElement | null {
  return step.anchor === null ? null : root.querySelector<HTMLElement>(step.anchor);
}

export function visibleModals(root: ParentNode): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

// 열려 있는 모달은 안내를 막는다. 다만 그 모달 안의 컨트롤을 짚는 안내까지 막지는 않는다 — 사용자가 직접 연 표면에서
// 그 표면의 컨트롤을 가리키는 것은 안내가 가장 잘 닿는 순간이다.
function isBlockedByModal(root: ParentNode, anchor: Element | null): boolean {
  return visibleModals(root).some((modal) => anchor === null || !modal.contains(anchor));
}
