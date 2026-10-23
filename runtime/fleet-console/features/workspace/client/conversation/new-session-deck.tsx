import type { ReactNode } from "react";
import { ComposerDeck, ComposerDeckBand, ComposerDeckEmpty, ComposerDeckGroup, ComposerDeckRow } from "../../../execution/client/composer-primitives/deck.js";

/**
 * 새 세션 컴포저의 '/' 명령·값과 '@' 보낼 곳 목록 — SDK 컴포저 덱(`ComposerDeck`, 퀵 런치바 문법)에 싣는다. 덱은 캡슐 위에
 * 떠서 열리고, 위가 모자라면 아래로 뒤집는다. 여기는 목록의 모양(묶음·띠·행)을 SDK 부품으로 옮기는 일만 한다.
 *
 * 포커스는 입력에 남는다. 목록은 listbox 이고 입력이 aria-activedescendant 로 활성 행을 가리킨다.
 */
export type NewSessionDeckItem =
  | { readonly kind: "section"; readonly key: string; readonly label: string; readonly note?: string | null }
  | { readonly kind: "band"; readonly key: string; readonly label: ReactNode; readonly lead?: ReactNode; readonly sticky?: boolean; readonly className?: string }
  | NewSessionDeckRow;

export interface NewSessionDeckRow {
  readonly kind: "row";
  readonly key: string;
  readonly icon?: ReactNode;
  readonly name: ReactNode;
  /** 지금 값(명령 행) 또는 보조 설명. */
  readonly value?: ReactNode;
  /** 오른쪽 끝의 타이핑 별칭(`/model`)이나 능력 문구(웹 읽기). */
  readonly token?: string | null;
  readonly checked?: boolean;
  /** 강도 행의 단계 톤 좌표 — 강도 트랙과 같은 data-effort-level 계약으로 색을 읽는다. */
  readonly level?: string;
  readonly apex?: boolean;
  /** 값이 아니라 게이트(숨은 강도)를 여닫는 행. 골라도 목록이 닫히지 않는다. */
  readonly gate?: boolean;
  /** 고를 수 없는 행(입력 대기 중인 Objective). 방향키가 건너뛴다. */
  readonly disabled?: boolean;
  readonly pick: () => void;
}

/** 목록의 모든 행(흐린 행 포함) — 덱 키 문법(`composerDeckKeyDown`)이 흐린 행을 건너뛴다. */
export function deckRows(items: readonly NewSessionDeckItem[]): readonly NewSessionDeckRow[] {
  return items.filter((item): item is NewSessionDeckRow => item.kind === "row");
}

export function deckOptionId(deckId: string, row: NewSessionDeckRow): string {
  return `${deckId}-${row.key}`;
}

/** 묶음 머리(section)부터 다음 머리 앞까지가 한 묶음이다. 머리 없이 시작한 행은 이름 없는 묶음 없이 그대로 선다. */
function groupItems(items: readonly NewSessionDeckItem[]): readonly { readonly head: Extract<NewSessionDeckItem, { kind: "section" }> | null; readonly items: readonly NewSessionDeckItem[] }[] {
  const groups: { head: Extract<NewSessionDeckItem, { kind: "section" }> | null; items: NewSessionDeckItem[] }[] = [];
  for (const item of items) {
    if (item.kind === "section") { groups.push({ head: item, items: [] }); continue; }
    if (groups.length === 0) groups.push({ head: null, items: [] });
    groups[groups.length - 1]!.items.push(item);
  }
  // 행이 하나도 없는 묶음은 머리를 세우지 않는다 — 빈 머리만 남기면 덱에 죽은 줄이 생긴다.
  return groups.filter((group) => group.items.some((item) => item.kind === "row"));
}

export function NewSessionDeck({ id, label, items, activeKey, emptyText, onHover }: {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NewSessionDeckItem[];
  readonly activeKey: string | null;
  readonly emptyText: string;
  readonly onHover: (key: string) => void;
}) {
  const groups = groupItems(items);
  const rowCount = groups.reduce((count, group) => count + group.items.filter((item) => item.kind === "row").length, 0);
  const renderItem = (item: NewSessionDeckItem) => {
    if (item.kind === "section") return null;
    if (item.kind === "band") return <ComposerDeckBand key={item.key} label={item.label} lead={item.lead} sticky={item.sticky} className={item.className} />;
    return (
      <ComposerDeckRow
        key={item.key}
        id={deckOptionId(id, item)}
        active={item.key === activeKey}
        disabled={item.disabled}
        lead={item.icon}
        name={item.name}
        value={item.value}
        token={item.token}
        checked={item.checked}
        className={item.gate ? "is-gate" : undefined}
        data-effort-level={item.level}
        data-apex={item.apex ? true : undefined}
        onPick={item.pick}
        onHover={() => onHover(item.key)}
      />
    );
  };
  return (
    <ComposerDeck id={id} label={label} listbox={rowCount > 0} contentKey={`${rowCount}:${groups.map((group) => group.head?.key ?? "").join(",")}`} className="new-session-deck">
      {rowCount === 0 ? <ComposerDeckEmpty>{emptyText}</ComposerDeckEmpty> : null}
      {groups.map((group, at) => group.head
        ? <ComposerDeckGroup key={group.head.key} label={group.head.label} note={group.head.note ?? undefined}>{group.items.map(renderItem)}</ComposerDeckGroup>
        : <div key={`lead-${at}`} className="fc-composer-deck-group" role="group">{group.items.map(renderItem)}</div>)}
    </ComposerDeck>
  );
}

/** 질의와 처음 일치하는 구간을 굵게 세운다(대소문자 무시). */
export function markMatch(text: string, query: string): ReactNode {
  if (query.length === 0) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}
