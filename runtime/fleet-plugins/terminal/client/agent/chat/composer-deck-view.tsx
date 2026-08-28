import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../../i18n/index.js";
import type { AgentChatCatalogEntry } from "./chat-events.js";
import type { ChatDeckSection, ChatDeckToken } from "./composer-deck.js";

/**
 * 컴포저 위에 서는 능력 덱.
 *
 * Quick Launch의 덱과 **같은 문법**을 쓰되 클래스는 새로 짓는다. 코어의 `.quick-launch-*`는
 * 전역 규칙이라 플러그인 마크업에도 먹지만, 그것을 빌려 쓰면 코어 크롬의 CSS가 이 번들의
 * 계약이 되어 버린다("선언된 export만 소비한다"는 경계 원칙). 물려받는 것은 토큰과 문법이다.
 *
 * 행이 한 줄로 서고 **활성 행만** 설명을 펴는 이유는 밀도다. QL의 다섯 명령은 이름만으로
 * 자명하지만 이 목록은 스킬 수십 개를 싣고, 그 이름들은 자명하지 않다. 모든 행에 설명을 붙이면
 * 같은 높이에 여섯 행밖에 서지 못하고, 아무 행에도 붙이지 않으면 뜻 모를 이름의 벽이 된다.
 * 눈이 멈춘 자리에서만 설명을 치르는 것이 두 손해를 모두 피하는 자리다.
 *
 * 카테고리 머리글은 스크롤을 따라 붙는다. 배경은 **불투명 칠이 아니라** 덱의 유리 틴트를 다시
 * 칠하고 `backdrop-filter`가 뒤를 흐리는 것이다 — 솔리드로 덮으면 유리가 기본인 제품에서 이
 * 밴드만 판이 되어 유리 계약이 깨진다(`/model` 프로바이더 밴드가 같은 레시피를 쓴다).
 */

const SECTION_LABEL_KEY = {
  commands: "terminal.chat.deckCommands",
  skills: "terminal.chat.deckSkills",
  agents: "terminal.chat.deckAgents",
} as const;

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
  const activeRef = React.useRef<HTMLButtonElement | null>(null);

  // 방향키로 옮긴 행을 시야에 들인다. `nearest`인 이유는 덱이 목록 전체를 재정렬하지 않고
  // 최소한만 움직여야 사용자가 자기 위치를 잃지 않기 때문이다(QL 덱과 같은 계약).
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (pending) {
    return (
      <div
      className="agent-chat-deck"
      id={deckId}
      role="listbox"
      aria-label={t("terminal.chat.deckAria")}
      // 행을 누를 때 textarea가 blur되지 않게 막는다. blur가 먼저 도착하면 덱이 닫히면서
      // 그 클릭이 어디에도 닿지 않는다 — 포인터로는 아무것도 고를 수 없는 덱이 된다.
      onMouseDown={(event) => event.preventDefault()}
    >
        <p className="agent-chat-deck-empty" role="status">{t("terminal.chat.deckPending")}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
      className="agent-chat-deck"
      id={deckId}
      role="listbox"
      aria-label={t("terminal.chat.deckAria")}
      // 행을 누를 때 textarea가 blur되지 않게 막는다. blur가 먼저 도착하면 덱이 닫히면서
      // 그 클릭이 어디에도 닿지 않는다 — 포인터로는 아무것도 고를 수 없는 덱이 된다.
      onMouseDown={(event) => event.preventDefault()}
    >
        {/* 매치 0에서도 Enter는 막히지 않는다 — 쓴 문장이 그대로 나간다는 것이 두 컴포저 공통 계약이다. */}
        <p className="agent-chat-deck-empty">{t("terminal.chat.deckNoMatch")}</p>
      </div>
    );
  }

  let index = -1;
  return (
    <div
      className="agent-chat-deck"
      id={deckId}
      role="listbox"
      aria-label={t("terminal.chat.deckAria")}
      // 행을 누를 때 textarea가 blur되지 않게 막는다. blur가 먼저 도착하면 덱이 닫히면서
      // 그 클릭이 어디에도 닿지 않는다 — 포인터로는 아무것도 고를 수 없는 덱이 된다.
      onMouseDown={(event) => event.preventDefault()}
    >
      {sections.map((section) => (
        <React.Fragment key={section.id}>
          <p className="agent-chat-deck-category">
            <span>{t(SECTION_LABEL_KEY[section.id])}</span>
            <span className="agent-chat-deck-category-rule" aria-hidden="true" />
            <span className="agent-chat-deck-category-count">{String(section.entries.length)}</span>
          </p>
          {section.entries.map((entry) => {
            index += 1;
            const rowIndex = index;
            const active = rowIndex === activeIndex;
            const descriptionId = entry.description.length > 0 ? `${optionId(rowIndex)}-desc` : undefined;
            return (
              <button
                key={`${section.id}:${entry.name}`}
                type="button"
                id={optionId(rowIndex)}
                ref={active ? activeRef : undefined}
                className={`agent-chat-deck-row${active ? " is-active" : ""}`}
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
                <span className="agent-chat-deck-glyph" aria-hidden="true">
                  {token.kind === "agent" ? "◎" : section.id === "skills" ? "◇" : "›"}
                </span>
                <span className="agent-chat-deck-main">
                  <span className="agent-chat-deck-name">
                    {token.kind === "agent" ? entry.name : `/${entry.name}`}
                  </span>
                  {entry.description.length > 0 ? (
                    <span className="agent-chat-deck-desc" id={descriptionId}>{entry.description}</span>
                  ) : null}
                </span>
                {entry.argumentHint.length > 0 ? (
                  <span className="agent-chat-deck-hint">{entry.argumentHint}</span>
                ) : null}
              </button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
