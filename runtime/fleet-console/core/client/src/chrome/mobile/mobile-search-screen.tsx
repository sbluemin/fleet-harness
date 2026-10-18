import { useEffect, useMemo, useRef, useState } from "react";
import { useChromeHeightProperty } from "@fleet-console/sdk/react/browser";

import { useT } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { refreshOperationArchive, useOperationArchive } from "../../integration/operation-archive.js";
import { ArchiveRows, useArchiveRestore } from "./mobile-archive-screen.js";
import { ConversationRow, conversationStateWord, useMobileConversations } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { setMobileDestination } from "./mobile-store.js";

type SearchKind = "all" | "conversation" | "archived";
const KINDS: readonly SearchKind[] = ["all", "conversation", "archived"];

/**
 * 검색(S-41) — 모든 Theater를 가로질러 찾는다. 머리는 ✕와 입력칸, 그 아래 종류 칩(전체 · 대화 · 보관됨), 결과 행은 대화 행 문법에
 * 오른쪽 위에 종류 라벨(목표 대화 · 대화)과 보조 줄 「Theater · 상태 낱말」이다. 보관한 것은 복원 행으로 서고, 영구 삭제는 데스크톱이다.
 * `scope="archive"`는 보관함 화면의 🔍가 여는 보관함 안 검색(D34)이다 — 이쪽은 보관한 작업 제목만 찾는다.
 */
export function MobileSearchScreen({ state, scope, onBack }: { readonly state: ConsoleState; readonly scope?: "archive"; readonly onBack: () => void }) {
  return scope === "archive" ? <ArchiveSearch state={state} onBack={onBack} /> : <ConversationSearch state={state} onBack={onBack} />;
}

function ConversationSearch({ state, onBack }: { readonly state: ConsoleState; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind>("all");
  const conversations = useMobileConversations(state);
  const archive = useOperationArchive();
  const { busy, restored, restore } = useArchiveRestore();
  useEffect(() => { void refreshOperationArchive(); }, []);
  // 이 화면이 자기 머리(✕ · 입력칸)를 그린다 — 호스트 상단 막대는 숨긴다.
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", onBack, hidden: true });

  const needle = query.trim().toLowerCase();
  const found = useMemo(() => kind === "archived" ? [] : conversations
    .filter((conversation) => needle === "" || conversation.operation.title.toLowerCase().includes(needle))
    .sort((left, right) => right.operation.ts.updatedAt - left.operation.ts.updatedAt), [conversations, kind, needle]);
  const archived = useMemo(() => kind === "conversation" ? [] : (archive.snapshot?.entries ?? [])
    .filter((entry) => !restored.has(entry.operation.id) && (needle === "" || entry.operation.title.toLowerCase().includes(needle))), [archive.snapshot, kind, needle, restored]);

  // 입력칸과 종류 칩은 결과 위에 떠 있는 머리 하나다 — 결과가 그 높이(`--m-screen-head`)만큼 위를 비운다.
  const screenRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useChromeHeightProperty(headRef, screenRef, "--m-screen-head");

  return (
    <section ref={screenRef} className="mobile-search-screen is-conversations">
      <div ref={headRef} className="mobile-screen-head">
      <div className="mobile-conv-searchbar">
        <button type="button" data-press="r1" className="mobile-conv-round" onClick={onBack} aria-label={t("mobile.sheet.close")}><MobileIcon name="x" /></button>
        <label className="mobile-conv-searchfield">
          <MobileIcon name="search" size={20} />
          <input autoFocus value={query} placeholder={t("mobile.search.placeholder")} aria-label={t("mobile.search.aria")} spellCheck={false} autoComplete="off" type="search" onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className="mobile-conv-filters" role="group" aria-label={t("mobile.search.kindAria")}>
        {KINDS.map((item) => (
          <button type="button" key={item} data-press="r1" className={`mobile-conv-chip${kind === item ? " is-on" : ""}`} aria-pressed={kind === item} onClick={() => setKind(item)}>{t(`mobile.search.kind.${item}`)}</button>
        ))}
      </div>
      </div>
      <div className="mobile-conv-scroll">
        {found.map((conversation) => {
          const theater = state.theaters.find((item) => item.id === conversation.operation.theaterId);
          return (
            <ConversationRow
              key={conversation.operation.id}
              conversation={conversation}
              trailing={<span className="mobile-conv-kind">{t(conversation.isCluster ? "mobile.search.label.cluster" : "mobile.search.label.conversation")}</span>}
              sub={[theater?.label, conversationStateWord(conversation.face, t)].filter(Boolean).join(" · ")}
              onOpen={() => { setMobileDestination({ kind: "home" }); focusOperation(conversation.operation.id); }}
            />
          );
        })}
        {archived.length > 0 ? (
          <>
            <div className="mobile-conv-section"><span>{t("mobile.search.kind.archived")}</span></div>
            <ArchiveRows entries={archived} state={state} restore={restore} busy={busy} />
          </>
        ) : null}
        {found.length === 0 && archived.length === 0 ? <p className="mobile-conv-empty-note">{t("mobile.search.empty")}</p> : null}
      </div>
    </section>
  );
}

/** 보관함 안 검색(D34): 보관한 작업 제목에서 찾고, 결과 행에서 복원한다. */
function ArchiveSearch({ state, onBack }: { readonly state: ConsoleState; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const archive = useOperationArchive();
  const { busy, restored, restore } = useArchiveRestore();
  useEffect(() => { void refreshOperationArchive(); }, []);
  const archived = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (archive.snapshot?.entries ?? []).filter((entry) => !restored.has(entry.operation.id) && (needle === "" || entry.operation.title.toLowerCase().includes(needle)));
  }, [archive.snapshot, query, restored]);
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", onBack });
  return (
    <section className="mobile-search-screen">
      <div className="mobile-search-field">
        <input className="mobile-field" autoFocus value={query} placeholder={t("mobile.search.placeholderArchive")} aria-label={t("mobile.search.ariaArchive")} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {archived.length === 0 ? <p className="mobile-attention-empty">{t("mobile.search.emptyArchive")}</p> : <ArchiveRows entries={archived} state={state} restore={restore} busy={busy} />}
    </section>
  );
}
