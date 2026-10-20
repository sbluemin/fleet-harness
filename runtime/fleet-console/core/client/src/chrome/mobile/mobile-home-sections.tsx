import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { operationAvatarKey } from "@fleet-console/sdk/avatars";
import type { OperationCluster } from "@fleet-console/sdk/plugin";
import type { RailEntryFinishedItem } from "@fleet-console/sdk/rail";

import { KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { useOperationClusters, type ClusterIndex } from "../../../../../features/workspace/client/operation-clusters.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";
import { entryIconOf } from "./mobile-destinations.js";
import { ConversationRow, ConversationSummary, type MobileConversation } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";

/**
 * 홈 「대화」 아래의 두 접기 — 「시작 전 N」(기본 펼침)과 「완료 N」(기본 접힘). 둘 다 0개면 서지 않는다.
 * 「시작 전」은 데스크톱 사이드바의 「시작 전 N」 접기와 같은 원천이다: 지금 Theater의 뿌리 없는 묶음 줄(`OperationCluster.row.glyph === "fresh"`) 가운데
 * 사람 차례의 결정 요청 줄(`decisionRequestedAt`, 「확인 필요」에 선다)을 뺀 것, 줄 순서(`row.order`)대로. 맡은 이가 처리 중인 줄(`delegated`)은
 * 폰에는 그 줄이 설 다른 자리가 없어 여기서 빼면 어디에도 보이지 않으므로 남긴다(이 접기는 기본으로 펼쳐 있다). 누르면 묶음의 `open()`이 그 일의 시작 화면을 연다.
 * 「완료 N」은 세 출처를 이 순서로 모은다: 묶음 줄이 「완료」인 대화(`isFinishedConversation`, 갱신 시각순) · 뿌리 없는 완료 줄(`row.order`) ·
 * 엔트리가 `mobile.finished`로 올린 끝난 일(선언 순서). 데스크톱 사이드바 「완료」 접기와 같은 원천(`row.glyph === "done"`)이다.
 * 호스트는 어느 플러그인의 것인지 읽지 않고 줄과 선언만 그린다.
 */
export function MobileHomeSections({ theaterId, finishedConversations, onOpenConversation }: {
  readonly theaterId: string | null;
  readonly finishedConversations: readonly MobileConversation[];
  readonly onOpenConversation: (conversation: MobileConversation) => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const clusters = useOperationClusters();
  const bindings = useRailEntries();
  const finished = useFinishedItems(bindings, theaterId, locale);
  const fresh = useMemo(() => clusters
    .filter((cluster) => cluster.theaterId === theaterId && cluster.root === undefined && cluster.row?.glyph === "fresh" && cluster.row.decisionRequestedAt === undefined)
    .sort((left, right) => (left.row?.order ?? 0) - (right.row?.order ?? 0)), [clusters, theaterId]);
  // 지휘관 Operation이 사라졌지만 보관되지 않은 완료 줄 — 대화 행이 없어 여기서만 보인다.
  const doneRows = useMemo(() => clusters
    .filter((cluster) => cluster.theaterId === theaterId && cluster.root === undefined && cluster.row?.glyph === "done" && cluster.row.decisionRequestedAt === undefined)
    .sort((left, right) => (left.row?.order ?? 0) - (right.row?.order ?? 0)), [clusters, theaterId]);
  const finishedCount = finishedConversations.length + doneRows.length + finished.length;
  const [freshOpen, setFreshOpen] = useFold("fresh", true);
  const [finishedOpen, setFinishedOpen] = useFold("finished", false);

  return (
    <>
      {fresh.length > 0 ? (
        <>
          <FoldHead kind="fresh" label={t("mobile.list.fresh", { count: fresh.length })} open={freshOpen} onToggle={() => setFreshOpen(!freshOpen)} />
          {freshOpen ? fresh.map((cluster) => (
            <MobileMarkedRow key={cluster.id} mark={cluster.row?.mark}>
              <HomeRow
                avatar={<KeyedAvatar avatarKey={operationAvatarKey(cluster.avatarOperationId ?? cluster.id)} role="commander" state="fresh" size={52} label="" decorative />}
                title={cluster.title}
                sub={<><span className="mobile-conv-state is-fresh">{t("mobile.search.state.fresh")}</span>{rowDetail(cluster, locale)}</>}
                onOpen={() => cluster.open?.()}
              />
            </MobileMarkedRow>
          )) : null}
        </>
      ) : null}
      {finishedCount > 0 ? (
        <>
          <FoldHead kind="finished" label={t("mobile.list.finished", { count: finishedCount })} open={finishedOpen} onToggle={() => setFinishedOpen(!finishedOpen)} />
          {finishedOpen ? finishedConversations.map((conversation) => {
            // 완료 지휘관의 얼굴은 활동만 읽어 「쉼/끝남」으로 보인다 — 이 접기 안에서는 묶음 줄의 「완료」로 덮는다.
            const shown = { ...conversation, face: "done" as const };
            return <ConversationRow key={conversation.operation.id} conversation={shown} sub={<ConversationSummary conversation={shown} />} onOpen={() => onOpenConversation(conversation)} />;
          }) : null}
          {finishedOpen ? doneRows.map((cluster) => (
            <MobileMarkedRow key={cluster.id} mark={cluster.row?.mark}>
              <HomeRow
                avatar={<KeyedAvatar avatarKey={operationAvatarKey(cluster.avatarOperationId ?? cluster.id)} role="commander" state="done" size={52} label="" decorative />}
                title={cluster.title}
                sub={<><span className="mobile-conv-state is-done">{t("mobile.search.state.done")}</span>{rowDetail(cluster, locale)}</>}
                onOpen={() => cluster.open?.()}
              />
            </MobileMarkedRow>
          )) : null}
          {finishedOpen ? finished.map(({ entryId, item }) => (
            <HomeRow
              key={`${entryId}:${item.id}`}
              avatar={item.avatarOperationId !== undefined
                ? <KeyedAvatar avatarKey={operationAvatarKey(item.avatarOperationId)} role="commander" state="done" size={52} label="" decorative />
                : <span className="mobile-conv-round is-static">{entryIconOf(bindings, entryId)}</span>}
              title={item.title}
              sub={<><span className="mobile-conv-state is-done">{t("mobile.search.state.done")}</span>{item.detail ? ` · ${item.detail}` : null}</>}
              onOpen={item.open}
            />
          )) : null}
        </>
      ) : null}
    </>
  );
}

function FoldHead({ kind, label, open, onToggle }: { readonly kind: "fresh" | "finished"; readonly label: string; readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <div className="mobile-conv-section is-fold" data-mobile-fold={kind}>
      <button type="button" data-press="r1" aria-expanded={open} onClick={onToggle}>
        {label}<MobileIcon name={open ? "down" : "right"} size={16} />
      </button>
    </div>
  );
}

/** 대화 행과 같은 문법의 한 줄 — 아바타 · 제목 · 둘째 줄. 시각 칸은 없다(대화가 아니다). */
function HomeRow({ avatar, title, sub, onOpen }: { readonly avatar: ReactNode; readonly title: string; readonly sub: ReactNode; readonly onOpen: () => void }) {
  return (
    <button type="button" data-press="r1" className="mobile-conv-row" onClick={onOpen}>
      <span className="mobile-conv-row-av">{avatar}</span>
      <span className="mobile-conv-row-copy">
        <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{title}</span></span>
        <span className="mobile-conv-row-sub">{sub}</span>
      </span>
    </button>
  );
}

const dueFormats = new Map<ConsoleLocale, Intl.DateTimeFormat>();
/** 시작 전·완료 줄의 둘째 줄 꼬리 — 기한과 플러그인이 붙인 짧은 사실(`row.notes`). 사이드바 줄이 쓰는 것과 같은 필드다. */
function rowDetail(cluster: OperationCluster, locale: ConsoleLocale): string {
  const parts: string[] = [];
  const due = cluster.row?.due;
  if (due) {
    const parsed = new Date(`${due.date}T00:00:00`);
    let format = dueFormats.get(locale);
    if (!format) { format = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" }); dueFormats.set(locale, format); }
    parts.push(Number.isNaN(parsed.getTime()) ? due.date : format.format(parsed));
  }
  for (const note of cluster.row?.notes ?? []) {
    const text = resolveLocalizedText(note.text, locale);
    if (text) parts.push(text);
  }
  return parts.map((part) => ` · ${part}`).join("");
}

/**
 * 대화 행이 「대화」 대신 「완료 N」에 드는가 — 그 Operation이 뿌리인 묶음 줄이 「완료」이고 사람 차례의 결정 요청이 없을 때.
 * 남의 줄에 fold로 든 Operation은 거른다. 사람을 기다리는 대화는 판정 전에 「확인 필요」로 빠진다.
 */
export function isFinishedConversation(index: ClusterIndex, operationId: string): boolean {
  const layout = index.rowOf.get(operationId);
  const row = layout?.cluster.row;
  return layout?.cluster.root === operationId && row?.glyph === "done" && row.decisionRequestedAt === undefined;
}

// 접기 상태는 보는 사람의 편의라 메모리에만 둔다 — 대화를 열었다 돌아와도 펼친 자리가 그대로이고, 새로 열면 기본값이다.
const folds = new Map<string, boolean>();
function useFold(key: string, initial: boolean): readonly [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(() => folds.get(key) ?? initial);
  return [open, (next) => { folds.set(key, next); setOpen(next); }];
}

/** 엔트리들이 `mobile.finished`로 올린 끝난 일 — 각 공급원의 구독을 하나의 틱으로 묶고, 값(id·제목·둘째 줄)이 같으면 다시 그리지 않는다. */
function useFinishedItems(bindings: readonly RailEntryBinding[], theaterId: string | null, locale: ConsoleLocale): readonly { readonly entryId: string; readonly item: RailEntryFinishedItem }[] {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.finished ? [binding.entry.mobile.finished.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => finishedVersion(bindings, theaterId, locale),
    () => finishedVersion(bindings, theaterId, locale),
  );
  return useMemo(() => bindings.flatMap((binding) => {
    if (!binding.entry.mobile?.finished || binding.entry.visible?.() === false) return [];
    return binding.entry.mobile.finished.items(scopeOf(binding, theaterId), locale).map((item) => ({ entryId: binding.entry.id, item }));
  }), // eslint-disable-next-line react-hooks/exhaustive-deps -- key는 끝난 일이 바뀌었다는 신호다.
  [bindings, theaterId, locale, key]);
}

function scopeOf(binding: RailEntryBinding, theaterId: string | null): string | null {
  return binding.entry.scope === "fleet" ? null : theaterId;
}

function finishedVersion(bindings: readonly RailEntryBinding[], theaterId: string | null, locale: ConsoleLocale): string {
  return bindings.map((binding) => {
    const finished = binding.entry.mobile?.finished;
    if (!finished || binding.entry.visible?.() === false) return "";
    return `${binding.entry.id}:${finished.items(scopeOf(binding, theaterId), locale).map((item) => `${item.id}\u0001${item.title}\u0001${item.detail ?? ""}\u0001${item.avatarOperationId ?? ""}`).join("\u0002")}`;
  }).join("|");
}
