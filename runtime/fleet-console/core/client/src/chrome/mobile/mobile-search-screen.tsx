import { useEffect, useMemo, useRef, useState } from "react";
import { useChromeHeightProperty } from "@fleet-console/ui/react";

import { commodoreSectionLabel, selectMobileCommodore, useCommodoreList } from "../../../../../features/commodore/client/commodore-list.js";
import { openTaskforce, TaskforceStack } from "../../../../../features/commodore/client/taskforce/taskforce.js";
import { useTaskforceExperiment, useTaskforces } from "../../../../../features/commodore/client/taskforce/state.js";
import { theaterFolderName, theaterLabelOf } from "../../../../../features/commodore/client/theater-owner.js";
import { KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { useObjectiveClusters } from "../../../../../features/workspace/client/objective-clusters.js";
import { commodoreAvatarKey, objectiveRecordAvatarKey } from "../../../../../features/workspace/shared/avatars.js";
import { useT } from "../../i18n/index.js";
import { focusObjective } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { refreshObjectiveArchive, useObjectiveArchive } from "../../integration/objective-archive.js";
import { ArchiveRows, useArchiveRestore } from "./mobile-archive-screen.js";
import { ConversationRow, conversationStateWord, useMobileConversations } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { setMobileDestination, setMobileListTheater, setMobileReturnDestination } from "./mobile-store.js";

type SearchKind = "all" | "commodore" | "conversation" | "archived";
const KINDS: readonly SearchKind[] = ["all", "commodore", "conversation", "archived"];

/**
 * 통합 검색(S-41) — 사령관·TaskForce·진행/미시작 목표·보관된 목표를 한곳에서 찾는다.
 * `scope="archive"`는 보관함 화면의 🔍가 여는 보관함 안 검색(D34)이다 — 이쪽은 보관한 작업 제목만 찾는다.
 */
export function MobileSearchScreen({ state, scope, onBack }: { readonly state: ConsoleState; readonly scope?: "archive"; readonly onBack: () => void }) {
  return scope === "archive" ? <ArchiveSearch state={state} onBack={onBack} /> : <ConversationSearch state={state} onBack={onBack} />;
}

function ConversationSearch({ state, onBack }: { readonly state: ConsoleState; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind>("all");
  const commodores = useCommodoreList();
  const taskforceExperiment = useTaskforceExperiment();
  const taskforces = useTaskforces();
  const conversations = useMobileConversations(state);
  const clusters = useObjectiveClusters();
  const archive = useObjectiveArchive();
  const { busy, restored, restore } = useArchiveRestore();
  useEffect(() => { void refreshObjectiveArchive(); }, []);
  // 이 화면이 자기 머리(✕ · 입력칸)를 그린다 — 호스트 상단 막대는 숨긴다.
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", onBack, hidden: true });

  const fallbackCommodore = t("sidebar.commodore.fallback");
  const commodoreNameById = useMemo(
    () => new Map(commodores.map((commodore) => [commodore.commodoreId, commodoreSectionLabel(commodore, fallbackCommodore)] as const)),
    [commodores, fallbackCommodore],
  );

  const needle = query.trim().toLowerCase();
  const foundCommodores = useMemo(() => (kind !== "all" && kind !== "commodore") ? [] : commodores.filter((commodore) => {
    if (needle === "") return true;
    const name = commodoreSectionLabel(commodore, fallbackCommodore).toLowerCase();
    if (name.includes(needle)) return true;
    return commodore.theaters.some((theater) => theater.label.toLowerCase().includes(needle));
  }), [commodores, fallbackCommodore, kind, needle]);

  const foundTaskforces = useMemo(() => (!taskforceExperiment.enabled || (kind !== "all" && kind !== "commodore")) ? [] : taskforces.filter((tf) => {
    if (needle === "") return true;
    return tf.name.toLowerCase().includes(needle) || (tf.topic?.toLowerCase().includes(needle) ?? false);
  }), [kind, needle, taskforceExperiment.enabled, taskforces]);

  const found = useMemo(() => (kind !== "all" && kind !== "conversation") ? [] : conversations
    .filter((conversation) => {
      if (needle === "") return true;
      if (conversation.objectiveRecord.title.toLowerCase().includes(needle)) return true;
      const owner = conversation.objectiveRecord.commodoreId ? commodoreNameById.get(conversation.objectiveRecord.commodoreId) : undefined;
      return owner ? owner.toLowerCase().includes(needle) : false;
    })
    .sort((left, right) => right.objectiveRecord.ts.updatedAt - left.objectiveRecord.ts.updatedAt), [commodoreNameById, conversations, kind, needle]);

  const foundFresh = useMemo(() => (kind !== "all" && kind !== "conversation") ? [] : clusters.filter((cluster) => {
    if (cluster.root || !cluster.row || cluster.row.commodore || cluster.row.glyph === "done") return false;
    if (needle === "") return true;
    if (cluster.title.toLowerCase().includes(needle)) return true;
    const owner = cluster.commodoreId ? commodoreNameById.get(cluster.commodoreId) : undefined;
    return owner ? owner.toLowerCase().includes(needle) : false;
  }), [clusters, commodoreNameById, kind, needle]);

  const archived = useMemo(() => (kind !== "all" && kind !== "archived") ? [] : (archive.snapshot?.entries ?? [])
    .filter((entry) => !restored.has(entry.objectiveRecord.id) && (needle === "" || entry.objectiveRecord.title.toLowerCase().includes(needle))), [archive.snapshot, kind, needle, restored]);

  const hasAny = foundCommodores.length > 0 || foundTaskforces.length > 0 || found.length > 0 || foundFresh.length > 0 || archived.length > 0;

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
        {foundCommodores.length > 0 || foundTaskforces.length > 0 ? (
          <>
            <div className="mobile-conv-section"><span>{t("mobile.search.kind.commodore")}</span></div>
            {foundCommodores.map((commodore) => {
              const name = commodoreSectionLabel(commodore, fallbackCommodore);
              const sub = commodore.last?.text ?? (commodore.theaters.map((th) => th.label).join(" · ") || t("mobile.home.noMessage"));
              return (
                <button
                  key={commodore.commodoreId}
                  type="button"
                  data-press="r1"
                  className="mobile-conv-row"
                  onClick={() => {
                    setMobileReturnDestination(null);
                    selectMobileCommodore(commodore.commodoreId);
                    const home = commodore.theaters.find((theater) => theater.status === "available")?.theaterId ?? null;
                    if (home) setMobileListTheater({ commodoreId: commodore.commodoreId, theaterId: home });
                    setMobileDestination({ kind: "plugin", entryId: "commodore", params: { commodoreId: commodore.commodoreId } });
                  }}
                >
                  <span className="mobile-conv-row-av"><KeyedAvatar avatarKey={commodoreAvatarKey(commodore.commodoreId)} role="commodore" state="idle" size={52} label="" decorative /></span>
                  <span className="mobile-conv-row-copy">
                    <span className="mobile-conv-row-top">
                      <span className="mobile-conv-row-title">{name}</span>
                      <span className="mobile-conv-kind">{t("mobile.search.label.commodore")}</span>
                    </span>
                    <span className="mobile-conv-row-sub">{sub}</span>
                  </span>
                </button>
              );
            })}
            {foundTaskforces.map((tf) => (
              <button key={tf.id} type="button" data-press="r1" className="mobile-conv-row" onClick={() => openTaskforce(tf.id)}>
                <span className="mobile-conv-row-av"><TaskforceStack members={tf.members} /></span>
                <span className="mobile-conv-row-copy">
                  <span className="mobile-conv-row-top">
                    <span className="mobile-conv-row-title">{tf.name}</span>
                    <span className="mobile-conv-kind">TaskForce</span>
                  </span>
                  <span className="mobile-conv-row-sub">{tf.preview?.text.trim() || tf.topic || t("mobile.home.noMessage")}</span>
                </span>
              </button>
            ))}
          </>
        ) : null}
        {found.length > 0 || foundFresh.length > 0 ? (
          <>
            <div className="mobile-conv-section"><span>{t("mobile.search.kind.conversation")}</span></div>
            {found.map((conversation) => {
              const ownerLabel = conversation.objectiveRecord.commodoreId ? commodoreNameById.get(conversation.objectiveRecord.commodoreId) : undefined;
              const theaterLabel = theaterLabelOf(
                conversation.objectiveRecord.commodoreId,
                conversation.objectiveRecord.theaterId,
                theaterFolderName(typeof conversation.objectiveRecord.cwd === "string" ? conversation.objectiveRecord.cwd : null),
              );
              return (
                <ConversationRow
                  key={conversation.objectiveRecord.id}
                  conversation={conversation}
                  trailing={<span className="mobile-conv-kind">{t(conversation.isCluster ? "mobile.search.label.cluster" : "mobile.search.label.conversation")}</span>}
                  sub={[ownerLabel ?? theaterLabel, conversationStateWord(conversation.face, t)].filter(Boolean).join(" · ")}
                  onOpen={() => { setMobileReturnDestination(null); setMobileDestination({ kind: "home" }); focusObjective(conversation.objectiveRecord.id); }}
                />
              );
            })}
            {foundFresh.map((cluster) => {
              const ownerLabel = cluster.commodoreId ? commodoreNameById.get(cluster.commodoreId) : undefined;
              return (
                <button
                  key={cluster.id}
                  type="button"
                  data-press="r1"
                  className="mobile-conv-row"
                  onClick={() => {
                    setMobileReturnDestination(null);
                    if (cluster.commodoreId) selectMobileCommodore(cluster.commodoreId);
                    cluster.open?.();
                  }}
                >
                  <span className="mobile-conv-row-av">
                    <KeyedAvatar avatarKey={objectiveRecordAvatarKey(cluster.avatarObjectiveId ?? cluster.id)} role="commander" state="fresh" size={52} label="" decorative />
                  </span>
                  <span className="mobile-conv-row-copy">
                    <span className="mobile-conv-row-top">
                      <span className="mobile-conv-row-title">{cluster.title}</span>
                      <span className="mobile-conv-kind">{t("mobile.search.label.fresh")}</span>
                    </span>
                    <span className="mobile-conv-row-sub">{[ownerLabel, t("mobile.search.state.fresh")].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
        {archived.length > 0 ? (
          <>
            <div className="mobile-conv-section"><span>{t("mobile.search.kind.archived")}</span></div>
            <ArchiveRows entries={archived} state={state} restore={restore} busy={busy} />
          </>
        ) : null}
        {!hasAny ? <p className="mobile-conv-empty-note">{t("mobile.search.empty")}</p> : null}
      </div>
    </section>
  );
}

/** 보관함 안 검색(D34): 보관한 작업 제목에서 찾고, 결과 행에서 복원한다. */
function ArchiveSearch({ state, onBack }: { readonly state: ConsoleState; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const archive = useObjectiveArchive();
  const { busy, restored, restore } = useArchiveRestore();
  useEffect(() => { void refreshObjectiveArchive(); }, []);
  const archived = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (archive.snapshot?.entries ?? []).filter((entry) => !restored.has(entry.objectiveRecord.id) && (needle === "" || entry.objectiveRecord.title.toLowerCase().includes(needle)));
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
