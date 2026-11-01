import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { FeatureErrorBoundary, useViewportFit } from "@fleet-console/ui/react";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { toolShellKey } from "../../../execution/shared/shell-key.js";
import { getShellSessionSnapshot, readShellSession } from "../../../execution/client/terminal/shell/shell-session-store.js";
import type { CommodoreToolId } from "../../shared/commodore-tool-theater.js";
import { useCommodoreToolTheater } from "./store.js";
import { useCommodoreShellStatus } from "./shell-status.js";
import "./theater-tools.css";

/**
 * 사령관 전용 도구 패널의 머리 — `제목 / Theater ⌄` 한 줄이다. 칩 모양을 쓰지 않는다.
 * 빗금은 tertiary, Theater 이름은 제목 크기의 secondary, 셰브론은 옅게 서서
 * 올려놓거나 펼치면 또렷해진다. 쉴 때는 테두리도 채움도 없다.
 *
 * 메뉴는 고르기만 한다(추가·해제는 설정의 Theater 구역이 맡는다). 초록 점은
 * 그 Theater에 살아 있는 Shell이 있다는 표시다(미션 8이 살린다).
 */
export function CommodoreToolHead({ icon, title, commodoreId, tool }: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly commodoreId: string;
  readonly tool: CommodoreToolId;
}): ReactNode {
  const t = useT();
  const state = useCommodoreToolTheater(commodoreId, tool);
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  // 타일 머리·레일 칸이 overflow: hidden이라 단추 아래 absolute로 열면 잘린다.
  // DOM 자리(Tab 순서)는 그대로 두고 단추에 맞춘 fixed로 띄운다.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = buttonRef.current;
    if (!menuOpen || !menu || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
  }, [menuOpen, state.resolution]);
  useViewportFit(menuRef, menuOpen);

  // 바깥 누름·Esc로 닫는다. Tab은 막지 않고, 메뉴를 벗어나면 닫는다.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (menuRef.current?.contains(event.relatedTarget as Node)) return;
      if (buttonRef.current?.contains(event.relatedTarget as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    menuRef.current?.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      menuRef.current?.removeEventListener("focusout", onFocusOut);
    };
  }, [menuOpen]);

  // 메뉴가 걷히고 초점이 본문으로 떨어졌으면(선택·Esc) 단추로 돌려준다.
  // 바깥을 눌러 닫힌 경우(초점이 그곳에 있음)는 건드리지 않는다.
  useEffect(() => {
    if (wasOpenRef.current && !menuOpen && document.activeElement === document.body) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = menuOpen;
  }, [menuOpen]);

  const availableTheaters = useMemo(
    () => (state.active && state.resolution !== null ? state.theaters.filter((theater) => !theater.missing) : []),
    [state],
  );
  // 메뉴를 열 때 아직 모르는 Theater의 호스트 상태를 읽어 둔다 — 마운트하지 않은 채 살아 있는
  // Shell의 초록 점이 새로고침 뒤에도 서게. 아는 값은 SSE가 갱신하므로 다시 묻지 않는다.
  useEffect(() => {
    if (!menuOpen) return;
    for (const theater of availableTheaters) {
      const key = toolShellKey(commodoreId, theater.theaterId);
      if (key !== null && getShellSessionSnapshot(key) === null) void readShellSession(key);
    }
  }, [menuOpen, commodoreId, availableTheaters]);

  if (!state.active || state.resolution === null || state.resolution.kind === "none") {
    return (
      <span className="ctt-head">
        {icon ? <span className="workbench-tile-icon" aria-hidden="true">{icon}</span> : null}
        <span className="workbench-tile-name">{title}</span>
      </span>
    );
  }
  const choices = availableTheaters;
  const resolution = state.resolution;
  const currentLabel = resolution !== null && resolution.kind === "resolved"
    ? (state.theaters.find((theater) => theater.theaterId === resolution.theaterId)?.label ?? resolution.theaterId)
    : null;
  const checkedTheaterId = resolution !== null && resolution.kind === "resolved" ? resolution.theaterId : null;
  return (
    <span className="ctt-head">
      {icon ? <span className="workbench-tile-icon" aria-hidden="true">{icon}</span> : null}
      <span className="workbench-tile-name">{title}</span>
      <span className="ctt-sep" aria-hidden="true">/</span>
      <button
        ref={buttonRef}
        type="button"
        className="ctt-select"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("theaterTools.select.aria", { title })}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="ctt-select-name">{currentLabel ?? t("theaterTools.choose")}</span>
        <svg className={`ctt-chevron${menuOpen ? " is-open" : ""}`} viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menuOpen ? (
        <FeatureErrorBoundary fallback={null}>
          <div ref={menuRef} className="ctt-menu" role="menu" aria-label={t("theaterTools.select.aria", { title })}>
            {choices.map((theater) => (
              <TheaterMenuRow
                key={theater.theaterId}
                commodoreId={commodoreId}
                theaterId={theater.theaterId}
                label={theater.label}
                checked={checkedTheaterId === theater.theaterId}
                onSelect={() => {
                  state.select(theater.theaterId);
                  setMenuOpen(false);
                }}
              />
            ))}
          </div>
        </FeatureErrorBoundary>
      ) : null}
    </span>
  );
}

function TheaterMenuRow({ commodoreId, theaterId, label, checked, onSelect }: {
  readonly commodoreId: string;
  readonly theaterId: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const t = useT();
  const status = useCommodoreShellStatus(commodoreId, theaterId);
  const ref = useRef<HTMLButtonElement | null>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const row = event.currentTarget.closest(".ctt-menu");
    if (!row) return;
    const items = [...row.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    const index = items.indexOf(event.currentTarget as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? items[(index + 1) % items.length]
        : event.key === "ArrowUp" ? items[(index - 1 + items.length) % items.length]
        : event.key === "Home" ? items[0]
        : items[items.length - 1];
      next?.focus();
    }
  };
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="ctt-menu-row"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {status.live ? (
        <span className="ctt-live-dot" title={t("theaterTools.liveShell")} aria-hidden="true" />
      ) : (
        <span className="ctt-live-dot is-off" aria-hidden="true" />
      )}
      <span className="ctt-menu-label">{label}</span>
      {checked ? (
        <svg className="ctt-check" viewBox="0 0 12 10" aria-hidden="true">
          <path d="M1 5.5 4.5 9 11 1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}
