import { OpenUIPluginBoundary } from "../openui-boundary.js";
import type { AgentLedgerProps } from "../../../shared/chat-renderer.js";
import * as React from "react";
import { useChromeHeightProperty } from "@fleet-console/ui/react";

import { useChatReadingWidth } from "../../terminal/shared/terminal-preferences.js";
import { getT } from "../i18n/index.js";
import { useMobileSurface } from "../mobile-surface.js";
import { ChatReferenceContext } from "./chat-reference.js";
import { TranscriptLines, useTranscriptReveal } from "./chat-transcript.js";
import { MemberWidthButton, SessionCoordinate } from "./chat-view.js";
import { GroupLedgerFrame } from "./group/group-conversation.js";
import { getGroupT } from "./group/group-chat-i18n.js";
import { ConversationTheaterContext } from "./group/speaker-mark.js";
import { readAgentChatSessionCoordinates } from "./session-coordinates.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/** 바닥에 붙어 있다고 보는 여유 — 이 안이면 새 줄이 와도 바닥을 따라간다(채팅 로그와 같은 감각). */
const FOLLOW_SLACK_PX = 48;

/**
 * 참여자의 원장 — SDK `ctx.chat.Ledger` 의 호스트 구현. 그룹 대화가 지휘관 원장을 여는 그 모습을 플러그인 기록에 준다.
 *
 * 머리는 그룹 원장 틀(`GroupLedgerFrame`: 표식 · 「…의 원장 · 읽기 전용」 · 「대화로 돌아가기」)이고, 본문은 Operation 채팅의 면
 * (`.agent-chat` · 스크롤 주체인 `.agent-chat-log` · 같은 거터와 컬럼, 채팅 폭 선호)이며, 바닥은 구성원 원장과 같은 읽기 전용 좌표
 * 줄이다. 턴은 기록 면(`ctx.chat.Transcript`)과 같은 렌더러로 선다 — 둘의 차이는 담는 그릇뿐이다. 입력 틀은 서지 않는다.
 */
export function AgentLedger({ speaker, theaterId, language, onBack, entries, reveal = null, older = null, references, coordinates = null, openui = false, openUIOpen }: AgentLedgerProps) {
  const t = getT(language);
  const readingWidth = useChatReadingWidth();
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const footRef = React.useRef<HTMLDivElement | null>(null);
  // 모바일 화면이면 바닥 줄도 원장 위에 떠 있는 독이다 — 로그가 그 뒤까지 내려가고 바닥 줄 높이(`--m-dock-h`)만큼 아래를 비운다(chat.css).
  // 이 원장의 값으로 적어 두어, 바깥 대화 면이 적은 독 높이를 물려받지 않는다.
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const noTarget = React.useRef<HTMLElement | null>(null);
  useChromeHeightProperty(footRef, useMobileSurface() ? sectionRef : noTarget, "--m-dock-h");
  const follow = React.useRef(true);
  // 사령관·사람은 화면 언어의 이름으로 부른다 — 대화 화면(`useLocalizedSnapshot`)과 같은 이름이다.
  const groupT = getGroupT(language);
  const shown = speaker.kind === "commodore" ? { ...speaker, name: groupT("group.commodore") } : speaker;
  // 세션이 실제로 도는 좌표만 그린다 — 모르는 세션에 「기본」을 지어 세우면 다른 모델로 도는 세션을 잘못 말한다.
  const session = React.useMemo(() => (coordinates?.model ? readAgentChatSessionCoordinates({
    session: { model: coordinates.model, ...(coordinates.effort ? { effort: coordinates.effort } : {}) },
  }) : null), [coordinates?.model, coordinates?.effort]);

  // 처음 열면 가장 최근 턴이 보인다. 바닥에 있는 동안은 흐르는 턴을 따라 내려가고, 위로 읽고 있으면 자리를 지킨다.
  React.useLayoutEffect(() => {
    const node = logRef.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [entries]);
  useTranscriptReveal(logRef, reveal, () => { follow.current = false; });

  return (
    <OpenUIPluginBoundary port={openUIOpen} language={language}><ConversationTheaterContext.Provider value={theaterId ?? null}>
      <GroupLedgerFrame speaker={shown} language={language} onBack={onBack}>
        <div className="agent-ledger-host">
          <section
            ref={sectionRef}
            className="agent-chat agent-ledger"
            data-reading-width={readingWidth}
            style={{ "--agent-chat-font": "var(--font-code)" } as React.CSSProperties}
            aria-label={t("terminal.chat.aria")}
          >
            <div className="agent-chat-pane">
              <div className="agent-chat-body">
                <ChatReferenceContext.Provider value={references ?? null}>
                  <div
                    ref={logRef}
                    className="agent-chat-log"
                    role="log"
                    aria-label={t("terminal.chat.aria")}
                    aria-live="off"
                    onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK_PX; }}
                  >
                    {older ? <button type="button" className="group-chat-link agent-ledger-older" disabled={older.loading} onClick={older.load}>{older.label}</button> : null}
                    <TranscriptLines entries={entries} language={language} openui={openui} />
                  </div>
                </ChatReferenceContext.Provider>
              </div>
              <div className="agent-chat-member-foot" ref={footRef}>
                <div className="agent-chat-composer-meta">
                  {/* 세 칸 그리드(좌표 · 가운데 · 도구)라 좌표가 없어도 첫 칸은 비워 둔다 — 도구가 오른쪽 끝을 지킨다. */}
                  {session ? <SessionCoordinate coordinates={session} t={t} /> : <span aria-hidden="true" />}
                  <span className="agent-chat-composer-gap" aria-hidden="true" />
                  <span className="agent-chat-member-tools">
                    <MemberWidthButton hostRef={footRef} language={language} />
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </GroupLedgerFrame>
    </ConversationTheaterContext.Provider></OpenUIPluginBoundary>
  );
}
