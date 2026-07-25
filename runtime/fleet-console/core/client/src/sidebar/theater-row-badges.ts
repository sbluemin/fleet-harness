import { useEffect, useState } from "react";

import type {
  TheaterRowBadge,
  TheaterRowBadgeContribution,
  TheaterRowBadgeTone,
} from "@fleet-console/sdk/plugin";

export const THEATER_ROW_BADGE_REFRESH_MS = 30_000;

const BADGE_TONES = new Set<TheaterRowBadgeTone>(["neutral", "info", "warn", "positive"]);

export function useTheaterRowBadges(
  theaterIds: readonly string[],
  sideBarCollapsed: boolean,
): Readonly<Record<string, readonly TheaterRowBadge[]>> {
  const theaterIdsKey = JSON.stringify(theaterIds);
  const [byTheater, setByTheater] = useState<Readonly<Record<string, readonly TheaterRowBadge[]>>>({});

  useEffect(() => {
    const requestedTheaterIds = parseTheaterIdsKey(theaterIdsKey);
    if (requestedTheaterIds.length === 0) {
      setByTheater({});
      return;
    }
    let active = true;
    let requestController: AbortController | null = null;
    let interval: number | null = null;

    const refresh = async () => {
      if (sideBarCollapsed || document.visibilityState === "hidden") return;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      try {
        const response = await fetch("/api/v1/theaters/row-badges", { signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as unknown;
        if (!active || controller.signal.aborted) return;
        setByTheater(normalizeBadgeResponse(payload, requestedTheaterIds));
      } catch {
        // 재검증 실패 시 직전의 안전한 스냅샷을 유지한다.
      }
    };
    const stopPolling = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const startPolling = () => {
      if (sideBarCollapsed || document.visibilityState === "hidden" || interval !== null) return;
      void refresh();
      interval = window.setInterval(() => void refresh(), THEATER_ROW_BADGE_REFRESH_MS);
    };
    const handleFocus = () => {
      void refresh();
    };
    const handleVisibilityChange = () => {
      stopPolling();
      if (document.visibilityState !== "hidden") startPolling();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();
    return () => {
      active = false;
      requestController?.abort();
      stopPolling();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sideBarCollapsed, theaterIdsKey]);

  return byTheater;
}

export function normalizeBadgeResponse(
  value: unknown,
  theaterIds: readonly string[],
): Readonly<Record<string, readonly TheaterRowBadge[]>> {
  if (!isObject(value) || !Array.isArray(value.theaters)) return {};
  const known = new Set(theaterIds);
  const result: Record<string, TheaterRowBadge[]> = {};
  for (const contribution of value.theaters) {
    const normalized = normalizeContribution(contribution, known);
    if (!normalized) continue;
    result[normalized.theaterId] = [
      ...(result[normalized.theaterId] ?? []),
      ...normalized.badges,
    ];
  }
  return result;
}

function normalizeContribution(
  value: unknown,
  knownTheaterIds: ReadonlySet<string>,
): TheaterRowBadgeContribution | null {
  if (!isObject(value) || typeof value.theaterId !== "string" || !knownTheaterIds.has(value.theaterId) || !Array.isArray(value.badges)) return null;
  const badges = value.badges.flatMap((candidate): TheaterRowBadge[] => {
    if (!isObject(candidate) || typeof candidate.id !== "string" || typeof candidate.text !== "string") return [];
    if (candidate.ariaLabel !== undefined && typeof candidate.ariaLabel !== "string") return [];
    if (candidate.tone !== undefined && (typeof candidate.tone !== "string" || !BADGE_TONES.has(candidate.tone as TheaterRowBadgeTone))) return [];
    return [{
      id: candidate.id,
      text: candidate.text,
      ...(typeof candidate.ariaLabel === "string" ? { ariaLabel: candidate.ariaLabel } : {}),
      ...(typeof candidate.tone === "string" ? { tone: candidate.tone as TheaterRowBadgeTone } : {}),
    }];
  });
  return { theaterId: value.theaterId, badges };
}

function parseTheaterIdsKey(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
