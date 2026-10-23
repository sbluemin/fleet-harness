import { OpenUIPluginBoundary } from "../openui-boundary.js";
import * as React from "react";
import type { AgentChatTranscriptEntry, AgentChatTranscriptEvent, AgentChatTranscriptProps } from "../../../shared/chat-renderer.js";

import { MobileSurfaceProvider } from "../mobile-surface.js";
import { initialAgentChatLogState, reduceAgentChatLog, type AgentChatClockedEvent, type AgentChatJob, type AgentChatStreamEvent, type AgentChatTurn } from "./chat-events.js";
import { ChatReferenceContext } from "./chat-reference.js";
import { ChatTurn } from "./chat-view.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/**
 * 플러그인 소유 에이전트 기록을 Objective 채팅과 같은 턴 렌더러로 — SDK `ctx.chat.Transcript` 의 호스트 구현.
 *
 * 화면 문법(원장·작업 접힘·답 마크다운·라이브 줄)은 채팅 뷰의 `ChatTurn` 하나가 진다. 여기는 공개 어휘를 채팅 스트림으로 옮겨
 * 접고, `note` 를 턴 사이 구분선으로 세우는 일만 한다. 잡·질문 카드·다시 시도는 플러그인 기록에 없으므로 비어 있다.
 * 스크롤은 담는 쪽이 진다 — 이 면은 흐름 안에 선다.
 */

type Segment =
  | { readonly kind: "turns"; readonly key: string; readonly turns: readonly AgentChatTurn[] }
  | { readonly kind: "note"; readonly key: string; readonly text: string; readonly at?: number; readonly tone?: "warn" };

const NO_JOBS: ReadonlyMap<string, AgentChatJob> = new Map();
const noop = () => undefined;
const noAnswer = async () => undefined;

function streamEvent(event: Exclude<AgentChatTranscriptEvent, { kind: "note" }>): AgentChatStreamEvent {
  switch (event.kind) {
    case "tool": return { kind: "tool", name: event.name, detail: event.detail, ...(event.id !== undefined ? { id: event.id } : {}), ...(event.references?.length ? { references: event.references } : {}) };
    default: return event;
  }
}

/** 구분선마다 끊어 접는다 — 세션이 바뀐 자리는 턴이 이어지지 않는다. 마지막 구간만 진행 중일 수 있다. */
function segmentTranscript(entries: readonly AgentChatTranscriptEntry[]): readonly Segment[] {
  const segments: Segment[] = [];
  let state = { ...initialAgentChatLogState, snapshotting: false };
  let start = 0;
  const close = (index: number, final = false) => {
    // 구분선 앞의 턴은 지나간 것이다 — 결말을 듣지 못한 채 끊긴 턴이 「작업 중」 시계를 단 채 굳지 않게 닫는다.
    const turns = final ? state.turns : state.turns.map((turn) => (turn.state === "working" ? { ...turn, state: "done" as const } : turn));
    if (turns.length > 0) segments.push({ kind: "turns", key: `t${start}`, turns });
    state = { ...initialAgentChatLogState, snapshotting: false };
    start = index + 1;
  };
  entries.forEach((entry, index) => {
    const { event } = entry;
    if (event.kind === "note") {
      close(index);
      segments.push({ kind: "note", key: `n${index}`, text: event.text, ...(event.at !== undefined ? { at: event.at } : {}), ...(event.tone ? { tone: event.tone } : {}) });
      return;
    }
    const clocked: AgentChatClockedEvent = { ...streamEvent(event), ...(entry.at !== undefined ? { receivedAt: entry.at } : {}) };
    state = reduceAgentChatLog(state, clocked);
  });
  close(entries.length, true);
  return segments;
}

/** 그 시각에 돌던 턴 — 시작이 그 시각 이하인 마지막 턴. 시각이 없는 턴은 앞 턴을 잇는다. */
function turnStartedAt(turn: AgentChatTurn): number | undefined {
  return turn.dispatch?.at ?? turn.startedAt;
}

/** 그 시각에 돌던 턴으로 데려가 잠깐 표시한다 — 기록 면과 원장 면이 같은 규칙을 쓴다. 표시는 그 턴의 줄 하나에만 선다. */
export function useTranscriptReveal(rootRef: React.RefObject<HTMLElement | null>, reveal: AgentChatTranscriptProps["reveal"], onReveal?: () => void): void {
  React.useEffect(() => {
    if (!reveal) return;
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-transcript-at]") ?? []);
    let target: HTMLElement | undefined;
    for (const node of nodes) {
      const at = Number(node.dataset.transcriptAt);
      if (Number.isFinite(at) && at <= reveal.at) target = node;
    }
    target ??= nodes[0];
    if (!target) return;
    onReveal?.();
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("is-revealed");
    void target.offsetWidth;
    target.classList.add("is-revealed");
    const node = target;
    const timer = window.setTimeout(() => node.classList.remove("is-revealed"), 1_600);
    return () => window.clearTimeout(timer);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps -- 새 요청(reveal)에만 움직인다.
}

/**
 * 기록의 줄들 — 구분선과 턴. 담는 쪽의 흐름에 그대로 선다(기록 면은 자기 상자 안에, 원장 면은 로그 컬럼 안에). 구분선은 턴 사이를
 * 가르는 낱말이라 코드 축이 아니라 UI 서체로 선다(Objective 채팅의 「이전 대화」 띠와 같은 자리).
 */
export function TranscriptLines({ entries, language, openui = false, onOpenUISend }: {
  readonly entries: AgentChatTranscriptProps["entries"];
  readonly language: AgentChatTranscriptProps["language"];
  /** 답·흐르는 글의 OpenUI 펜스를 그린다 — 플러그인이 켠 기록(사령관 기록)만. 기본은 코드 블록이다. */
  readonly openui?: boolean;
  /** OpenUI 답 단추를 사람이 누르면 플러그인의 기존 전송 경로로 보낸다. 포트 없는 원장은 정적 칩이다. */
  readonly onOpenUISend?: (reply: string) => void;
}) {
  const segments = React.useMemo(() => segmentTranscript(entries), [entries]);
  const [openedTools, setOpenedTools] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggleTool = React.useCallback((id: string) => setOpenedTools((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const openTool = React.useCallback((id: string) => setOpenedTools((current) => new Set(current).add(id)), []);
  const timeFormat = React.useMemo(() => new Intl.DateTimeFormat(language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }), [language]);
  const lastSegment = segments.length - 1;
  return (
    <>
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === "note") {
          return (
            <div key={segment.key} className={`agent-chat-sys agent-chat-transcript-note${segment.tone === "warn" ? " agent-chat-sys--warn" : ""}`}>
              {segment.at !== undefined ? `${timeFormat.format(new Date(segment.at))} · ${segment.text}` : segment.text}
            </div>
          );
        }
        let lastAt: number | undefined;
        return segment.turns.map((turn, index) => {
          lastAt = turnStartedAt(turn) ?? lastAt;
          const live = segmentIndex === lastSegment && index === segment.turns.length - 1;
          return (
            <div key={`${segment.key}:${index}`} className="agent-chat-transcript-turn" {...(lastAt !== undefined ? { "data-transcript-at": String(lastAt) } : {})}>
              <ChatTurn
                objectiveId="transcript"
                turn={turn}
                nextContextBefore={undefined}
                language={language}
                timeFormat={timeFormat}
                streaming={live && turn.state === "working"}
                jobsByToolUse={NO_JOBS}
                onOpenJob={noop}
                onAnswer={noAnswer}
                openedTools={openedTools}
                onToggleTool={toggleTool}
                onOpenTool={openTool}
                openui={openui}
                {...(onOpenUISend ? { onOpenUISend } : {})}
              />
            </div>
          );
        });
      })}
    </>
  );
}

export function AgentChatTranscript({ entries, language, mobile = false, reveal = null, references, openui = false, onOpenUISend, openUIOpen }: AgentChatTranscriptProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  useTranscriptReveal(rootRef, reveal);
  return (
    <OpenUIPluginBoundary port={openUIOpen} language={language}><MobileSurfaceProvider mobile={mobile}>
      <ChatReferenceContext.Provider value={references ?? null}>
      <div ref={rootRef} className="agent-chat agent-chat-transcript" {...(mobile ? { "data-mobile-surface": "" } : {})}>
        <TranscriptLines entries={entries} language={language} openui={openui} {...(onOpenUISend ? { onOpenUISend } : {})} />
      </div>
      </ChatReferenceContext.Provider>
    </MobileSurfaceProvider></OpenUIPluginBoundary>
  );
}
