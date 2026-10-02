import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../i18n/index.js";
import type { AgentChatCatalogEntry } from "./chat-events.js";
import type { ChatDeckSection, ChatDeckToken } from "./composer-deck.js";

/**
 * 컴포저 위에 서는 능력 덱.
 *
 * Quick Launch의 덱과 **같은 문법**을 쓰되 클래스는 새로 짓는다. 코어의 `.quick-launch-*`는
 * 전역 규칙이라 플러그인 마크업에도 먹지만, 그것을 빌려 쓰면 코어 크롬의 CSS가 이 번들의
 * 계약이 되어 버린다("선언된 export만 소비한다"는 경계 원칙). 물려받는 것은 토큰과 문법이다.
 *
 * 행은 한 줄에 [아이콘][이름][설명][메타] 네 칸으로 서고, 네 칸은 목록 전체가 하나의 격자를
 * subgrid로 나눠 쓴다. 칸을 행마다 따로 재면 오른쪽 메타의 폭(Console 표식부터 긴 인자 문법까지)이
 * 설명 열을 행마다 다르게 밀어, 말줄임이 행마다 다른 x에서 끊긴다. 모든 행이 설명을 한 줄로
 * 싣고, 넘치면 말줄임한다 — 한 줄이어야 활성 행이 움직여도 아래 행들이 제자리에 있다.
 *
 * 섹션 라벨은 조용한 글자 한 줄이고 스크롤을 따라 붙지 않는다. 붙는 밴드는 덱의 유리 위에 불투명
 * 판을 하나 더 세워야 했고(덱 자신이 backdrop-filter를 써서 밴드는 형제 행을 흐리지 못한다), 그
 * 판이 유리 계약과 부딪혔다. 섹션은 둘뿐이라 라벨이 지나가도 위치를 잃지 않는다.
 */

const SECTION_LABEL_KEY = {
  commands: "terminal.chat.deckCommands",
  skills: "terminal.chat.deckSkills",
  agents: "terminal.chat.deckAgents",
} as const;

/** 15px 획 아이콘. 컴포저의 첨부·전송 아이콘과 같은 규격이다 — 폰트 글리프는 글꼴마다 광학 크기가 달랐다. */
const SECTION_ICON: Record<ChatDeckSection["id"], React.ReactElement> = {
  commands: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="m5 6.5 2 1.75L5 10M8.5 10.5H11" />
    </svg>
  ),
  skills: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2c.4 2.6 1.5 3.7 4.1 4.1-2.6.4-3.7 1.5-4.1 4.1-.4-2.6-1.5-3.7-4.1-4.1C6.5 5.9 7.6 4.8 8 2.2Z" />
      <path d="M12.2 10.3c.2 1.1.6 1.5 1.6 1.7-1 .2-1.4.6-1.6 1.7-.2-1.1-.6-1.5-1.6-1.7 1-.2 1.4-.6 1.6-1.7Z" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M3 13.6c.7-2.4 2.7-3.8 5-3.8s4.3 1.4 5 3.8" />
    </svg>
  ),
};

const CONSOLE_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M2 6h12M5.2 9.4h3" />
  </svg>
);

const SEARCH_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.3 3.3" />
  </svg>
);

/** 로딩 뼈대 행 수. 카탈로그가 도착했을 때 덱 높이가 한 줄짜리 상자에서 목록으로 튀지 않게 한다. */
const SKELETON_ROWS = 5;
/** 덱이 쓸 수 있는 최대 높이와, 위가 이만큼은 남아야 뒤집지 않는다는 문턱. */
const DECK_MAX_HEIGHT = 340;
const DECK_FLIP_THRESHOLD = 220;
/** 덱과 상자 사이(`--space-2`)와 잘림 경계까지 남길 여유. */
const DECK_EDGE_GAP = 12;

/**
 * 플러그인 네임스페이스(`frontend-design:frontend-design`)를 떼어 낸다. 마지막 `:`까지가 접두다 —
 * 접두는 흐리게, 나머지가 이름으로 읽힌다. 삽입되는 문면은 바꾸지 않으므로 표시만의 일이다.
 */
function splitNamespace(name: string): { readonly namespace: string; readonly base: string } {
  const at = name.lastIndexOf(":");
  return at < 0 ? { namespace: "", base: name } : { namespace: name.slice(0, at + 1), base: name.slice(at + 1) };
}

/** 벤더가 네임스페이스 항목의 설명 앞에 다시 붙이는 `(ns) `를 걷는다 — 이름 열이 이미 그것을 말한다. */
function readDescription(entry: AgentChatCatalogEntry): string {
  return splitNamespace(entry.name).namespace.length > 0
    ? entry.description.replace(/^\([^)]*\)\s*/, "")
    : entry.description;
}

/** 질의와 처음 일치하는 구간을 굵게 세운다. 순위 규칙(composer-deck.ts rank)과 같은 대소문자 무시 포함 일치다. */
function renderMatch(text: string, query: string): React.ReactNode {
  if (query.length === 0) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * 인자 힌트를 CLI 문법으로 그린다. 필수 인자(`<…>`)는 한 단 밝게, 선택지 구분자 `|`는 띄워서 —
 * 비례폭 본문 글꼴에서 `|`가 `l`처럼 읽혀 `create|remove`가 `createlremove`로 보였다.
 */
function renderArgumentHint(hint: string): React.ReactNode {
  return hint
    .split(/(<[^>]+>|\[[^\]]+\])/)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const pieces = part.split("|").flatMap((piece, at) =>
        at === 0 ? [piece] : [<span key={`sep-${at}`} className="agent-chat-deck-meta-sep">|</span>, piece],
      );
      return part.startsWith("<")
        ? <span key={index} className="agent-chat-deck-meta-required">{pieces}</span>
        : <React.Fragment key={index}>{pieces}</React.Fragment>;
    });
}

/** 상자 위로 열지 아래로 열지, 그리고 그쪽에 남은 높이. 잘림 경계는 모든 overflow 조상의 교집합이다. */
interface DeckPlacement {
  readonly below: boolean;
  readonly maxHeight: number;
}

/**
 * 가장 가까운 조상에서 멈추지 않는다 — 줌인한 패널이 화면 위로 나가면 패널 자신의 경계는 화면 밖이고,
 * 실제로 덱을 자르는 것은 그 바깥의 캔버스 뷰포트(상단 크롬 아래 선)다. 첫 조상만 보면 덱이
 * 크롬 뒤로 솟아 머리 행이 잘렸다(실측 1.38배 줌, 덱 top 5.86px, 경계 36px).
 */
function findClipRect(from: HTMLElement): { readonly top: number; readonly bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (window.getComputedStyle(node).overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

function readDeckPlacement(deck: HTMLElement): DeckPlacement | null {
  const field = deck.offsetParent;
  if (!(field instanceof HTMLElement)) return null;
  const clip = findClipRect(field);
  const box = field.getBoundingClientRect();
  // 사각형은 화면 px이고 max-height는 CSS px다. 캔버스 줌(scale) 아래에서 둘을 섞으면 배율이 두 번
  // 곱해져, 줌아웃한 패널의 덱이 화면에서 배율의 제곱만큼 쪼그라든다(실측 0.49배 줌에서 75px).
  const scale = field.offsetHeight > 0 && box.height > 0 ? box.height / field.offsetHeight : 1;
  const above = (box.top - clip.top) / scale - DECK_EDGE_GAP;
  const below = (clip.bottom - box.bottom) / scale - DECK_EDGE_GAP;
  const want = Math.min(DECK_MAX_HEIGHT, deck.scrollHeight + 2);
  // 위가 원하는 높이(혹은 문턱)를 담거나 아래보다 넓으면 위에 선다 — 대화 중 레이아웃의 기본 자리다.
  // 새 채팅 히어로처럼 상자가 패널 가운데 떠 있으면 위가 모자라 아래로 뒤집는다.
  const flip = !(above >= Math.min(want, DECK_FLIP_THRESHOLD) || above >= below);
  const room = flip ? below : above;
  // 하한을 두지 않는다 — 최소 높이 패널의 히어로에서는 위아래 모두 120px 남짓이라, 하한으로 키운 덱이
  // 다시 패널 밖으로 넘어가 상단 테두리와 섹션 라벨이 잘렸다(실측 28px). 남은 공간이 곧 상한이다.
  return { below: flip, maxHeight: Math.round(Math.max(0, Math.min(DECK_MAX_HEIGHT, room))) };
}

export interface ChatComposerDeckProps {
  readonly deckId: string;
  readonly token: ChatDeckToken;
  readonly sections: readonly ChatDeckSection[];
  readonly rows: readonly AgentChatCatalogEntry[];
  readonly activeIndex: number;
  /** 카탈로그를 아직 못 읽었다. 빈 목록과 다른 상태다. */
  readonly pending: boolean;
  readonly language: ConsoleLocale;
  readonly optionId: (index: number) => string;
  readonly onPick: (index: number) => void;
  readonly onHover: (index: number) => void;
}

export function ChatComposerDeck({
  deckId,
  token,
  sections,
  rows,
  activeIndex,
  pending,
  language,
  optionId,
  onPick,
  onHover,
}: ChatComposerDeckProps): React.ReactElement {
  const t = getT(language);
  const deckRef = React.useRef<HTMLDivElement | null>(null);
  const activeRef = React.useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = React.useState<DeckPlacement | null>(null);

  // 덱 높이를 상자 위(또는 아래)에 실제로 남은 공간에 맞춘다. 고정 `max-height`만 두면 새 채팅
  // 히어로처럼 상자가 패널 가운데 뜬 자리에서 덱 위쪽이 패널의 overflow에 잘려, 머리 행과 키보드로
  // 옮긴 행이 보이지 않았다(실측 137px). 칠하기 전에 재야 덱이 한 번 잘린 채로 깜박이지 않는다.
  const contentKey = pending ? "pending" : `${token.kind}:${rows.length}`;
  React.useLayoutEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const place = () => {
      const next = readDeckPlacement(deck);
      setPlacement((previous) =>
        previous?.below === next?.below && previous?.maxHeight === next?.maxHeight ? previous : next,
      );
    };
    place();
    const field = deck.offsetParent;
    if (!(field instanceof HTMLElement)) return;
    // 조상의 style·class가 바뀌는 순간에도 다시 잰다. 캔버스 줌은 월드의 인라인 transform만 바꾸므로
    // 상자의 CSS 크기가 그대로라 ResizeObserver가 울리지 않는다. 휠 줌은 한 프레임에 여러 번 쓰므로
    // 프레임당 한 번으로 모은다 — 변화가 없으면 아무것도 돌지 않는다(상시 폴링이 아니다).
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const mutations = new MutationObserver(schedule);
    for (let node = field.parentElement; node && node !== document.body; node = node.parentElement) {
      mutations.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
    }
    // 패널을 끌어 키우거나 줄여도 덱이 따라온다 — 상자가 움직이는 축은 그 패널의 크기다.
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizes?.observe(field);
    if (field.parentElement) resizes?.observe(field.parentElement);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resizes?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [contentKey]);

  // 방향키로 옮긴 행을 시야에 들인다. `nearest`인 이유는 덱이 목록 전체를 재정렬하지 않고
  // 최소한만 움직여야 사용자가 자기 위치를 잃지 않기 때문이다(QL 덱과 같은 계약).
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, placement]);

  const listbox = !pending && rows.length > 0;
  const query = token.query;
  const prefix = token.kind === "agent" ? "@" : "/";
  let index = -1;
  return (
    <div
      ref={deckRef}
      className={`agent-chat-deck${placement?.below ? " is-below" : ""}`}
      id={deckId}
      // 빈 상태와 로딩은 고를 것이 없으므로 listbox가 아니다 — option 0개짜리 listbox는 보조기기에
      // "목록, 항목 없음"만 남긴다. 그 둘은 안의 status가 말한다.
      {...(listbox ? { role: "listbox", "aria-label": t("terminal.chat.deckAria") } : {})}
      style={placement ? { maxHeight: `${placement.maxHeight}px` } : undefined}
      // 행을 누를 때 textarea가 blur되지 않게 막는다. blur가 먼저 도착하면 덱이 닫히면서
      // 그 클릭이 어디에도 닿지 않는다 — 포인터로는 아무것도 고를 수 없는 덱이 된다.
      onMouseDown={(event) => event.preventDefault()}
    >
      {pending ? (
        // 로딩은 뼈대 행으로 선다 — 문구 한 줄이면 "읽는 중"과 "없음"이 같은 상자로 보였다.
        <div className="agent-chat-deck-list" role="status">
          <p className="agent-chat-deck-section">{t("terminal.chat.deckPending")}</p>
          {Array.from({ length: SKELETON_ROWS }, (_, at) => (
            <div key={at} className="agent-chat-deck-skeleton" aria-hidden="true"><i /><i /><i /></div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        // 매치 0에서도 Enter는 막히지 않는다 — 쓴 문장이 그대로 나간다는 것이 두 컴포저 공통 계약이다.
        <div className="agent-chat-deck-state" role="status">
          <span className="agent-chat-deck-state-title">{SEARCH_ICON}{t("terminal.chat.deckNoMatch")}</span>
          <span>{t("terminal.chat.deckNoMatchHint")}</span>
        </div>
      ) : (
        <div className="agent-chat-deck-list">
          {sections.map((section) => {
            const label = t(SECTION_LABEL_KEY[section.id]);
            return (
              // 섹션은 group이다. 라벨 글자는 그림이고(aria-hidden) 이름은 aria-label이 진다 —
              // listbox 안에 option도 group도 아닌 `<p>`가 섞이지 않게 한다.
              <div key={section.id} className="agent-chat-deck-group" role="group" aria-label={label}>
                <p className="agent-chat-deck-section" aria-hidden="true">
                  {label}
                  <span className="agent-chat-deck-section-count">{String(section.entries.length)}</span>
                </p>
                {section.entries.map((entry) => {
                  index += 1;
                  const rowIndex = index;
                  const active = rowIndex === activeIndex;
                  const description = readDescription(entry);
                  const descriptionId = description.length > 0 ? `${optionId(rowIndex)}-desc` : undefined;
                  const { namespace, base } = splitNamespace(entry.name);
                  // 굵게 세우는 쪽이 이 행이 왜 떴는지를 말한다. 이름이 맞았으면 이름을, 설명으로만
                  // 맞았으면 설명을 — 둘 다 칠하면 이름이 맞은 행에서도 설명이 우연히 번쩍인다.
                  const nameHit = query.length > 0 && entry.name.toLowerCase().includes(query.toLowerCase());
                  return (
                    <button
                      // 인덱스를 키에 넣는다 — 같은 이름이 두 번 올 수 있고(플러그인 스킬), 이름만
                      // 쓰면 두 행이 키를 공유해 React 재조정이 깨진다(실측: 행이 복제되어 그려졌다).
                      key={`${section.id}:${rowIndex}:${entry.name}`}
                      type="button"
                      id={optionId(rowIndex)}
                      ref={active ? activeRef : undefined}
                      className={`agent-chat-deck-row${active ? " is-active" : ""}${entry.console ? " is-console" : ""}`}
                      role="option"
                      aria-selected={active}
                      {...(descriptionId ? { "aria-describedby": descriptionId } : {})}
                      tabIndex={-1}
                      // 포인터가 지나간 자리로 활성 행을 옮긴다. click이 아니라 mousemove인 이유는
                      // 덱이 방향키로 움직인 직후 포인터 아래로 행이 미끄러져 들어오는 경우를
                      // 사용자의 이동으로 읽지 않기 위해서다.
                      onMouseMove={() => onHover(rowIndex)}
                      onClick={() => onPick(rowIndex)}
                    >
                      <span className="agent-chat-deck-icon" aria-hidden="true">{SECTION_ICON[section.id]}</span>
                      {/* 이름은 삽입되는 문면 그대로다 — '@' 행도 `@이름`이 들어가므로 `@`를 보인다. */}
                      <span className="agent-chat-deck-name">
                        <span className="agent-chat-deck-name-prefix">{`${prefix}${namespace}`}</span>
                        {nameHit ? renderMatch(base, query) : base}
                      </span>
                      <span className="agent-chat-deck-desc" id={descriptionId}>
                        {nameHit ? description : renderMatch(description, query)}
                      </span>
                      {entry.console ? (
                        // 행선지가 인자보다 먼저 알아야 할 사실이다 — 이 행의 Enter는 자식이 아니라
                        // Console로 간다. 인자 힌트는 그 뒤의 이야기라 이 행에서는 자리를 내준다.
                        <span className="agent-chat-deck-meta is-console" title={t("terminal.chat.deckConsoleHint")}>
                          {CONSOLE_ICON}
                          <span className="agent-chat-deck-meta-label">{t("terminal.chat.deckConsoleHint")}</span>
                        </span>
                      ) : entry.model !== null ? (
                        // 에이전트가 고정한 모델. 벤더 값 그대로 쓴다 — 컴포저 모델 칩과 이름 체계가 달라
                        // 표시 이름으로 바꾸면 같은 모델이 두 이름으로 보인다. 말줄임될 수 있어 전문은 title이 진다.
                        <span className="agent-chat-deck-meta is-model" title={t("terminal.chat.deckAgentModel", { model: entry.model })}>
                          {entry.model}
                        </span>
                      ) : (
                        // 빈 칸도 격자 칸을 지킨다 — 칸이 빠지면 subgrid의 열 배치가 그 행에서만 밀린다.
                        // 모델을 지정하지 않은 에이전트(세션 모델을 따른다)도 여기서 빈칸으로 선다.
                        <span className="agent-chat-deck-meta">
                          {entry.argumentHint.length > 0 ? renderArgumentHint(entry.argumentHint) : null}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 미러 층의 문면. `renderUltracodeHighlight`와 같은 일을 하되 구간마다 **다른 클래스**를 싣는다 —
 * 무장 표식과 해석된 좌표는 뜻이 다르므로 색도 달라야 하고, SDK 쪽 렌더러는 클래스를 하나만 받는다.
 *
 * 문면은 한 글자도 바꾸지 않는다. 미러는 읽히는 표면이 아니라 textarea 위에 정확히 겹치는
 * 그림이라, 길이가 달라지면 그 자리부터 두 층이 어긋난다. 끝의 zero-width space도 같은 이유다.
 */
export function renderComposerSpans(
  value: string,
  spans: readonly { readonly start: number; readonly end: number; readonly className: string }[],
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((span, index) => {
    if (span.start < at) return;
    if (span.start > at) parts.push(value.slice(at, span.start));
    parts.push(<span key={`span-${index}`} className={span.className}>{value.slice(span.start, span.end)}</span>);
    at = span.end;
  });
  parts.push(`${value.slice(at)}\u200b`);
  return parts;
}
