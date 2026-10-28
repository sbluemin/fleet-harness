import { useEffect, useMemo, useState } from "react";
import type { ConversationSpeaker, ConversationParticipant } from "../../execution/shared/conversation/types.js";
import type { AgentConversationEntry } from "../../execution/shared/chat-renderer.js";
import { commodoreChatEntries } from "./commodore-chat.js";
import { commodoreLedgerRenderer, loadCommodore, loadTranscript, transcriptNeeded, useCommodore } from "./commodore-state.js";
import { useCommodoreObjectiveIndex, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { getT } from "./i18n/index.js";

/** 전언의 양쪽을 명부에 싣는다. 이름이 바뀌어도 사령관 UUID가 같은 참여자다. */
export function commodoreParticipants(speaker: ConversationSpeaker, turning: boolean, entries: readonly AgentConversationEntry[]): readonly ConversationParticipant[] {
  const peers = new Map<string, ConversationSpeaker>();
  for (const entry of entries) if (entry.kind === "delegation") {
    for (const peer of [entry.sender, ...entry.recipients]) if (peer.commodoreId && peer.commodoreId !== speaker.commodoreId) peers.set(peer.commodoreId, peer);
  }
  return [{ speaker, activity: turning ? "running" : "idle" }, ...[...peers.values()].map((peer) => ({ speaker: peer, activity: "unknown" as const }))];
}

/** 다른 사령관의 기록도 같은 공개 원장 렌더러로 연다. 메시지 입력과 쓰기 동작은 주지 않는다. */
export function CommodorePeerLedger({ speaker, language, onBack }: { readonly speaker: ConversationSpeaker; readonly language: "en" | "ko"; readonly onBack: () => void }) {
  const id = speaker.commodoreId!;
  const t = getT(language);
  const { entries, live, view, hasMore } = useCommodore(id);
  const index = useCommodoreObjectiveIndex(id);
  const references = useCommodoreReferenceHost(t, id);
  const [loading, setLoading] = useState(false);
  useEffect(() => { void loadCommodore(id); if (transcriptNeeded(id)) void loadTranscript(id); }, [id]);
  const chat = useMemo(() => commodoreChatEntries(t, id, entries, live, view?.state.asks, index), [t, id, entries, live, view?.state.asks, index]);
  const Ledger = commodoreLedgerRenderer();
  if (!Ledger) return null;
  return <Ledger speaker={speaker} commodoreId={id} language={language} onBack={onBack} entries={chat} references={references}
    older={hasMore ? { label: t("commodore.log.older"), loading, load: () => { setLoading(true); void loadTranscript(id, { older: true }).finally(() => setLoading(false)); } } : null}
    coordinates={view?.run.session ? { model: view.run.session.model, effort: view.run.session.effort ?? null } : null} openui />;
}
