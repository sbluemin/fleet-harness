import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { MobileBarMenuItem } from "@fleet-console/sdk/pane";

/**
 * ⋮ 메뉴 — ⋮ 바로 아래 오른쪽에 붙는 작은 판. 배경은 어둡게 하지 않고 투명 덮개만 둔다.
 * 항목 모양은 호스트가 정하고(플러그인은 `MobileBarMenuItem`만 건넨다), 파괴 항목은 맨 아래에서 위험 색을 입는다.
 */
export function MobileMenu({ caption, items, label, onClose }: {
  readonly caption?: string;
  readonly items: readonly MobileBarMenuItem[];
  readonly label: string;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const ordered = [...items.filter((item) => item.destructive !== true), ...items.filter((item) => item.destructive === true)];

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, []);

  const close = (after?: () => void) => {
    setLeaving(true);
    window.setTimeout(() => { onClose(); after?.(); }, 100);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };

  return (
    <>
      <div className="mobile-menu-cover" onClick={() => close()} />
      <div className={`mobile-menu${leaving ? " is-leaving" : ""}`} role="menu" aria-label={label} ref={panelRef} onKeyDown={onKeyDown}>
        {caption ? <div className="mobile-menu-caption">{caption}</div> : null}
        {ordered.map((item) => (
          <button
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            key={item.id}
            className={item.destructive ? "is-destructive" : undefined}
            disabled={item.disabled}
            // 스위치 행은 메뉴를 닫지 않고 토글만 한다 — 바뀐 상태는 항목이 다시 올라오며 그려진다.
            onClick={() => (item.checked === undefined ? close(item.run) : item.run())}
          >
            {item.icon ?? null}
            <span>{item.label}</span>
            {item.checked === undefined ? null : <span className={`mobile-switch${item.checked ? " is-on" : ""}`} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </>
  );
}
