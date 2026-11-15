import { useSyncExternalStore } from "react";

import type { ConversationViewMode, ObjectiveRecord } from "../../../../../../core/client/src/integration/types.js";
import { createServerSyncedValue } from "../../../../../workspace/client/commander-tab/commander-server-sync.js";
import { getGroupT } from "./group-chat-i18n.js";

import "./group-chat.css";

/**
 * 그룹 대화(지휘관·구성원)의 가운데 칸 화면 — 그룹채팅이냐 원장 분할이냐.
 *
 * 모든 지휘관·구성원 대화에 공통이고(Objective 별이 아니다) 원천은 settings.json(`general.conversationView`)이다. Console 포트는
 * 재시작마다 바뀔 수 있어 origin 이 갈리므로 같은 origin 캐시(localStorage)를 두지 않는다 — 서버 값을 받기 전에는 기본(그룹채팅)이다.
 * 저장의 직렬화·실패 되돌림은 지휘관 목록 설정과 같은 길(`createServerSyncedValue`)을 쓴다.
 */
const DEFAULT_VIEW: ConversationViewMode = "chat";

function parseView(value: unknown): ConversationViewMode | null {
  return value === "chat" || value === "ledger" ? value : null;
}

const syncedView = createServerSyncedValue<ConversationViewMode>({
  field: "conversationView",
  defaultValue: DEFAULT_VIEW,
  readCache: () => DEFAULT_VIEW,
  writeCache: () => undefined,
  parseServerValue: parseView,
  equal: (left, right) => left === right,
  isDefault: (value) => value === DEFAULT_VIEW,
});

/** 동기 읽기 — 서버 값을 받기 전·실패 시에는 그룹채팅이다. */
export function readGroupConversationView(): ConversationViewMode {
  return syncedView.get();
}

export function setGroupConversationView(next: ConversationViewMode): void {
  syncedView.set(next);
}

export function useGroupConversationView(): ConversationViewMode {
  return useSyncExternalStore(syncedView.subscribe, syncedView.get, syncedView.get);
}

/**
 * 머리 줄 도구 묶음(알림 종 오른쪽)의 세로 구분선과 그룹채팅/원장 전환 단추. 그룹 대화에서만 선다 — 판정은 설치(`install.tsx`)가 한다.
 * 누르면 개별 원장(「구성원」 탭에서 고른 참여자)을 내리고 다른 화면으로 바꾼다.
 */
export function ConversationViewToggle({ root, language, onLeaveLedger }: {
  readonly root: ObjectiveRecord;
  readonly language: "en" | "ko";
  readonly onLeaveLedger: (rootId: string) => void;
}) {
  const view = useGroupConversationView();
  const t = getGroupT(language);
  const ledger = view === "ledger";
  const tip = t(ledger ? "group.view.toChat" : "group.view.toLedger");
  return (
    <>
      <span className="group-view-divider" aria-hidden="true" />
      <button
        type="button"
        className={`right-rail-ico group-view-toggle${ledger ? " is-active" : ""}`}
        aria-pressed={ledger}
        aria-label={t("group.view.toggle")}
        data-tip={tip}
        onClick={() => {
          onLeaveLedger(root.id);
          setGroupConversationView(ledger ? "chat" : "ledger");
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
          <path d="M8 2.5v11M2 8h12" />
        </svg>
      </button>
    </>
  );
}
