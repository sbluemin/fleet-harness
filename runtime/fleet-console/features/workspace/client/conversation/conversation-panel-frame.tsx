import type { ReactNode } from "react";
import type { ConversationPanelLayout } from "../../shared/conversation-surfaces.js";

/**
 * 대화 중심 화면 오른쪽 패널의 본문 틀 — 패널 머리(ConversationPanelHeader)를 세우는 쪽이 본문 축의 기본값도 갖는다.
 * Theater Inbox 칸과 가운데 대화의 탭이 같은 틀을 쓴다. 기본(`read`)은 머리와 같은 축의 가운데 읽기 열이고 세로 스크롤을 틀이
 * 맡는다(스크롤바는 패널 가장자리). 폭은 창이 아니라 이 칸의 폭(container)을 따르므로 새 칸·탭은 CSS 없이도 대응한다.
 * 스크롤·폭을 스스로 가져야 하는 본문만 `fill` 로 칸 전체를 받는다. `footer` 는 틀 밖 맨 아래에 붙어 늘 보인다(「적용」 줄).
 */
export function ConversationPanelFrame({ layout = "read", footer, children }: {
  readonly layout?: ConversationPanelLayout | undefined;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="conversation-panel-page">
      <div className="conversation-panel-frame" data-layout={layout === "fill" ? "fill" : "read"}>{children}</div>
      {footer}
    </div>
  );
}
