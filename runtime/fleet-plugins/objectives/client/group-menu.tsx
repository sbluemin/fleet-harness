import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { AccentToneList } from "@fleet-console/sdk/components/accent-tone-list";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { IdentityTone } from "@fleet-console/sdk/operations/identity-tones";

import type { ObjectiveMessageKey } from "./i18n/index.js";
import type { ObjectiveGroup } from "./objectives-state.js";

/** 메뉴를 세울 자리 — 우클릭은 커서, 「···」·키보드는 그 요소의 왼쪽 아래. */
export interface GroupMenuAnchor { readonly x: number; readonly y: number }
export interface GroupPatch { readonly name?: string; readonly color?: IdentityTone }

const MARGIN = 8;
const TONE_KEYS: Readonly<Record<IdentityTone, ObjectiveMessageKey>> = {
  crimson: "objectives.tone.crimson",
  amber: "objectives.tone.amber",
  moss: "objectives.tone.moss",
  teal: "objectives.tone.teal",
  cerulean: "objectives.tone.cerulean",
  indigo: "objectives.tone.indigo",
  plum: "objectives.tone.plum",
  rose: "objectives.tone.rose",
};

/** 그룹 행·구획 머리에서 메뉴를 여는 키 — Shift+F10 과 메뉴 키. */
export const opensGroupMenu = (event: { readonly key: string; readonly shiftKey: boolean }): boolean => (event.shiftKey && event.key === "F10") || event.key === "ContextMenu";

/**
 * 그룹 메뉴 — 사이드바 그룹 머리 메뉴와 같은 순서(색 → 이름 변경)와 같은 스와치(SDK 공용). 이 표면에서는 이름과 색만 바꾸고
 * 「전체 그룹 해제」는 두지 않는다(누르면 그룹의 목표와 구성원이 모두 미분류로 간다 — 해제는 사이드바의 몫).
 * 색은 누르는 즉시 바뀌고 메뉴는 남는다. 이름은 Enter·바깥 누름으로 확정, Esc 는 되돌리고 닫는다.
 */
export function GroupMenu({ group, anchor, t, onPatch, onClose }: {
  readonly group: ObjectiveGroup;
  readonly anchor: GroupMenuAnchor;
  readonly t: Translate<ObjectiveMessageKey>;
  readonly onPatch: (patch: GroupPatch) => void;
  /** returnFocus — 키보드로 닫았으면 연 자리로 초점을 돌린다. */
  readonly onClose: (returnFocus: boolean) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(group.name);
  const nameRef = useRef(name);
  nameRef.current = name;
  const composingRef = useRef(false);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const commit = () => {
    const next = nameRef.current.trim();
    if (next && next !== group.name) onPatch({ name: next });
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 자리는 실측으로 — 숨긴 채 그려 폭·높이를 읽고 화면 안으로 민다.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const left = Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - card.offsetWidth - MARGIN));
    const top = anchor.y + card.offsetHeight + MARGIN <= window.innerHeight ? anchor.y : Math.max(MARGIN, window.innerHeight - card.offsetHeight - MARGIN);
    setStyle({ position: "fixed", left, top: Math.round(top) });
  }, [anchor]);
  // 자리가 잡혀 보이게 된 뒤 지금 색 스와치에 초점 — 사이드바 메뉴와 같은 출발점(숨긴 채 재는 동안에는 초점을 받지 못한다).
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!style || focusedRef.current) return;
    focusedRef.current = true;
    const card = cardRef.current;
    (card?.querySelector<HTMLElement>('.accent-swatch[aria-checked="true"]') ?? card?.querySelector<HTMLElement>(".accent-swatch"))?.focus();
  }, [style]);
  useEffect(() => {
    const down = (event: PointerEvent) => { if (!cardRef.current?.contains(event.target as Node)) { commitRef.current(); closeRef.current(false); } };
    const dismiss = () => { commitRef.current(); closeRef.current(false); };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss); };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 상세의 창 수준 Esc(상세 닫기)까지 올라가지 않게 여기서 끝낸다.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    const swatch = (event.target as HTMLElement).closest<HTMLElement>(".accent-swatch");
    if (swatch && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const all = [...(cardRef.current?.querySelectorAll<HTMLElement>(".accent-swatch") ?? [])];
      const at = all.indexOf(swatch);
      all[(at + (event.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      className="objectives-menu objectives-group-menu"
      role="menu"
      aria-label={t("objectives.group.menu", { name: group.name })}
      style={style ?? { position: "fixed", left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      <AccentToneList
        label={t("objectives.group.color")}
        accentKey={group.color}
        includeNone={false}
        labels={{ tone: (key) => t(TONE_KEYS[key]) }}
        onSelect={(key) => { if (key && key !== group.color) onPatch({ color: key }); }}
      />
      <div className="objectives-menu-divider" role="separator" />
      <div className="group-context-menu-section-label"><span>{t("objectives.group.rename")}</span></div>
      <input
        className="objectives-group-menu-name"
        type="text"
        value={name}
        maxLength={64}
        aria-label={t("objectives.group.nameAria")}
        onChange={(event) => setName(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !composingRef.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); commit(); onClose(true); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setName(group.name); onClose(true); }
        }}
      />
    </div>,
    document.body,
  );
}
