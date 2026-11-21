import type { ConsoleLocale, LocalizedText } from "@fleet-console/i18n";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { CommodoreAskCard } from "../../../../features/commodore/client/commodore-ask.js";
import { actionWord, errorWord, failureWord, reasonWord } from "../../../../features/commodore/client/commodore-chat.js";
import { requestCommodoreCreate } from "../../../../features/commodore/client/commodore-create-modal.js";
import { CommodoreDescription, CommodoreIntel, CommodoreSettings } from "../../../../features/commodore/client/commodore-inbox-section.js";
import { MEMORY_BRANCH_LABEL, useCommodoreMemoryTree } from "../../../../features/commodore/client/commodore-memory.js";
import { CommodoreRoutines } from "../../../../features/commodore/client/commodore-routines.js";
import {
  commodoreLanguage,
  commodoreRevision,
  loadCommodore,
  loadCommodoreMemory,
  loadTranscript,
  openAsks,
  readCommodore,
  renameCommodore,
  retryCommodore,
  skipCommodoreFailed,
  stopCommodore,
  subscribeCommodore,
  transcriptNeeded,
  useCommodore,
} from "../../../../features/commodore/client/commodore-state.js";
import { getT as getCommodoreT } from "../../../../features/commodore/client/i18n/index.js";
import type { CommodoreLiveEvent, CommodoreRunStep, CommodoreTranscriptEntry } from "../../../../features/commodore/shared/contracts/types.js";
import { demandGroupTimeline, useGroupTimeline, useGroupTimelines } from "../../../../features/execution/client/agent/chat/group-timeline-store.js";
import { approvalItems, approvalTick, openApprovalList, subscribeApprovals } from "../../../../features/execution/client/approval/store.js";
import type { GroupTimelineEntry } from "../../../../features/execution/shared/conversation/types.js";
import { CommanderRowPanel } from "../../../../features/objectives/client/objectives-panel.js";
import type { ObjectiveClusterSource } from "../../../../features/objectives/shared/objective-clusters.js";
import {
  THE_WORLD_METRICS_PATH,
  type WorldMetricsResponse,
  type WorldTheaterMetrics,
} from "../../../../features/the-world/shared/world-metrics-contract.js";
import type {
  WorldActorConversationState,
  WorldActorPanelMode,
  WorldActorSpec,
  WorldChatFeedEntry,
  WorldMissionItem,
  WorldQuestApprovalSummary,
  WorldQuestAskSummary,
  WorldQuestBoardData,
  WorldQuestMissionSummary,
} from "../../../../features/the-world/shared/world-types.js";
import { getWorldT } from "../../../../features/the-world/client/i18n/index.js";
import { WorldIcon } from "../../../../features/the-world/client/surfaces/world-icons.js";
import { TasksCommanderList } from "../../../../features/workspace/client/commander-tab/commander-tasks-list.js";

/**
 * 코어 조립 계층에서 `features/the-world`로 넘기는 실시간 대화·시스템 로그·인월드 패널 브리지.
 *
 * 사령관(Commodore) 기록·라이브 스트리밍·질문·설정·목표·루틴·기억과
 * 목표(Objective) 그룹 타임라인·보드 패널을 더 월드 안에서 콘솔 이탈 없이 직접 소비할 수 있게 투영한다.
 */

const STEP_LABEL_KO: Record<CommodoreRunStep, string> = {
  think: "생각하는 중...",
  read: "자료 읽는 중...",
  edit: "수정하는 중...",
  run: "명령 실행 중...",
  fetch: "외부 조회 중...",
  delegate: "임무 조율 중...",
  text: "답변 작성 중...",
  compact: "기억 정리 중...",
};

const MAX_GLOBAL_FEED = 180;

function activeLocale(): ConsoleLocale {
  const lang = commodoreLanguage();
  if (lang === "ko" || lang === "en") return lang;
  if (typeof document !== "undefined" && document.documentElement.lang.startsWith("en")) return "en";
  return "ko";
}

function projectCommodoreEntries(
  actor: WorldActorSpec,
  entries: readonly CommodoreTranscriptEntry[],
  live: readonly CommodoreLiveEvent[],
  locale: ConsoleLocale,
): readonly WorldChatFeedEntry[] {
  const t = getCommodoreT(locale);
  const out: WorldChatFeedEntry[] = [];
  const baseActor = {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    actorTone: actor.tone,
  } as const;

  for (const entry of entries) {
    switch (entry.kind) {
      case "wake": {
        const reasons = entry.reasons.map((r) => reasonWord(t, r)).filter(Boolean).join(" · ");
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "system",
          kind: "system-wake",
          ...baseActor,
          badge: "감시자 깨우기",
          text: reasons || "자율 턴 시작",
        });
        break;
      }
      case "message": {
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "player",
          ...baseActor,
          targetName: actor.name,
          text: entry.text,
        });
        break;
      }
      case "text": {
        const trimmed = entry.text.trim();
        if (!trimmed) break;
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "speech",
          ...baseActor,
          text: trimmed,
        });
        break;
      }
      case "sent": {
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "peer",
          ...baseActor,
          targetName: entry.to.alias,
          badge: "사령관 연락",
          text: entry.text,
          failed: !entry.ok,
          ...(entry.error ? { detail: errorWord(t, entry.error) } : {}),
        });
        break;
      }
      case "received": {
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "peer",
          ...baseActor,
          actorName: entry.from.alias,
          targetName: actor.name,
          badge: "수신 전언",
          text: entry.text,
        });
        break;
      }
      case "tool": {
        const actionLabel = entry.action ? actionWord(t, entry.action) : entry.name;
        const targetLabel = entry.title ?? entry.alias ?? entry.summary ?? "";
        const isPlanLike = entry.action === "plan" || entry.action === "commence";
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: isPlanLike ? "system" : "action",
          kind: isPlanLike ? "system-wake" : "action",
          ...baseActor,
          badge: actionLabel,
          text: targetLabel || actionLabel,
          failed: entry.ok === false,
          ...(entry.error ? { detail: errorWord(t, entry.error) } : {}),
        });
        break;
      }
      case "ask": {
        const firstQ = entry.questions[0]?.text ?? "";
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "ask",
          ...baseActor,
          badge: "확인 필요",
          text: firstQ ? `${entry.reason} — ${firstQ}` : entry.reason,
          askId: entry.askId,
        });
        break;
      }
      case "ask-answered": {
        const summary = entry.answers
          .map((a) => [...a.selected, a.text.trim()].filter(Boolean).join(" · "))
          .filter(Boolean)
          .join(" / ");
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "chat",
          kind: "player",
          ...baseActor,
          targetName: actor.name,
          badge: "질문 답변",
          text: summary || "답변 완료",
        });
        break;
      }
      case "result": {
        if (entry.outcome === "error") {
          out.push({
            id: `${actor.id}:seq:${entry.seq}`,
            at: entry.at,
            channel: "system",
            kind: "system-error",
            ...baseActor,
            badge: "턴 오류",
            text: failureWord(t, entry.error, entry.detail),
            failed: true,
          });
        }
        break;
      }
      case "session":
      case "compacted": {
        // 더 월드에서는 턴 원장·비용·세션 생명주기·문맥 압축 같은 내부 원장 기록을 노출하지 않는다.
        break;
      }
      case "error": {
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "system",
          kind: "system-error",
          ...baseActor,
          badge: "시스템 오류",
          text: failureWord(t, entry.code, entry.detail),
          failed: true,
        });
        break;
      }
      case "skipped": {
        out.push({
          id: `${actor.id}:seq:${entry.seq}`,
          at: entry.at,
          channel: "system",
          kind: "system-error",
          ...baseActor,
          badge: "전달 보류",
          text: failureWord(t, entry.code, entry.detail),
          failed: true,
        });
        break;
      }
      default:
        break;
    }
  }

  const lastAt = entries.at(-1)?.at ?? Date.now();
  live.forEach((ev, idx) => {
    if (ev.kind === "text-delta") {
      const trimmed = ev.text.trim();
      if (!trimmed) return;
      out.push({
        id: `${actor.id}:live:text:${idx}`,
        at: lastAt + 1 + idx,
        channel: "chat",
        kind: "speech",
        ...baseActor,
        text: trimmed,
        streaming: true,
      });
    } else if (ev.kind === "tool-start") {
      out.push({
        id: `${actor.id}:live:tool:${idx}`,
        at: lastAt + 1 + idx,
        channel: "action",
        kind: "action",
        ...baseActor,
        badge: "실행 중",
        text: ev.name,
        streaming: true,
      });
    }
  });

  return out;
}

function readLocalized(value: LocalizedText, locale: ConsoleLocale): string {
  return typeof value === "function" ? value(locale) : value;
}

function projectGroupEntries(
  rootActorsByObjectiveId: ReadonlyMap<string, WorldActorSpec>,
  fallbackActor: WorldActorSpec,
  entries: readonly GroupTimelineEntry[],
  locale: ConsoleLocale,
): readonly WorldChatFeedEntry[] {
  const out: WorldChatFeedEntry[] = [];
  let fallbackClock = Date.now() - entries.length * 1000;
  for (const entry of entries) {
    fallbackClock += 1000;
    const at = entry.at ?? fallbackClock;
    switch (entry.kind) {
      case "message": {
        const trimmed = entry.text.trim();
        if (!trimmed) break;
        const speakerObjId = entry.speaker.objectiveId ?? entry.objectiveId;
        const matched = (speakerObjId ? rootActorsByObjectiveId.get(speakerObjId) : undefined) ?? fallbackActor;
        const isHuman = entry.speaker.kind === "human";
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "chat",
          kind: isHuman ? "player" : "speech",
          actorId: matched.id,
          actorName: isHuman ? "제독" : (entry.speaker.name || matched.name),
          actorRole: matched.role,
          actorTone: matched.tone,
          ...(isHuman ? { targetName: entry.recipient?.name ?? matched.name } : {}),
          text: trimmed,
          streaming: entry.streaming,
        });
        break;
      }
      case "delegation": {
        const senderActor = (entry.sender.objectiveId ? rootActorsByObjectiveId.get(entry.sender.objectiveId) : undefined) ?? fallbackActor;
        const recipientNames = entry.recipients.map((r) => r.name).filter(Boolean).join(", ");
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "action",
          kind: "peer",
          actorId: senderActor.id,
          actorName: entry.sender.name || senderActor.name,
          actorRole: senderActor.role,
          actorTone: senderActor.tone,
          targetName: recipientNames || undefined,
          badge: entry.received ? "보고 수신" : "임무 전달",
          text: entry.text.trim() || entry.result,
          failed: entry.ok === false,
        });
        break;
      }
      case "board-action": {
        const speakerActor = (entry.speaker.objectiveId ? rootActorsByObjectiveId.get(entry.speaker.objectiveId) : undefined) ?? fallbackActor;
        const actionText = readLocalized(entry.action, locale);
        const targetText = entry.target?.label ? readLocalized(entry.target.label, locale) : "";
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "system",
          kind: "system-wake",
          actorId: speakerActor.id,
          actorName: entry.speaker.name || speakerActor.name,
          actorRole: speakerActor.role,
          actorTone: speakerActor.tone,
          badge: actionText,
          text: [targetText, entry.text.trim()].filter(Boolean).join(" — ") || actionText,
          failed: entry.status?.failed,
        });
        break;
      }
      case "plugin-notice": {
        const recActor = (entry.recipient.objectiveId ? rootActorsByObjectiveId.get(entry.recipient.objectiveId) : undefined) ?? fallbackActor;
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "system",
          kind: "system-wake",
          actorId: recActor.id,
          actorName: recActor.name,
          actorRole: recActor.role,
          actorTone: recActor.tone,
          badge: "감시자 알림",
          text: entry.text.trim(),
        });
        break;
      }
      case "member-joined":
      case "member-left": {
        const memActor = (entry.speaker.objectiveId ? rootActorsByObjectiveId.get(entry.speaker.objectiveId) : undefined) ?? fallbackActor;
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "system",
          kind: "system-info",
          actorId: memActor.id,
          actorName: entry.speaker.name || memActor.name,
          actorRole: "member",
          actorTone: memActor.tone,
          badge: entry.kind === "member-joined" ? "구성원 합류" : "구성원 퇴장",
          text: entry.kind === "member-joined"
            ? `${entry.speaker.name} 구성원이 캠프에 합류했습니다.`
            : `${entry.speaker.name} 구성원이 임무를 마치고 자리를 비웠습니다.`,
        });
        break;
      }
      case "decision-answer": {
        const text = entry.answers.map((a) => `${a.question} → ${a.declined ? "보류" : a.answer}`).join(" / ");
        out.push({
          id: `obj:${fallbackActor.rootObjectiveId ?? fallbackActor.id}:${entry.id}`,
          at,
          channel: "chat",
          kind: "player",
          actorId: fallbackActor.id,
          actorName: "제독",
          actorRole: fallbackActor.role,
          actorTone: fallbackActor.tone,
          targetName: fallbackActor.name,
          badge: "결정 응답",
          text,
        });
        break;
      }
    }
  }
  return out;
}

export function ensureCommodoreTranscript(commodoreId: string): void {
  if (!commodoreId) return;
  if (readCommodore(commodoreId).view === null) {
    void loadCommodore(commodoreId);
  }
  if (transcriptNeeded(commodoreId)) {
    void loadTranscript(commodoreId);
  }
}

export function ensureObjectiveTimeline(rootObjectiveId: string): void {
  demandGroupTimeline(rootObjectiveId);
}

// ─── Theater 발전도 지표 스토어 (더 월드 오픈 시에만 온디맨드 조회) ───────────────────────

const CLIENT_METRICS_TTL_MS = 45_000;
let theaterMetricsMap: Readonly<Record<string, WorldTheaterMetrics>> = {};
let theaterMetricsFetchedAt = 0;
let theaterMetricsLoading = false;
let theaterMetricsInFlight: Promise<void> | null = null;
const theaterMetricsListeners = new Set<() => void>();

function emitTheaterMetrics(): void {
  for (const listener of [...theaterMetricsListeners]) listener();
}

function sameTheaterMetrics(
  prev: Readonly<Record<string, WorldTheaterMetrics>>,
  next: Readonly<Record<string, WorldTheaterMetrics>>,
): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    const a = prev[key];
    const b = next[key];
    if (!a || !b) return false;
    if (
      a.status !== b.status
      || a.fileCount !== b.fileCount
      || a.dirCount !== b.dirCount
      || a.totalEntries !== b.totalEntries
      || a.truncated !== b.truncated
    ) {
      return false;
    }
  }
  return true;
}

export function readTheaterMetrics(): Readonly<Record<string, WorldTheaterMetrics>> {
  return theaterMetricsMap;
}

export function isTheaterMetricsLoading(): boolean {
  return theaterMetricsLoading;
}

export function subscribeTheaterMetrics(listener: () => void): () => void {
  theaterMetricsListeners.add(listener);
  return () => {
    theaterMetricsListeners.delete(listener);
  };
}

export function ensureTheaterMetrics(options?: { readonly refresh?: boolean }): Promise<void> {
  const refresh = options?.refresh === true;
  if (!refresh && theaterMetricsFetchedAt > 0 && Date.now() - theaterMetricsFetchedAt < CLIENT_METRICS_TTL_MS) {
    return Promise.resolve();
  }
  if (theaterMetricsInFlight) return theaterMetricsInFlight;

  theaterMetricsLoading = true;
  emitTheaterMetrics();

  const url = refresh ? `${THE_WORLD_METRICS_PATH}?refresh=1` : THE_WORLD_METRICS_PATH;
  const run = async (): Promise<void> => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const body = await response.json() as Partial<WorldMetricsResponse> | null;
      const incoming = body?.metrics;
      if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
        theaterMetricsFetchedAt = Date.now();
        if (!sameTheaterMetrics(theaterMetricsMap, incoming)) {
          theaterMetricsMap = incoming;
        }
      }
    } catch {
      // 오프라인·일시 오류 시 기존 스냅샷 유지
    } finally {
      theaterMetricsLoading = false;
      theaterMetricsInFlight = null;
      emitTheaterMetrics();
    }
  };
  theaterMetricsInFlight = run();
  return theaterMetricsInFlight;
}

interface CommodoreFeedCacheEntry {
  readonly actor: WorldActorSpec;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly live: readonly CommodoreLiveEvent[];
  readonly locale: ConsoleLocale;
  readonly projected: readonly WorldChatFeedEntry[];
}

interface GroupFeedCacheEntry {
  readonly commander: WorldActorSpec;
  readonly entries: readonly GroupTimelineEntry[];
  readonly locale: ConsoleLocale;
  readonly projected: readonly WorldChatFeedEntry[];
}

export function useWorldChatFeed(actors: readonly WorldActorSpec[]): readonly WorldChatFeedEntry[] {
  const commodoreRev = useSyncExternalStore(subscribeCommodore, commodoreRevision, commodoreRevision);
  const locale = activeLocale();

  const rootIds = useMemo(() => {
    const ids = new Set<string>();
    for (const actor of actors) {
      if (actor.rootObjectiveId) ids.add(actor.rootObjectiveId);
    }
    return [...ids];
  }, [actors]);

  const groupTimelines = useGroupTimelines(rootIds);
  const commodoreCacheRef = useRef<Map<string, CommodoreFeedCacheEntry>>(new Map());
  const groupCacheRef = useRef<Map<string, GroupFeedCacheEntry>>(new Map());
  const lastFeedRef = useRef<{
    readonly actors: readonly WorldActorSpec[];
    readonly locale: ConsoleLocale;
    readonly groupTimelines: typeof groupTimelines;
    readonly signatures: readonly (readonly [string, readonly CommodoreTranscriptEntry[], readonly CommodoreLiveEvent[]])[];
    readonly result: readonly WorldChatFeedEntry[];
  } | null>(null);

  return useMemo(() => {
    // 1. 사령관별 (entries, live) 참조 시그니처 수집 — 변경이 전혀 없으면 이전 피드 참조를 그대로 재사용한다.
    const nextSignatures: Array<readonly [string, readonly CommodoreTranscriptEntry[], readonly CommodoreLiveEvent[]]> = [];
    for (const actor of actors) {
      if (actor.role !== "commodore" || !actor.commodoreId) continue;
      const snap = readCommodore(actor.commodoreId);
      nextSignatures.push([actor.commodoreId, snap.entries, snap.live]);
    }

    const prevFeed = lastFeedRef.current;
    if (
      prevFeed
      && prevFeed.actors === actors
      && prevFeed.locale === locale
      && prevFeed.groupTimelines === groupTimelines
      && prevFeed.signatures.length === nextSignatures.length
      && prevFeed.signatures.every((sig, idx) => {
        const cur = nextSignatures[idx]!;
        return sig[0] === cur[0] && sig[1] === cur[1] && sig[2] === cur[2];
      })
    ) {
      return prevFeed.result;
    }

    const combined: WorldChatFeedEntry[] = [];
    const actorsByObjectiveId = new Map<string, WorldActorSpec>();
    for (const actor of actors) {
      if (actor.objectiveId) actorsByObjectiveId.set(actor.objectiveId, actor);
    }

    const commCache = commodoreCacheRef.current;
    const activeCommIds = new Set<string>();
    for (const actor of actors) {
      if (actor.role !== "commodore" || !actor.commodoreId) continue;
      activeCommIds.add(actor.commodoreId);
      const snap = readCommodore(actor.commodoreId);
      const cached = commCache.get(actor.commodoreId);
      if (
        cached
        && cached.actor === actor
        && cached.entries === snap.entries
        && cached.live === snap.live
        && cached.locale === locale
      ) {
        combined.push(...cached.projected);
      } else {
        const recentEntries = snap.entries.slice(-45);
        const projected = projectCommodoreEntries(actor, recentEntries, snap.live, locale);
        commCache.set(actor.commodoreId, {
          actor,
          entries: snap.entries,
          live: snap.live,
          locale,
          projected,
        });
        combined.push(...projected);
      }
    }
    for (const key of commCache.keys()) {
      if (!activeCommIds.has(key)) commCache.delete(key);
    }

    const grpCache = groupCacheRef.current;
    const activeRootIds = new Set<string>();
    for (const [rootId, timeline] of groupTimelines.entries()) {
      const commanderActor = actors.find((a) => a.role === "commander" && a.rootObjectiveId === rootId)
        ?? actors.find((a) => a.rootObjectiveId === rootId);
      if (!commanderActor) continue;
      activeRootIds.add(rootId);
      const cached = grpCache.get(rootId);
      if (
        cached
        && cached.commander === commanderActor
        && cached.entries === timeline.entries
        && cached.locale === locale
      ) {
        combined.push(...cached.projected);
      } else {
        const recent = timeline.entries.slice(-40);
        const projected = projectGroupEntries(actorsByObjectiveId, commanderActor, recent, locale);
        grpCache.set(rootId, {
          commander: commanderActor,
          entries: timeline.entries,
          locale,
          projected,
        });
        combined.push(...projected);
      }
    }
    for (const key of grpCache.keys()) {
      if (!activeRootIds.has(key)) grpCache.delete(key);
    }

    combined.sort((a, b) => a.at - b.at);
    const result = combined.length > MAX_GLOBAL_FEED ? combined.slice(-MAX_GLOBAL_FEED) : combined;
    lastFeedRef.current = {
      actors,
      locale,
      groupTimelines,
      signatures: nextSignatures,
      result,
    };
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commodoreRev가 readCommodore() 스냅샷 변화를 알린다.
  }, [actors, commodoreRev, groupTimelines, locale]);
}

export function useActorConversation(actor: WorldActorSpec): WorldActorConversationState {
  const isCommodore = actor.role === "commodore" && Boolean(actor.commodoreId);
  const commodoreId = isCommodore ? actor.commodoreId! : null;
  const rootObjectiveId = !isCommodore ? (actor.rootObjectiveId ?? actor.objectiveId ?? null) : null;
  const locale = activeLocale();

  const comm = useCommodore(commodoreId);
  const group = useGroupTimeline(rootObjectiveId);

  useEffect(() => {
    if (commodoreId) ensureCommodoreTranscript(commodoreId);
  }, [commodoreId]);

  const loadOlder = useCallback(() => {
    if (commodoreId && comm.hasMore) {
      void loadTranscript(commodoreId, { older: true });
    }
  }, [commodoreId, comm.hasMore]);

  const stopTurn = useMemo(
    () => (commodoreId ? () => stopCommodore(commodoreId) : undefined),
    [commodoreId],
  );
  const retryTurn = useMemo(
    () => (commodoreId ? () => retryCommodore(commodoreId) : undefined),
    [commodoreId],
  );
  const skipFailed = useMemo(
    () => (commodoreId ? () => skipCommodoreFailed(commodoreId) : undefined),
    [commodoreId],
  );

  return useMemo<WorldActorConversationState>(() => {
    if (isCommodore && commodoreId) {
      const entries = projectCommodoreEntries(actor, comm.entries, comm.live, locale);
      const working = comm.view?.run.phase === "turn";
      const step = comm.view?.run.step;
      const stepLabel = working ? (step ? STEP_LABEL_KO[step] : "응답 준비 중...") : null;
      return {
        entries,
        loading: !comm.transcriptLoaded,
        working,
        stepLabel,
        hasOlder: comm.hasMore,
        loadOlder,
        stopTurn,
        retryTurn,
        skipFailed,
        openAsksCount: openAsks(commodoreId).length,
      };
    }

    const byObj = new Map<string, WorldActorSpec>();
    if (actor.objectiveId) byObj.set(actor.objectiveId, actor);
    const allEntries = projectGroupEntries(byObj, actor, group.entries, locale);
    const filtered = actor.role === "member" && actor.objectiveId
      ? allEntries.filter((entry) => entry.actorId === actor.id || entry.kind === "player" || entry.kind === "peer")
      : allEntries;
    const working = group.working.length > 0;

    return {
      entries: filtered,
      loading: group.loading,
      working,
      stepLabel: working ? `${group.working.map((w) => w.name).join(", ")} 작업 중...` : null,
      hasOlder: false,
      loadOlder: () => undefined,
      openAsksCount: 0,
    };
  }, [
    actor,
    comm.entries,
    comm.hasMore,
    comm.live,
    comm.transcriptLoaded,
    comm.view,
    commodoreId,
    group.entries,
    group.loading,
    group.working,
    isCommodore,
    loadOlder,
    locale,
    retryTurn,
    skipFailed,
    stopTurn,
  ]);
}

function WorldCommodoreAsksView({ commodoreId }: { readonly commodoreId: string }) {
  const locale = activeLocale();
  const t = getCommodoreT(locale);
  const { view } = useCommodore(commodoreId);
  const asks = useMemo(() => (view?.state.asks ?? []).filter((ask) => !ask.settled), [view?.state.asks]);
  if (asks.length === 0) return null;
  return (
    <div className="the-world-asks-stack">
      {asks.map((ask) => (
        <CommodoreAskCard
          key={ask.id}
          ask={ask}
          theaterId={commodoreId}
          t={t}
          language={locale}
        />
      ))}
    </div>
  );
}

function WorldCommodoreMemorySection({ commodoreId }: { readonly commodoreId: string }) {
  const locale = activeLocale();
  const t = getCommodoreT(locale);
  const wt = getWorldT(locale);
  const [query, setQuery] = useState("");
  const { memory, branches } = useCommodoreMemoryTree(commodoreId, query);

  useEffect(() => {
    void loadCommodoreMemory(commodoreId);
  }, [commodoreId]);

  return (
    <section className="the-world-panel-card">
      <div className="the-world-panel-card-head">
        <h4 className="the-world-panel-title-row">
          <WorldIcon name="memory" size={15} tone="plum" />
          <span>사령관 기억 ({memory.entries.length})</span>
        </h4>
        <input
          type="search"
          className="the-world-input the-world-panel-search"
          value={query}
          placeholder={wt("theWorld.panel.memorySearchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {branches.length === 0 ? (
        <p className="the-world-panel-empty">기록된 기억이 아직 없습니다.</p>
      ) : (
        <div className="the-world-memory-list">
          {branches.map((group) => (
            <div key={group.branch} className="the-world-memory-branch">
              <div className="the-world-memory-branch-title">
                {t(MEMORY_BRANCH_LABEL[group.branch])} ({group.count})
              </div>
              {group.topics.map((topic) => (
                <div key={topic.topic} className="the-world-memory-topic">
                  {topic.entries.map((entry, idx) => (
                    <div key={`${entry.branch}:${entry.topic}:${entry.title}:${idx}`} className="the-world-memory-entry">
                      <strong>{entry.title}</strong>
                      <span>{entry.description}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WorldCommodorePanelBody({
  commodoreId,
  tab,
  onOpenObjective,
}: {
  readonly commodoreId: string;
  readonly tab: WorldActorPanelMode;
  readonly onOpenObjective: (objectiveId: string) => void;
}) {
  const locale = activeLocale();
  const t = getCommodoreT(locale);
  const wt = getWorldT(locale);
  const { view } = useCommodore(commodoreId);
  const [failure, setFailure] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);

  useEffect(() => {
    ensureCommodoreTranscript(commodoreId);
  }, [commodoreId]);

  useEffect(() => {
    setAliasDraft(view?.state.alias ?? "");
  }, [view?.state.alias]);

  const onFail = useCallback((error: unknown) => {
    setFailure(failureWord(t, error instanceof Error ? error.message : String(error)));
  }, [t]);
  const onClear = useCallback(() => setFailure(null), []);

  if (!view) {
    return <div className="the-world-panel-empty">사령관 정보를 불러오는 중입니다...</div>;
  }

  const run = view.run;
  const ctxPct = run.context && run.context.window > 0
    ? Math.min(100, Math.round((run.context.inputTokens / run.context.window) * 100))
    : null;

  return (
    <div className="the-world-console-host">
      {failure ? (
        <div className="the-world-dialogue-feedback is-error" role="alert">
          {failure}
        </div>
      ) : null}

      {tab === "goals" ? (
        <div className="the-world-panel-stack">
          <section className="the-world-panel-card">
            <TasksCommanderList
              commodoreId={commodoreId}
              selectedId={null}
              heading={t("commodore.tasks.goals")}
              onSelect={({ objectiveId }) => {
                if (objectiveId) onOpenObjective(objectiveId);
              }}
            />
          </section>
          <section className="the-world-panel-card">
            <h4 className="the-world-panel-subtitle the-world-panel-title-row">
              <WorldIcon name="routine" size={14} tone="amber" />
              <span>{t("commodore.tasks.routines")}</span>
            </h4>
            <CommodoreRoutines commodoreId={commodoreId} language={locale} />
          </section>
        </div>
      ) : null}

      {tab === "info" ? (
        <div className="the-world-panel-stack">
          <section className="the-world-panel-stats">
            <div className="the-world-stat-pill">
              <span className="the-world-stat-label">실행 상태</span>
              <strong>{run.phase === "turn" ? "턴 실행 중" : run.phase === "error" ? "오류" : run.phase === "retrying" ? "재시도 대기" : "대기 중"}</strong>
            </div>
            <div className="the-world-stat-pill">
              <span className="the-world-stat-label">세션 · 행위</span>
              <strong>{run.totals.session}회 · {run.totals.actions}건</strong>
            </div>
            <div className="the-world-stat-pill">
              <span className="the-world-stat-label">누적 비용</span>
              <strong>${run.totals.costUsd.toFixed(3)}</strong>
            </div>
            {ctxPct !== null ? (
              <div className="the-world-stat-pill">
                <span className="the-world-stat-label">문맥 사용률</span>
                <strong>{ctxPct}%</strong>
              </div>
            ) : null}
          </section>

          <section className="the-world-panel-card">
            <CommodoreDescription
              key={commodoreId}
              t={t}
              commodoreId={commodoreId}
              description={view.state.description}
              onFail={onFail}
              onClear={onClear}
            />
          </section>

          <section className="the-world-panel-card">
            <CommodoreIntel
              t={t}
              theaterId={commodoreId}
              intel={view.state.intel}
              sources={view.state.sources}
              onFail={onFail}
              onClear={onClear}
            />
          </section>

          <WorldCommodoreMemorySection commodoreId={commodoreId} />
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="the-world-panel-stack">
          <section className="the-world-panel-card">
            <div className="the-world-alias-row">
              <label className="the-world-stat-label" htmlFor={`world-alias-${commodoreId}`}>
                사령관 이름 (별칭)
              </label>
              <div className="the-world-dialogue-composer">
                <input
                  id={`world-alias-${commodoreId}`}
                  type="text"
                  className="the-world-input"
                  value={aliasDraft}
                  placeholder={wt("theWorld.panel.aliasPlaceholder")}
                  onChange={(e) => setAliasDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="the-world-primary-action"
                  disabled={aliasBusy || aliasDraft.trim() === (view.state.alias ?? "")}
                  onClick={() => {
                    setAliasBusy(true);
                    onClear();
                    void renameCommodore(commodoreId, aliasDraft.trim())
                      .catch(onFail)
                      .finally(() => setAliasBusy(false));
                  }}
                >
                  저장
                </button>
              </div>
            </div>
          </section>

          <section className="the-world-panel-card">
            <CommodoreSettings
              t={t}
              language={locale}
              theaterId={commodoreId}
              view={view}
              onFail={onFail}
              onClear={onClear}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function renderCommodorePanel(props: {
  readonly commodoreId: string;
  readonly tab: WorldActorPanelMode;
  readonly onOpenObjective: (objectiveId: string) => void;
}): ReactNode {
  return <WorldCommodorePanelBody {...props} />;
}

export function renderCommodoreAsks(commodoreId: string): ReactNode {
  return <WorldCommodoreAsksView commodoreId={commodoreId} />;
}

export function renderObjectivePanel(props: {
  readonly commodoreId: string;
  readonly objectiveId: string;
  readonly tab: "goal" | "crew";
  readonly onSwitchTab: (tab: "goal" | "crew") => void;
  readonly onOpenObjective: (objectiveId: string) => void;
}): ReactNode {
  const locale = activeLocale();
  return (
    <div className="the-world-console-host">
      <CommanderRowPanel
        commodoreId={props.commodoreId}
        objectiveId={props.objectiveId}
        language={locale}
        tab={props.tab}
        onGlyphTab={props.onSwitchTab}
        onOpenObjective={props.onOpenObjective}
      />
    </div>
  );
}

export function openCreateCommodore(): void {
  requestCommodoreCreate();
}

export function openApprovals(): void {
  openApprovalList();
}

/**
 * 제독 퀘스트 게시판 데이터 훅 생성기.
 *
 * - 사령관별 열린 질문(`openAsks`)은 굵은 시그니처 키로 구독해 LLM 스트리밍 중 리렌더를 차단한다.
 * - 전역 승인 대기 목록(`approvalItems`) 및 목표 클러스터(`review`·`active`·`completed`)를 통합 집계한다.
 */
export function createUseWorldQuestBoard(clustersSource: ObjectiveClusterSource) {
  return function useWorldQuestBoard(
    actors: readonly WorldActorSpec[],
    _missions?: readonly WorldMissionItem[],
  ): WorldQuestBoardData {
    const readAsksKey = useCallback((): string => {
      let key = "";
      for (let i = 0; i < actors.length; i += 1) {
        const actor = actors[i]!;
        if (actor.role !== "commodore" || !actor.commodoreId) continue;
        const asks = openAsks(actor.commodoreId);
        if (asks.length === 0) continue;
        key += `${actor.commodoreId}:`;
        for (let j = 0; j < asks.length; j += 1) {
          key += `${asks[j]!.id}@${asks[j]!.at},`;
        }
        key += "|";
      }
      return key;
    }, [actors]);

    const asksKey = useSyncExternalStore(subscribeCommodore, readAsksKey, readAsksKey);
    const approvalVer = useSyncExternalStore(subscribeApprovals, approvalTick, approvalTick);
    const clusters = useSyncExternalStore(clustersSource.subscribe, clustersSource.get, clustersSource.get);

    return useMemo<WorldQuestBoardData>(() => {
      const commodoreActorById = new Map<string, WorldActorSpec>();
      const asks: WorldQuestAskSummary[] = [];

      for (const actor of actors) {
        if (actor.role !== "commodore" || !actor.commodoreId) continue;
        commodoreActorById.set(actor.commodoreId, actor);
        for (const ask of openAsks(actor.commodoreId)) {
          asks.push({
            id: `${actor.commodoreId}:${ask.id}`,
            askId: ask.id,
            commodoreId: actor.commodoreId,
            commodoreActorId: actor.id,
            commodoreName: actor.name,
            commodoreTone: actor.tone,
            reason: ask.reason,
            firstQuestion: ask.questions[0]?.text ?? "",
            questionCount: ask.questions.length,
            at: ask.at,
            objectiveId: ask.objectiveId,
          });
        }
      }
      asks.sort((a, b) => b.at - a.at);

      const rawApprovals = approvalItems();
      const pendingApprovals: WorldQuestApprovalSummary[] = rawApprovals.map((item) => ({
        id: item.id,
        type: item.type,
        createdAt: item.createdAt,
        ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
      }));

      const reviewMissions: WorldQuestMissionSummary[] = [];
      const activeMissions: WorldQuestMissionSummary[] = [];
      const completedMissions: WorldQuestMissionSummary[] = [];

      for (const cluster of clusters) {
        if (cluster.row?.commodore) continue;
        const ownerActor = cluster.commodoreId ? commodoreActorById.get(cluster.commodoreId) : undefined;
        const isDone = cluster.row?.glyph === "done";
        const personWaiting = !isDone && (
          cluster.row?.glyph === "review"
          || cluster.row?.personTurnAt !== undefined
          || cluster.members.some((m) => !m.pending && (m.awaitingInput === true || m.progress === "awaiting"))
        );
        const progressTotal = cluster.row?.progress?.total ?? cluster.members.length;
        const progressDone = cluster.row?.progress?.done ?? cluster.members.filter((m) => m.progress === "done").length;

        const summary: WorldQuestMissionSummary = {
          id: cluster.id,
          objectiveId: cluster.root ?? null,
          title: cluster.title,
          commodoreId: cluster.commodoreId ?? null,
          commodoreActorId: ownerActor?.id ?? null,
          commodoreName: ownerActor?.name ?? "Commodore",
          commodoreTone: ownerActor?.tone ?? "moss",
          status: isDone ? "completed" : personWaiting ? "review" : "active",
          progressDone,
          progressTotal,
          personWaiting,
          activityAt: cluster.row?.activityAt ?? cluster.row?.createdAt ?? 0,
          doneAt: isDone ? (cluster.row?.doneAt ?? cluster.row?.activityAt ?? null) : null,
        };

        if (isDone) completedMissions.push(summary);
        else if (personWaiting) reviewMissions.push(summary);
        else activeMissions.push(summary);
      }

      reviewMissions.sort((a, b) => b.activityAt - a.activityAt);
      activeMissions.sort((a, b) => b.activityAt - a.activityAt);
      completedMissions.sort((a, b) => (b.doneAt ?? b.activityAt) - (a.doneAt ?? a.activityAt));

      const cappedCompleted = completedMissions.length > 30 ? completedMissions.slice(0, 30) : completedMissions;
      const totalUrgentCount = asks.length + pendingApprovals.length + reviewMissions.length;

      return {
        asks,
        pendingApprovalsCount: pendingApprovals.length,
        pendingApprovals,
        reviewMissions,
        activeMissions,
        completedMissions: cappedCompleted,
        totalUrgentCount,
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- asksKey·approvalVer가 외부 스토어 변화를 반영한다.
    }, [actors, asksKey, approvalVer, clusters]);
  };
}
