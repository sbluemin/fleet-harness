import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { FEATURE_TOURS, type FeatureTour, type FeatureTourStep } from "../feature-tour-catalog.js";
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
    return resolveNextFeatureTour(FEATURE_TOURS, seen, document);
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
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const card = cardRef.current?.getBoundingClientRect();
      const cardWidth = card?.width ?? 320;
      const cardHeight = card?.height ?? 180;
      const gap = 12;
      const margin = 12;
      const below = rect.bottom + gap;
      const top = below + cardHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, rect.top - cardHeight - gap);
      const left = Math.min(
        window.innerWidth - cardWidth - margin,
        Math.max(margin, rect.left + rect.width / 2 - cardWidth / 2),
      );
      setPosition({ left, top, centered: false });
    };
    updatePosition();
    return () => anchor.classList.remove("is-feature-tour-anchor");
  }, [anchor, currentStep, domRevision]);

  const finish = useCallback(async () => {
    if (!resolved) return;
    const key = featureTourSeenKey(resolved.tour.id, resolved.phase);
    const completionBase = resolved.phase === "walkthrough"
      ? appendSeenFeatureTour(seen, featureTourSeenKey(resolved.tour.id, "spotlight"))
      : seen;
    setLockedTour(null);
    setStepIndex(0);
    await persistFeatureTourSeen(completionBase, key, (next) => setGlobalSettingsField("seenFeatureTours", next));
  }, [resolved, seen]);

  if (!resolved || !currentStep) return null;
  const lastStep = stepIndex >= resolved.steps.length - 1;
  const cardStyle = position.centered
    ? undefined
    : { left: position.left, top: position.top } as CSSProperties;

  return (
    <div
      className={`feature-tour-layer is-${resolved.phase} ${position.centered ? "is-centered" : ""}`}
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
                      setStepIndex((index) => index + 1);
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
): FeatureTourPresentation | null {
  if (hasVisibleModal(root)) return null;
  for (const tour of tours) {
    if (seen.includes(featureTourSeenKey(tour.id, "walkthrough"))) continue;
    const activationStep = tour.walkthrough.find((step) => step.anchor !== null);
    if (!activationStep?.anchor || root.querySelector(activationStep.anchor) === null) continue;
    const steps = availableFeatureTourSteps(tour.walkthrough, root);
    if (steps.length > 0) return { tour, phase: "walkthrough", steps };
  }
  for (const tour of tours) {
    if (!tour.spotlight || seen.includes(featureTourSeenKey(tour.id, "spotlight"))) continue;
    if (resolveFeatureTourAnchor(tour.spotlight, root)) {
      return { tour, phase: "spotlight", steps: [tour.spotlight] };
    }
  }
  return null;
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
