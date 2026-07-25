import { Fragment, useEffect, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

import { useT } from "../i18n/index.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationNode, TheaterInfo } from "../types.js";

export type CommandBandSwitcherMenu = "theater" | "operation";

interface CommandBandMenuEntry {
  readonly key: string;
  readonly role: "menuitemradio" | "menuitem";
  readonly label: string;
  readonly checked?: boolean;
  readonly mark?: string;
  readonly meta?: string | null;
  readonly action?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

interface CommandBandMenuProps {
  readonly menuLabel: string;
  readonly sections: readonly (readonly CommandBandMenuEntry[])[];
  readonly emptyNote?: string | null;
  readonly style?: CSSProperties;
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

interface CommandBandTheaterMenuProps {
  readonly theaters: readonly TheaterInfo[];
  readonly operations: readonly OperationNode[];
  readonly activeTheaterId: string | null;
  readonly addingTheater: boolean;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onAddTheater: () => void;
  readonly style?: CSSProperties;
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

interface CommandBandOperationMenuProps {
  // 활성 Theater 소속 Operation만, 사이드바 표시 순서로 정렬해 전달한다.
  readonly operations: readonly OperationNode[];
  readonly activeOperationId: string | null;
  readonly theaterLabel: string;
  readonly onSelectOperation: (operationId: string) => void;
  readonly onRenameOperation: (() => void) | null;
  readonly onNewOperation: () => void;
  readonly style?: CSSProperties;
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

export function CommandBandTheaterMenu({ theaters, operations, activeTheaterId, addingTheater, onSelectTheater, onAddTheater, style, containerRef }: CommandBandTheaterMenuProps) {
  const t = useT();
  const sections: readonly (readonly CommandBandMenuEntry[])[] = [
    theaters.map((theater) => {
      const count = operations.filter((operation) => operation.theaterId === theater.id).length;
      return {
        key: theater.id,
        role: "menuitemradio" as const,
        label: theater.label,
        checked: theater.id === activeTheaterId,
        mark: theaterInitials(theater.label),
        meta: t(count === 1 ? "chrome.commandBand.opCount_one" : "chrome.commandBand.opCount_other", { count }),
        onSelect: () => onSelectTheater(theater.id),
      };
    }),
    [{
      key: "__add-theater__",
      role: "menuitem" as const,
      label: t("chrome.commandBand.addTheater"),
      action: true,
      disabled: addingTheater,
      onSelect: onAddTheater,
    }],
  ];
  return <CommandBandMenu menuLabel={t("chrome.commandBand.switchTheater")} sections={sections} style={style} containerRef={containerRef} />;
}

export function CommandBandOperationMenu({ operations, activeOperationId, theaterLabel, onSelectOperation, onRenameOperation, onNewOperation, style, containerRef }: CommandBandOperationMenuProps) {
  const t = useT();
  const sections: readonly (readonly CommandBandMenuEntry[])[] = [
    operations.map((operation) => ({
      key: operation.id,
      role: "menuitemradio" as const,
      label: operation.title,
      checked: operation.id === activeOperationId,
      meta: operationCliLabel(operation),
      onSelect: () => onSelectOperation(operation.id),
    })),
    [
      ...(onRenameOperation !== null ? [{
        key: "__rename-operation__",
        role: "menuitem" as const,
        label: t("chrome.commandBand.renameCurrentOperation"),
        onSelect: onRenameOperation,
      }] : []),
      {
        key: "__new-operation__",
        role: "menuitem" as const,
        label: t("chrome.commandBand.newOperationIn", { theater: theaterLabel }),
        action: true,
        onSelect: onNewOperation,
      },
    ],
  ];
  return (
    <CommandBandMenu
      menuLabel={t("chrome.commandBand.switchOperation")}
      sections={sections}
      emptyNote={operations.length === 0 ? t("chrome.commandBand.noOperationsInTheater") : null}
      style={style}
      containerRef={containerRef}
    />
  );
}

function CommandBandMenu({ menuLabel, sections, emptyNote, style, containerRef }: CommandBandMenuProps) {
  const menuItems = () => Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>(".command-band-menu-item:not(:disabled)") ?? []);

  useEffect(() => {
    const items = menuItems();
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    // 열림 시 1회 — 활성(체크) 행으로 초기 포커스.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };

  const renderedSections = sections.filter((section) => section.length > 0);
  return (
    <div ref={containerRef} className="command-band-menu" role="menu" aria-label={menuLabel} style={style} onKeyDown={handleKeyDown}>
      {emptyNote ? <p className="command-band-menu-empty">{emptyNote}</p> : null}
      {renderedSections.map((section, sectionIndex) => (
        <Fragment key={section[0]?.key ?? sectionIndex}>
          {sectionIndex > 0 || emptyNote ? <div className="command-band-menu-divider" aria-hidden="true" /> : null}
          {section.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role={entry.role}
              aria-checked={entry.role === "menuitemradio" ? entry.checked === true : undefined}
              className={`command-band-menu-item${entry.checked ? " is-active" : ""}${entry.action ? " command-band-menu-action" : ""}`}
              disabled={entry.disabled}
              onClick={entry.onSelect}
            >
              <span className="command-band-menu-check" aria-hidden="true">{entry.checked ? <MenuCheckIcon /> : null}</span>
              {entry.mark !== undefined ? <span className="command-band-theater-mark" aria-hidden="true">{entry.mark}</span> : null}
              <span className="command-band-menu-label">{entry.label}</span>
              {entry.meta ? <span className="command-band-menu-meta">{entry.meta}</span> : null}
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export function CommandBandTriggerCaret() {
  return (
    <span className="command-band-trigger-caret" aria-hidden="true">
      <svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

function MenuCheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function operationCliLabel(operation: OperationNode): string | null {
  const cliLabel = operation.payload.cliLabel;
  if (typeof cliLabel === "string") return cliLabel;
  const cliId = operation.payload.cliId;
  return typeof cliId === "string" ? cliId : null;
}
