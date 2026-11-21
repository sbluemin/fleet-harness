import type { Translate } from "@fleet-console/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec, WorldChatChannel, WorldChatFeedEntry } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  activateChat,
  consumeChatMention,
  deactivateChat,
  openActorDialogue,
  pushActorSpeech,
  requestApproachActor,
  useWorldStore,
} from "../world-store.js";
import { playSend, playWakeChime } from "../engine/world-audio.js";
import { WorldIcon, type WorldIconName } from "./world-icons.js";

type ChatFilterKey =
  | "commodoreSpeech"
  | "playerWhisper"
  | "crewSpeech"
  | "peerMail"
  | "asks"
  | "tools"
  | "systemWake"
  | "systemError";

type ChatBackdropMode = "ghost" | "soft" | "solid";

type TabFilterMap = Record<WorldChatChannel, Record<ChatFilterKey, boolean>>;

interface StoredChatPrefs {
  readonly filters: TabFilterMap;
  readonly showTime: boolean;
  readonly backdrop: ChatBackdropMode;
  readonly expanded: boolean;
}

const PREFS_STORAGE_KEY = "fleet.theWorld.chatPrefs.v2";

const CHANNELS: readonly {
  readonly id: WorldChatChannel;
  readonly labelKey: TheWorldMessageKey;
  readonly icon: WorldIconName;
}[] = [
  { id: "all", labelKey: "theWorld.chat.channelAll", icon: "chat" },
  { id: "chat", labelKey: "theWorld.chat.channelChat", icon: "crew" },
  { id: "system", labelKey: "theWorld.chat.channelSystem", icon: "systemWake" },
  { id: "action", labelKey: "theWorld.chat.channelAction", icon: "tool" },
];

const ROLE_LABEL_KEY: Record<WorldActorSpec["role"], TheWorldMessageKey> = {
  commodore: "theWorld.role.commodore",
  commander: "theWorld.role.commander",
  member: "theWorld.role.member",
};

interface FilterItemMeta {
  readonly key: ChatFilterKey;
  readonly labelKey: TheWorldMessageKey;
  readonly tone: "plain" | "teal" | "cerulean" | "plum" | "amber" | "moss" | "warn";
}

const FILTER_GROUPS: readonly {
  readonly id: string;
  readonly titleKey: TheWorldMessageKey;
  readonly items: readonly FilterItemMeta[];
}[] = [
  {
    id: "dialogue",
    titleKey: "theWorld.chat.groupDialogue",
    items: [
      { key: "commodoreSpeech", labelKey: "theWorld.chat.filterCommodore", tone: "plain" },
      { key: "playerWhisper", labelKey: "theWorld.chat.filterWhisper", tone: "teal" },
      { key: "crewSpeech", labelKey: "theWorld.chat.filterCrew", tone: "cerulean" },
      { key: "peerMail", labelKey: "theWorld.chat.filterPeer", tone: "plum" },
      { key: "asks", labelKey: "theWorld.chat.filterAsks", tone: "amber" },
    ],
  },
  {
    id: "activity",
    titleKey: "theWorld.chat.groupActivity",
    items: [
      { key: "tools", labelKey: "theWorld.chat.filterTools", tone: "moss" },
    ],
  },
  {
    id: "system",
    titleKey: "theWorld.chat.groupSystem",
    items: [
      { key: "systemWake", labelKey: "theWorld.chat.filterWake", tone: "amber" },
      { key: "systemError", labelKey: "theWorld.chat.filterError", tone: "warn" },
    ],
  },
];

function createDefaultFilters(): TabFilterMap {
  return {
    all: {
      commodoreSpeech: true,
      playerWhisper: true,
      crewSpeech: true,
      peerMail: true,
      asks: true,
      tools: true,
      systemWake: true,
      systemError: true,
    },
    chat: {
      commodoreSpeech: true,
      playerWhisper: true,
      crewSpeech: true,
      peerMail: true,
      asks: true,
      tools: false,
      systemWake: false,
      systemError: false,
    },
    system: {
      commodoreSpeech: false,
      playerWhisper: false,
      crewSpeech: false,
      peerMail: false,
      asks: true,
      tools: false,
      systemWake: true,
      systemError: true,
    },
    action: {
      commodoreSpeech: false,
      playerWhisper: false,
      crewSpeech: false,
      peerMail: true,
      asks: false,
      tools: true,
      systemWake: true,
      systemError: true,
    },
  };
}

function loadPrefs(): StoredChatPrefs {
  const defaults: StoredChatPrefs = {
    filters: createDefaultFilters(),
    showTime: false,
    backdrop: "soft",
    expanded: false,
  };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<StoredChatPrefs>;
    const baseFilters = createDefaultFilters();
    const merged: TabFilterMap = {
      all: { ...baseFilters.all, ...(parsed.filters?.all ?? {}) },
      chat: { ...baseFilters.chat, ...(parsed.filters?.chat ?? {}) },
      system: { ...baseFilters.system, ...(parsed.filters?.system ?? {}) },
      action: { ...baseFilters.action, ...(parsed.filters?.action ?? {}) },
    };
    return {
      filters: merged,
      showTime: parsed.showTime === true,
      backdrop: parsed.backdrop === "ghost" || parsed.backdrop === "solid" ? parsed.backdrop : "soft",
      expanded: parsed.expanded === true,
    };
  } catch {
    return defaults;
  }
}

function classifyFilterKey(entry: WorldChatFeedEntry): ChatFilterKey {
  switch (entry.kind) {
    case "player":
      return "playerWhisper";
    case "speech":
      return entry.actorRole === "commodore" ? "commodoreSpeech" : "crewSpeech";
    case "peer":
      return "peerMail";
    case "ask":
      return "asks";
    case "action":
      return "tools";
    case "system-wake":
    case "system-info":
      return "systemWake";
    case "system-error":
      return "systemError";
  }
}

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const MAX_COMPACT_CACHE = 512;
const compactLineCache = new Map<string, string>();

function compactLine(text: string, maxLen = 220): string {
  const key = `${maxLen}:${text}`;
  const cached = compactLineCache.get(key);
  if (cached !== undefined) return cached;
  const cleaned = text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const result = cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
  if (compactLineCache.size >= MAX_COMPACT_CACHE) {
    const oldestKey = compactLineCache.keys().next().value;
    if (oldestKey !== undefined) compactLineCache.delete(oldestKey);
  }
  compactLineCache.set(key, result);
  return result;
}

function formatBubbleSnippet(text: string, maxLen = 36): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

/**
 * 실시간 채팅·감시자 깨우기·도구 활동 피드를 3D 말풍선으로 중계하는 경량 헤드리스 컴포넌트.
 * `WorldStage` 루트가 아닌 독립 자식으로 구독해 LLM 스트리밍 중 루트 리렌더를 원천 차단한다.
 */
export const WorldSpeechSync = memo(function WorldSpeechSync({
  actors,
  deps,
  onPushSpeech,
  onCourierEvent,
}: {
  readonly actors: readonly WorldActorSpec[];
  readonly deps: TheWorldClientDeps;
  readonly onPushSpeech: (actorId: string, text: string) => void;
  readonly onCourierEvent?: ((fromActorId: string, targetName: string) => void) | undefined;
}) {
  const chatFeed = deps.useWorldChatFeed(actors);
  const mountedAtRef = useRef(Date.now());
  const lastBubbleSigRef = useRef<Record<string, string>>({});
  const seenLiveEventIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const mountAt = mountedAtRef.current;
    const cutoff = mountAt - 5_000;
    const latestByActor = new Map<string, (typeof chatFeed)[number]>();
    const seen = seenLiveEventIdsRef.current;
    let shouldChime = false;

    for (const entry of chatFeed) {
      // 마운트 이후 새로 도착한 실시간 사건만 효과음/전령 비행 트리거 (초기 히스토리 로드 무음 보장)
      if (entry.at > mountAt && !seen.has(entry.id)) {
        seen.add(entry.id);
        if (entry.kind === "system-wake" || entry.kind === "ask") {
          shouldChime = true;
        } else if (entry.kind === "peer" && entry.targetName && onCourierEvent) {
          onCourierEvent(entry.actorId, entry.targetName);
        }
      }

      if (entry.kind === "player") continue;
      if (entry.at < cutoff && !entry.streaming) continue;
      latestByActor.set(entry.actorId, entry);
    }

    if (seen.size > 400) {
      const keep = chatFeed.map((e) => e.id);
      seen.clear();
      for (const id of keep) seen.add(id);
    }

    if (shouldChime) {
      playWakeChime();
    }

    for (const [actorId, entry] of latestByActor.entries()) {
      const bubbleText = entry.kind === "system-wake"
        ? `[wake] ${entry.badge ? `${entry.badge}: ` : ""}${formatBubbleSnippet(entry.text, 26)}`
        : entry.kind === "ask"
          ? `[ask] ${formatBubbleSnippet(entry.text, 30)}`
          : entry.kind === "action"
            ? `[tool] ${entry.badge ?? formatBubbleSnippet(entry.text, 24)}`
            : entry.kind === "system-error"
              ? `[warn] ${formatBubbleSnippet(entry.text, 28)}`
              : entry.kind === "speech" || entry.kind === "peer"
                ? formatBubbleSnippet(entry.text, 38)
                : "";
      if (!bubbleText) continue;
      const sig = `${entry.id}:${bubbleText}`;
      if (lastBubbleSigRef.current[actorId] === sig) continue;
      lastBubbleSigRef.current[actorId] = sig;
      onPushSpeech(actorId, bubbleText);
    }
  }, [chatFeed, onCourierEvent, onPushSpeech]);

  return null;
});

const ChatLogLine = memo(function ChatLogLine({
  entry,
  showTime,
  t,
  onFocusActor,
}: {
  readonly entry: WorldChatFeedEntry;
  readonly showTime: boolean;
  readonly t: Translate<TheWorldMessageKey>;
  readonly onFocusActor: (actorId: string) => void;
}) {
  const timeNode = showTime ? (
    <span className="the-world-chat-time">{formatClock(entry.at)}</span>
  ) : null;

  if (entry.kind === "system-wake") {
    return (
      <div className="the-world-chat-line is-wake">
        {timeNode}
        <span className="the-world-chat-tag-wake">{t("theWorld.chat.tagWatcher")}</span>{" "}
        <button
          type="button"
          className="the-world-chat-actor-link"
          data-tone={entry.actorTone}
          onClick={() => onFocusActor(entry.actorId)}
        >
          {entry.actorName}
        </button>
        {" — "}
        {entry.badge && entry.badge !== t("theWorld.chat.watcherWakeBadge") ? `${entry.badge} · ` : ""}
        {compactLine(entry.text, 160)}
      </div>
    );
  }

  if (entry.kind === "system-error") {
    return (
      <div className="the-world-chat-line is-error">
        {timeNode}
        <button
          type="button"
          className="the-world-chat-actor-link is-error"
          onClick={() => onFocusActor(entry.actorId)}
        >
          {entry.actorName}
        </button>
        {" · "}
        {entry.badge ?? t("theWorld.chat.fallbackError")}: {compactLine(entry.text, 160)}
      </div>
    );
  }

  if (entry.kind === "system-info") {
    return (
      <div className="the-world-chat-line is-sysinfo">
        {timeNode}
        <button
          type="button"
          className="the-world-chat-actor-link"
          data-tone={entry.actorTone}
          onClick={() => onFocusActor(entry.actorId)}
        >
          {entry.actorName}
        </button>
        {" "}
        {entry.badge ?? t("theWorld.chat.fallbackInfo")} · {compactLine(entry.text, 150)}
      </div>
    );
  }

  if (entry.kind === "action") {
    return (
      <div className={`the-world-chat-line is-action${entry.failed ? " is-error" : ""}`}>
        {timeNode}
        <button
          type="button"
          className="the-world-chat-actor-link"
          data-tone={entry.actorTone}
          onClick={() => onFocusActor(entry.actorId)}
        >
          {entry.actorName}
        </button>
        {" · "}
        <span className="the-world-chat-action-verb">{entry.badge ?? t("theWorld.chat.fallbackTool")}</span>
        {entry.text && entry.text !== entry.badge ? ` (${compactLine(entry.text, 120)})` : ""}
        {entry.streaming ? " ⋯" : ""}
      </div>
    );
  }

  if (entry.kind === "player") {
    return (
      <div className="the-world-chat-line is-player">
        {timeNode}
        <span className="the-world-chat-player-name">
          {t("theWorld.chat.admiralSender")}{entry.targetName ? ` → ${entry.targetName}` : ""}
        </span>
        {": "}
        {entry.badge ? `[${entry.badge}] ` : ""}
        {compactLine(entry.text, 200)}
      </div>
    );
  }

  if (entry.kind === "ask") {
    return (
      <div className="the-world-chat-line is-ask">
        {timeNode}
        <button
          type="button"
          className="the-world-chat-ask-inline"
          onClick={() => onFocusActor(entry.actorId)}
        >
          {t("theWorld.chat.tagAsk")} {entry.actorName}: {compactLine(entry.text, 160)}
        </button>
      </div>
    );
  }

  if (entry.kind === "peer") {
    return (
      <div className="the-world-chat-line is-peer">
        {timeNode}
        <button
          type="button"
          className="the-world-chat-actor-link"
          data-tone={entry.actorTone}
          onClick={() => onFocusActor(entry.actorId)}
        >
          {entry.actorName}
        </button>
        {entry.targetName ? ` → ${entry.targetName}` : ""}
        {": "}
        {compactLine(entry.text, 180)}
      </div>
    );
  }

  return (
    <div className={`the-world-chat-line is-speech${entry.streaming ? " is-streaming" : ""}`}>
      {timeNode}
      <button
        type="button"
        className="the-world-chat-actor-link"
        data-tone={entry.actorTone}
        onClick={() => onFocusActor(entry.actorId)}
      >
        {entry.actorName}
      </button>
      {": "}
      <span>{compactLine(entry.text, 220)}</span>
      {entry.streaming ? <span className="the-world-chat-cursor">▌</span> : null}
    </div>
  );
});

/** 입력 문자열 끝의 활성 `@검색어` 토큰(공백 포함 이름 지원)을 추출한다. */
function findTrailingMentionToken(text: string): { readonly start: number; readonly query: string } | null {
  const match = /(?:^|\s)@([^\n@]*)$/.exec(text);
  if (!match) return null;
  const atIndex = text.lastIndexOf("@");
  if (atIndex < 0) return null;
  return { start: atIndex, query: match[1] ?? "" };
}

function matchesActorQuery(actor: WorldActorSpec, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const compactQuery = trimmed.replace(/\s+/g, "");
  const lowerName = actor.name.toLowerCase();
  const compactName = lowerName.replace(/\s+/g, "");
  return lowerName.includes(trimmed) || compactName.includes(compactQuery);
}

/** 직접 타이핑한 `@사령관 2 안녕` / `@보리 안녕` 문장에서 멘션 대상과 본문을 분리한다. */
function extractInlineMentions(
  rawText: string,
  actors: readonly WorldActorSpec[],
): { readonly matched: readonly WorldActorSpec[]; readonly body: string } {
  const sorted = [...actors].sort((a, b) => b.name.length - a.name.length);
  const found: WorldActorSpec[] = [];
  const seen = new Set<string>();
  let remaining = rawText;

  let progress = true;
  while (progress) {
    progress = false;
    const trimmedStart = remaining.trimStart();
    if (!trimmedStart.startsWith("@")) break;
    const afterAt = trimmedStart.slice(1);
    const lowerAfter = afterAt.toLowerCase();
    for (const actor of sorted) {
      const lowerName = actor.name.toLowerCase();
      const compactName = lowerName.replace(/\s+/g, "");
      let consumedLen = 0;
      if (lowerAfter.startsWith(lowerName)) {
        const nextChar = afterAt[actor.name.length];
        if (nextChar === undefined || /\s/.test(nextChar)) {
          consumedLen = actor.name.length;
        }
      } else if (compactName !== lowerName && lowerAfter.startsWith(compactName)) {
        const nextChar = afterAt[compactName.length];
        if (nextChar === undefined || /\s/.test(nextChar)) {
          consumedLen = compactName.length;
        }
      }
      if (consumedLen > 0) {
        if (!seen.has(actor.id)) {
          seen.add(actor.id);
          found.push(actor);
        }
        remaining = afterAt.slice(consumedLen).trimStart();
        progress = true;
        break;
      }
    }
  }

  return { matched: found, body: remaining.trim() };
}

/**
 * 가운데 하단 MMORPG 스타일 앰비언트/확장 채팅·시스템 오버레이 + `@` 멘션 자동완성 + 「채팅 설정」 창.
 *
 * - 기본 비활성(`store.chatActive === false`): 배경·헤더·레일·입력창을 숨기고 최근 5줄의
 *   투명 플로팅 로그(`pointer-events: none`)와 작은 `Enter` 활성화 트리거만 표시한다.
 * - 활성(`Enter` / 클릭 / `@멘션` 지시): 부드러운 확장 애니메이션으로 풀 채팅창을 열고 입력창에 포커스한다.
 */
export const WorldChatLog = memo(function WorldChatLog({
  actors,
  feed: feedProp,
  deps,
  hidden = false,
  onStatusBanner,
}: {
  readonly actors: readonly WorldActorSpec[];
  readonly feed?: readonly WorldChatFeedEntry[] | undefined;
  readonly deps: TheWorldClientDeps;
  readonly hidden?: boolean | undefined;
  readonly onStatusBanner: (msg: string) => void;
}) {
  const store = useWorldStore();
  const chatActive = store.chatActive && !hidden;
  const subscribedFeed = deps.useWorldChatFeed(actors);
  const feed = feedProp ?? subscribedFeed;
  const t = getWorldT(deps.commodore.language());

  const [prefs, setPrefs] = useState<StoredChatPrefs>(loadPrefs);
  const [channel, setChannel] = useState<WorldChatChannel>("all");
  const [settingsTab, setSettingsTab] = useState<WorldChatChannel>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mentionIds, setMentionIds] = useState<readonly string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [ambientFaded, setAmbientFaded] = useState(false);
  const [ambientHovered, setAmbientHovered] = useState(false);
  const [ambientActivityNonce, setAmbientActivityNonce] = useState(0);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastSeenIdRef = useRef<string | null>(null);
  const actorsRef = useRef(actors);
  actorsRef.current = actors;

  // SimCity 구역 Inspector·우클릭 퀵메뉴·하늘 조망 합동 드래그 등의 `@사령관` 멘션 요청을 수신해 칩 삽입 + 프리필 + 자동 활성화 + 포커스한다.
  useEffect(() => {
    const req = store.pendingChatMention;
    if (!req) return;
    consumeChatMention(req.nonce);
    setMentionDismissedAt(null);
    const nextIds = req.actorIds && req.actorIds.length > 0 ? req.actorIds : [req.actorId];
    setMentionIds((prev) => {
      const merged = [...prev];
      for (const id of nextIds) {
        if (id && !merged.includes(id)) merged.push(id);
      }
      return merged;
    });
    if (req.prefillText && req.prefillText.trim().length > 0) {
      const formatted = req.prefillText.endsWith(" ") ? req.prefillText : `${req.prefillText} `;
      setDraft((prev) => (prev.trim().length === 0 ? formatted : prev));
    }
    activateChat();
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = input.value.length;
      try {
        input.setSelectionRange(end, end);
      } catch {
        // 선택 범위 설정 미지원 환경 무시
      }
    });
  }, [store.pendingChatMention]);

  // 채팅창 활성 ↔ 앰비언트 전환 시 입력 포커스·설정 팝오버·스크롤을 동기화한다.
  useEffect(() => {
    if (chatActive) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        const el = listRef.current;
        if (el && stickToBottomRef.current) {
          el.scrollTop = el.scrollHeight;
        }
      });
    } else {
      setSettingsOpen(false);
      setMentionDismissedAt(null);
      if (document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    }
  }, [chatActive]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // 저장 공간이 막혀 있어도 세션 내 동작은 유지한다.
    }
  }, [prefs]);

  const activeFilters = prefs.filters[channel];
  const filtered = useMemo(
    () => feed.filter((entry) => activeFilters[classifyFilterKey(entry)]),
    [activeFilters, feed],
  );
  const ambientEntries = useMemo(() => filtered.slice(-5), [filtered]);
  const latestAmbientId = ambientEntries.at(-1)?.id ?? null;

  // 입력창 비활성 + 비호버 상태에서 마지막 메시지 후 10초 경과 시 프리뷰 로그를 부드럽게 페이드아웃한다.
  useEffect(() => {
    if (chatActive || hidden || ambientEntries.length === 0) {
      setAmbientFaded(false);
      return;
    }
    if (ambientHovered) {
      setAmbientFaded(false);
      return;
    }
    setAmbientFaded(false);
    const timer = window.setTimeout(() => {
      setAmbientFaded(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [ambientEntries.length, ambientHovered, ambientActivityNonce, chatActive, hidden, latestAmbientId]);

  // 사라진 캐릭터가 멘션 칩에 남아 있지 않도록 정리한다.
  const mentionedActors = useMemo(
    () => mentionIds
      .map((id) => actors.find((a) => a.id === id))
      .filter((a): a is WorldActorSpec => a !== undefined),
    [actors, mentionIds],
  );

  // 비활성(앰비언트) 상태에서 새 메시지가 오면 미확인 카운터를 올리고, 활성화되면 초기화한다.
  useEffect(() => {
    const newest = feed.at(-1)?.id ?? null;
    if (chatActive) {
      lastSeenIdRef.current = newest;
      setUnreadCount(0);
      return;
    }
    if (!newest || newest === lastSeenIdRef.current) return;
    lastSeenIdRef.current = newest;
    setUnreadCount((prev) => prev + 1);
  }, [chatActive, feed]);

  // 바닥에 붙어 있을 때만 최신 줄로 자동 스크롤한다.
  useEffect(() => {
    if (!chatActive || !stickToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatActive, filtered, prefs.expanded]);

  const nearActor = useMemo(
    () => (store.nearActorId ? actors.find((a) => a.id === store.nearActorId) ?? null : null),
    [actors, store.nearActorId],
  );

  const trailingToken = useMemo(() => findTrailingMentionToken(draft), [draft]);
  const mentionOpen = trailingToken !== null && mentionDismissedAt !== draft;

  const mentionCandidates = useMemo(() => {
    if (!mentionOpen || !trailingToken) return [];
    return actors.filter(
      (a) => !mentionIds.includes(a.id) && matchesActorQuery(a, trailingToken.query),
    );
  }, [actors, mentionIds, mentionOpen, trailingToken]);

  useEffect(() => {
    setMentionIndex(0);
  }, [trailingToken?.query, mentionCandidates.length]);

  const handleFocusActor = useCallback((actorId: string) => {
    if (!actorsRef.current.some((a) => a.id === actorId)) return;
    requestApproachActor(actorId);
    openActorDialogue(actorId);
  }, []);

  const commitMentionCandidate = (actor: WorldActorSpec) => {
    setMentionIds((prev) => (prev.includes(actor.id) ? prev : [...prev, actor.id]));
    if (trailingToken) {
      const before = draft.slice(0, trailingToken.start).trimEnd();
      setDraft(before ? `${before} ` : "");
    }
    setMentionDismissedAt(null);
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const triggerMentionPicker = () => {
    setMentionDismissedAt(null);
    if (!trailingToken) {
      setDraft((prev) => (prev.length === 0 || /\s$/.test(prev) ? `${prev}@` : `${prev} @`));
    }
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const toggleFilter = (tab: WorldChatChannel, key: ChatFilterKey) => {
    setPrefs((prev) => ({
      ...prev,
      filters: {
        ...prev.filters,
        [tab]: {
          ...prev.filters[tab],
          [key]: !prev.filters[tab][key],
        },
      },
    }));
  };

  const toggleGroupFilters = (tab: WorldChatChannel, keys: readonly ChatFilterKey[]) => {
    setPrefs((prev) => {
      const currentTab = prev.filters[tab];
      const allChecked = keys.every((k) => currentTab[k]);
      const nextTab = { ...currentTab };
      for (const k of keys) nextTab[k] = !allChecked;
      return {
        ...prev,
        filters: {
          ...prev.filters,
          [tab]: nextTab,
        },
      };
    });
  };

  const resetTabFilters = (tab: WorldChatChannel) => {
    const defaults = createDefaultFilters();
    setPrefs((prev) => ({
      ...prev,
      filters: {
        ...prev.filters,
        [tab]: defaults[tab],
      },
    }));
  };

  const handleSend = async () => {
    const raw = draft.trim();
    if (!raw || sending) return;

    const inline = extractInlineMentions(raw, actors);
    const recipients: WorldActorSpec[] = [...mentionedActors];
    for (const candidate of inline.matched) {
      if (!recipients.some((r) => r.id === candidate.id)) recipients.push(candidate);
    }

    const body = inline.matched.length > 0 ? inline.body : raw;
    if (!body) return;

    if (recipients.length === 0) {
      if (nearActor) {
        recipients.push(nearActor);
      } else {
        triggerMentionPicker();
        onStatusBanner(t("theWorld.chat.mentionRequiredToast"));
        return;
      }
    }

    setSending(true);
    try {
      const delivered: string[] = [];
      const failed: string[] = [];
      for (const recipient of recipients) {
        const result = recipient.role === "commodore" && recipient.commodoreId
          ? await deps.sendMessageToCommodore(recipient.commodoreId, body)
          : recipient.objectiveId
            ? await deps.sendMessageToObjective(recipient.objectiveId, body)
            : { ok: false, error: "no_target" };
        if (result.ok) {
          pushActorSpeech(recipient.id, t("theWorld.chat.receivedSpeech", { text: body.slice(0, 24) }));
          delivered.push(recipient.name);
        } else {
          failed.push(`${recipient.name} (${result.error ?? "unknown"})`);
        }
      }

      if (delivered.length > 0) {
        playSend();
        setDraft("");
        setMentionIds([]);
        setMentionDismissedAt(null);
        setAmbientActivityNonce((n) => n + 1);
        onStatusBanner(t("theWorld.chat.sentToast", { names: delivered.join(", ") }));
      }
      if (failed.length > 0) {
        onStatusBanner(t("theWorld.chat.sendFailedToast", { errors: failed.join(", ") }));
      }
    } finally {
      setSending(false);
    }
  };

  const activeChannelMeta = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0]!;
  const editingFilters = prefs.filters[settingsTab];
  const placeholderText = mentionedActors.length > 0
    ? t("theWorld.chat.inputTargetedPlaceholder", { names: mentionedActors.map((a) => a.name).join(", ") })
    : nearActor
      ? t("theWorld.chat.inputNearPlaceholder", { name: nearActor.name })
      : t("theWorld.chat.inputPlaceholder");

  return (
    <div
      className={`the-world-chat-shell${chatActive ? " is-active" : " is-ambient"}${hidden ? " is-hidden" : ""}`}
      onPointerDown={chatActive ? (e) => e.stopPropagation() : undefined}
      onWheel={chatActive ? (e) => e.stopPropagation() : undefined}
    >
      {/* 기본 비활성(앰비언트) 상태: 게임 화면 위 투명 플로팅 최근 5줄(10초 무활동 시 자동 페이드) + Enter 트리거 */}
      <div
        className={`the-world-chat-ambient${ambientFaded ? " is-faded" : ""}`}
        aria-hidden={chatActive || hidden}
        onMouseEnter={() => setAmbientHovered(true)}
        onMouseLeave={() => setAmbientHovered(false)}
      >
        {ambientEntries.length > 0 ? (
          <div className={`the-world-chat-ambient-lines${ambientFaded ? " is-faded" : ""}`}>
            {ambientEntries.map((entry) => (
              <ChatLogLine
                key={entry.id}
                entry={entry}
                showTime={false}
                t={t}
                onFocusActor={handleFocusActor}
              />
            ))}
          </div>
        ) : null}
        <div className="the-world-chat-ambient-bar">
          <button
            type="button"
            className="the-world-chat-ambient-trigger"
            tabIndex={chatActive || hidden ? -1 : 0}
            aria-label={t("theWorld.chat.activateAria")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => activateChat()}
          >
            <WorldIcon name="chat" size={13} tone="amber" />
            <span className="the-world-keycap">Enter</span>
            <span>{t("theWorld.chat.enterHint")}</span>
            {unreadCount > 0 ? <span className="the-world-chat-unread">{unreadCount}</span> : null}
          </button>
        </div>
      </div>

      {/* 활성 상태: 부드러운 확장 애니메이션으로 펼쳐지는 풀 MMORPG 채팅창 */}
      <div className="the-world-chat-panel-wrap" aria-hidden={!chatActive}>
        <div className="the-world-chat-panel-inner">
          <aside
            className={`the-world-chat is-backdrop-${prefs.backdrop}${prefs.expanded ? " is-expanded" : ""}`}
            aria-label={t("theWorld.chat.aria")}
          >
            {/* 좌측 세로 채널 아이콘 레일 */}
            <nav className="the-world-chat-rail" role="tablist" aria-label={t("theWorld.chat.tabsAria")}>
              {CHANNELS.map((ch) => {
                const active = channel === ch.id;
                const chLabel = t(ch.labelKey);
                return (
                  <button
                    key={ch.id}
                    type="button"
                    role="tab"
                    tabIndex={chatActive ? 0 : -1}
                    aria-selected={active}
                    aria-label={chLabel}
                    title={chLabel}
                    className={`the-world-chat-rail-btn${active ? " is-active" : ""}`}
                    onClick={() => {
                      setChannel(ch.id);
                      if (settingsOpen) setSettingsTab(ch.id);
                    }}
                  >
                    <WorldIcon name={ch.icon} size={15} tone={active ? "amber" : "inherit"} />
                  </button>
                );
              })}
            </nav>

            {/* 우측 보더리스 반투명 채팅 본문 */}
            <div className="the-world-chat-main">
              <header className="the-world-chat-head">
                <span className="the-world-chat-title">{t(activeChannelMeta.labelKey)}</span>
                <div className="the-world-chat-tools">
                  <button
                    type="button"
                    tabIndex={chatActive ? 0 : -1}
                    className={`the-world-chat-icon-btn${settingsOpen ? " is-active" : ""}`}
                    aria-label={t("theWorld.chat.settingsAria")}
                    onClick={() => {
                      setSettingsTab(channel);
                      setSettingsOpen((prev) => !prev);
                    }}
                  >
                    <WorldIcon name="settings" size={15} />
                  </button>
                  <button
                    type="button"
                    tabIndex={chatActive ? 0 : -1}
                    className="the-world-chat-icon-btn"
                    aria-label={t("theWorld.chat.collapseAria")}
                    onClick={() => {
                      setSettingsOpen(false);
                      deactivateChat();
                    }}
                  >
                    <WorldIcon name="close" size={15} />
                  </button>
                </div>
              </header>

              <div
                ref={listRef}
                className="the-world-chat-log"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
                }}
              >
                {filtered.length === 0 ? (
                  <div className="the-world-chat-empty">
                    {t("theWorld.chat.emptyLog")}
                  </div>
                ) : (
                  filtered.map((entry) => (
                    <ChatLogLine
                      key={entry.id}
                      entry={entry}
                      showTime={prefs.showTime}
                      t={t}
                      onFocusActor={handleFocusActor}
                    />
                  ))
                )}
              </div>

              {actors.length > 0 ? (
                <div className="the-world-chat-composer-wrap">
                  {/* `@` 멘션 자동완성 다크 크리스탈 팝오버 */}
                  {chatActive && mentionOpen && mentionCandidates.length > 0 ? (
                    <div
                      className="the-world-chat-mention-popover"
                      role="listbox"
                      aria-label={t("theWorld.chat.mentionListAria")}
                    >
                      <div className="the-world-crest" aria-hidden="true" />
                      <div className="the-world-chat-mention-list">
                        {mentionCandidates.map((actor, idx) => {
                          const active = idx === mentionIndex;
                          return (
                            <button
                              key={actor.id}
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={`the-world-chat-mention-item${active ? " is-active" : ""}`}
                              onMouseEnter={() => setMentionIndex(idx)}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                commitMentionCandidate(actor);
                              }}
                            >
                              <MongleAvatar
                                base={actor.baseId}
                                tone={actor.tone}
                                role={actor.role}
                                state={actor.state}
                                activity={actor.activity}
                                size={18}
                                label={actor.name}
                                decorative
                              />
                              <span className="the-world-chat-mention-name">{actor.name}</span>
                              <span className="the-world-chat-mention-role">{t(ROLE_LABEL_KEY[actor.role])}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="the-world-chat-composer">
                    <button
                      type="button"
                      tabIndex={chatActive ? 0 : -1}
                      className={`the-world-chat-at-btn${mentionOpen ? " is-active" : ""}`}
                      aria-label={t("theWorld.chat.mentionTriggerAria")}
                      title={t("theWorld.chat.mentionTriggerAria")}
                      onClick={triggerMentionPicker}
                    >
                      @
                    </button>

                    <div className="the-world-chat-field">
                      {mentionedActors.map((actor) => (
                        <span key={actor.id} className="the-world-chat-mention-chip" data-tone={actor.tone}>
                          <span>@{actor.name}</span>
                          <button
                            type="button"
                            tabIndex={chatActive ? 0 : -1}
                            className="the-world-chat-mention-chip-x"
                            aria-label={t("theWorld.chat.mentionRemoveAria", { name: actor.name })}
                            onClick={() => setMentionIds((prev) => prev.filter((id) => id !== actor.id))}
                          >
                            <WorldIcon name="close" size={10} />
                          </button>
                        </span>
                      ))}

                      <input
                        ref={inputRef}
                        type="text"
                        tabIndex={chatActive ? 0 : -1}
                        className="the-world-chat-input"
                        value={draft}
                        placeholder={placeholderText}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          setMentionDismissedAt(null);
                        }}
                        onKeyDown={(e) => {
                          const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                          if (mentionOpen && mentionCandidates.length > 0) {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              setMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
                              return;
                            }
                            if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
                              return;
                            }
                            if ((e.key === "Tab" || e.key === "Enter") && !composing) {
                              e.preventDefault();
                              const chosen = mentionCandidates[mentionIndex];
                              if (chosen) commitMentionCandidate(chosen);
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              setMentionDismissedAt(draft);
                              return;
                            }
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            if (settingsOpen) {
                              setSettingsOpen(false);
                            } else {
                              deactivateChat();
                              e.currentTarget.blur();
                            }
                            return;
                          }
                          if (e.key === "Backspace" && draft.length === 0 && mentionIds.length > 0) {
                            e.preventDefault();
                            setMentionIds((prev) => prev.slice(0, -1));
                            return;
                          }
                          if (e.key === "Enter" && !composing) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (draft.trim().length === 0 && mentionIds.length === 0) {
                              deactivateChat();
                              e.currentTarget.blur();
                              return;
                            }
                            void handleSend();
                          }
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      tabIndex={chatActive ? 0 : -1}
                      className="the-world-chat-send"
                      disabled={sending || draft.trim().length === 0}
                      onClick={() => void handleSend()}
                    >
                      {t("theWorld.chat.sendBtn")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </div>

      {/* 우측으로 펼쳐지는 AAA MMORPG 스타일 「채팅 설정」 팝오버 */}
      {chatActive && settingsOpen ? (
        <section
          className="the-world-chat-settings"
          role="dialog"
          aria-label={t("theWorld.chat.settingsAria")}
        >
          <div className="the-world-chat-settings-crest" aria-hidden="true" />
          <header className="the-world-chat-settings-head">
            <h3 className="the-world-chat-settings-title">{t("theWorld.chat.settingsTitle")}</h3>
            <button
              type="button"
              className="the-world-chat-icon-btn"
              aria-label={t("theWorld.chat.settingsAria")}
              onClick={() => setSettingsOpen(false)}
            >
              <WorldIcon name="close" size={15} />
            </button>
          </header>

          <div className="the-world-chat-settings-subhead">
            <span className="the-world-chat-settings-kicker">
              <WorldIcon name="systemInfo" size={12} tone="cerulean" />
              <span>{t("theWorld.chat.tabSettings")}</span>
            </span>
            <button
              type="button"
              className="the-world-chat-reset-btn"
              aria-label={t("theWorld.chat.resetFiltersAria")}
              title={t("theWorld.chat.resetFiltersAria")}
              onClick={() => resetTabFilters(settingsTab)}
            >
              <WorldIcon name="retry" size={13} />
            </button>
          </div>

          <div className="the-world-chat-settings-tabrow">
            <span className="the-world-chat-settings-label">{t("theWorld.chat.selectTab")}</span>
            <div className="the-world-chat-settings-tabpills">
              {CHANNELS.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  className={`the-world-chat-settings-pill${settingsTab === ch.id ? " is-active" : ""}`}
                  onClick={() => {
                    setSettingsTab(ch.id);
                    setChannel(ch.id);
                  }}
                >
                  {t(ch.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="the-world-chat-settings-body">
            {FILTER_GROUPS.map((group) => {
              const keys = group.items.map((item) => item.key);
              const allOn = keys.every((k) => editingFilters[k]);
              return (
                <div key={group.id} className="the-world-chat-filter-group">
                  <label className="the-world-chat-check is-group">
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={() => toggleGroupFilters(settingsTab, keys)}
                    />
                    <span className="the-world-chat-check-box" aria-hidden="true" />
                    <span className="the-world-chat-check-label">{t(group.titleKey)}</span>
                  </label>
                  <div className="the-world-chat-filter-grid">
                    {group.items.map((item) => (
                      <label key={item.key} className={`the-world-chat-check is-tone-${item.tone}`}>
                        <input
                          type="checkbox"
                          checked={editingFilters[item.key]}
                          onChange={() => toggleFilter(settingsTab, item.key)}
                        />
                        <span className="the-world-chat-check-box" aria-hidden="true" />
                        <span className="the-world-chat-check-label">{t(item.labelKey)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="the-world-chat-settings-divider" />

            <div className="the-world-chat-display-row">
              <label className="the-world-chat-check">
                <input
                  type="checkbox"
                  checked={prefs.showTime}
                  onChange={() => setPrefs((prev) => ({ ...prev, showTime: !prev.showTime }))}
                />
                <span className="the-world-chat-check-box" aria-hidden="true" />
                <span className="the-world-chat-check-label">{t("theWorld.chat.showTime")}</span>
              </label>

              <div className="the-world-chat-settings-tabpills">
                {([
                  { id: "ghost", labelKey: "theWorld.chat.backdropGhost" as TheWorldMessageKey },
                  { id: "soft", labelKey: "theWorld.chat.backdropSoft" as TheWorldMessageKey },
                  { id: "solid", labelKey: "theWorld.chat.backdropSolid" as TheWorldMessageKey },
                ] as const).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={`the-world-chat-settings-pill${prefs.backdrop === mode.id ? " is-active" : ""}`}
                    onClick={() => setPrefs((prev) => ({ ...prev, backdrop: mode.id }))}
                  >
                    {t(mode.labelKey)}
                  </button>
                ))}
                <button
                  type="button"
                  className={`the-world-chat-settings-pill${prefs.expanded ? " is-active" : ""}`}
                  aria-label={t("theWorld.chat.sizeAria")}
                  onClick={() => setPrefs((prev) => ({ ...prev, expanded: !prev.expanded }))}
                >
                  {prefs.expanded ? t("theWorld.chat.sizeCompact") : t("theWorld.chat.sizeExpanded")}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
});
