import { useEffect, type ReactNode } from "react";

/**
 * 새 세션 캡슐 안 목록 — '/' 명령·값과 '@' 보낼 곳이 같은 목록 하나에 선다(승인안 S3: 떠 있는 팝오버 없이 목록이 입력 줄 위에
 * 서고 캡슐이 위로 자란다).
 *
 * 행은 채팅 컴포저 덱과 같은 문법이다: [아이콘][이름][지금 값][토큰]. 섹션 라벨은 조용한 글자 한 줄이고, 활성 행은 테두리 없이
 * 중립 채움(--wash-selected)으로만 선다 — 위치 채널(brass)은 캡슐의 포커스 링이 이미 쥐고 있다.
 *
 * 포커스는 입력에 남는다. 목록은 listbox 이고 입력이 aria-activedescendant 로 활성 행을 가리킨다. 행을 누르는 마우스는
 * 포커스를 빼앗지 않는다(mousedown 기본 동작을 막는다).
 */
export type NewSessionDeckItem =
  | { readonly kind: "section"; readonly key: string; readonly label: string; readonly note?: string | null }
  | { readonly kind: "band"; readonly key: string; readonly label: ReactNode }
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
  /** 고를 수 없는 행(입력 대기 중인 Operation). 방향키가 건너뛴다. */
  readonly disabled?: boolean;
  readonly pick: () => void;
}

export function deckRows(items: readonly NewSessionDeckItem[]): readonly NewSessionDeckRow[] {
  return items.filter((item): item is NewSessionDeckRow => item.kind === "row" && item.disabled !== true);
}

export function deckOptionId(deckId: string, row: NewSessionDeckRow): string {
  return `${deckId}-${row.key}`;
}

export function NewSessionDeck({ id, label, items, activeKey, emptyText, onHover }: {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NewSessionDeckItem[];
  readonly activeKey: string | null;
  readonly emptyText: string;
  readonly onHover: (key: string) => void;
}) {
  // 잘린 목록에서 하이라이트만 움직이면 활성 행이 보이지 않는다 — 방향키 인덱스와 짝으로 nearest 스크롤한다.
  useEffect(() => {
    if (activeKey === null) return;
    document.getElementById(`${id}-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey, id]);
  const hasRows = items.some((item) => item.kind === "row");
  return (
    <div className="new-session-deck" id={id} role="listbox" aria-label={label}>
      {hasRows ? null : <p className="new-session-deck-empty">{emptyText}</p>}
      {items.map((item) => {
        if (item.kind === "section") {
          return (
            <p key={item.key} className="new-session-deck-section" role="presentation">
              {item.label}
              {item.note ? <span className="new-session-deck-note">{item.note}</span> : null}
            </p>
          );
        }
        if (item.kind === "band") return <p key={item.key} className="new-session-deck-band" role="presentation">{item.label}</p>;
        const active = item.key === activeKey;
        return (
          <button
            key={item.key}
            id={deckOptionId(id, item)}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={active}
            aria-disabled={item.disabled ? true : undefined}
            className={`new-session-deck-row${active ? " is-active" : ""}${item.gate ? " is-gate" : ""}`}
            data-effort-level={item.level}
            data-apex={item.apex ? true : undefined}
            disabled={item.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => { if (!active && !item.disabled) onHover(item.key); }}
            onClick={() => { if (!item.disabled) item.pick(); }}
          >
            <span className="new-session-deck-icon" aria-hidden="true">{item.icon ?? null}</span>
            <span className="new-session-deck-name">{item.name}</span>
            <span className="new-session-deck-value">{item.value ?? null}</span>
            <span className="new-session-deck-meta">
              {item.token ? <span className="new-session-deck-token">{item.token}</span> : null}
              {item.checked ? <span className="new-session-deck-check" aria-hidden="true">✓</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 질의와 처음 일치하는 구간을 굵게 세운다(대소문자 무시). */
export function markMatch(text: string, query: string): ReactNode {
  if (query.length === 0) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}
