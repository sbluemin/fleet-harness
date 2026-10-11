import type { ReactNode } from "react";

import type { ConsoleLocale } from "../i18n/types.js";
import type { ConsoleTheaterSummary } from "../plugin/types.js";

/**
 * Theater Inbox — one Theater's sheet where the host's Theater settings and plugin-owned Theater sections sit
 * side by side. The host owns the sheet: frame, open/close, the address (section and page), the section list,
 * keyboard travel, focus return and layout changes. A section contributes its title, pages and bodies only.
 *
 * Section ids are canonical in the host: a plugin's `id` becomes `<pluginId>:<id>`, and the host's own Theater
 * settings section is `console:settings`. Plugins never name another plugin's section; cross links go through
 * the `links` the host resolves for them.
 */
export interface TheaterInboxAddress {
  /** Canonical section id (`<pluginId>:<id>`, or `console:settings`). */
  readonly sectionId: string;
  readonly pageId: string;
}

export type TheaterInboxFocusKind = "default" | "editor-end";

export interface TheaterInboxOpenRequest extends TheaterInboxAddress {
  readonly theaterId: string;
  /**
   * Where focus returns when the sheet closes. Pass it from an outside entry (a sidebar row, a menu item).
   * Moves inside an open sheet omit it so the original opener is kept.
   */
  readonly returnFocus?: HTMLElement | null;
  /** `editor-end` asks the target page to focus its main editor with the caret at the end. */
  readonly focus?: TheaterInboxFocusKind;
}

/** The open sheet as the host knows it. */
export interface TheaterInboxSnapshot {
  readonly theaterId: string;
  readonly address: TheaterInboxAddress;
}

/**
 * The host capability. `open` on an already open sheet changes its address (or Theater) instead of stacking
 * a second sheet. `read` returns the same reference until the sheet changes (useSyncExternalStore).
 */
export interface ClientTheaterInboxCapability {
  open(request: TheaterInboxOpenRequest): void;
  close(): void;
  read(): TheaterInboxSnapshot | null;
  subscribe(listener: () => void): () => void;
}

export interface TheaterInboxSectionState {
  /**
   * `disabled` keeps only the section title and `disabledNote` in the list; its pages, body and links are left
   * out. `loading` means the section cannot tell yet (for example settings not read) — the host shows the title
   * only and never treats it as off.
   */
  readonly availability: "available" | "disabled" | "loading";
  /** One line under the section title: what this section is about, or its current status. */
  readonly scope: string;
  readonly disabledNote?: string;
}

export interface TheaterInboxFocusRequest {
  /** Rises on every request so the same kind can be asked twice. */
  readonly nonce: number;
  readonly kind: TheaterInboxFocusKind;
}

export interface TheaterInboxBodyContext {
  readonly theater: ConsoleTheaterSummary;
  readonly language: ConsoleLocale;
  /** The section's page to show. A section body stays mounted while the sheet is open; only `visible` changes. */
  readonly pageId: string;
  /** False while another section is shown. Gate menus, focus effects and observers on it. */
  readonly visible: boolean;
  /** Set when the host asks this section to place focus; act once per nonce, after the page has loaded. */
  readonly focusRequest: TheaterInboxFocusRequest | null;
  readonly links: {
    /** The host's Theater system prompt page. */
    readonly systemPrompt: TheaterInboxAddress;
    /** The page a section declared with `operatorDirectivePageId`, when that section is available. */
    readonly operatorDirective: TheaterInboxAddress | null;
  };
  readonly navigation: ClientTheaterInboxCapability;
}

export interface TheaterInboxPageDescriptor {
  readonly id: string;
  title(language: ConsoleLocale): string;
  /** When this page's changes take effect — the host shows it in the shared 「Applies」 line under the page. */
  applies?(language: ConsoleLocale): string;
}

export interface TheaterInboxSectionDescriptor {
  readonly id: string;
  title(language: ConsoleLocale): string;
  icon(context: { readonly theater: ConsoleTheaterSummary }): ReactNode;
  readonly pages: readonly TheaterInboxPageDescriptor[];
  /** The page other sections may link to as "the directive for this Theater's operator". */
  readonly operatorDirectivePageId?: string;
  /** No I/O. Returns the same reference while nothing changed. */
  read(theater: ConsoleTheaterSummary, language: ConsoleLocale): TheaterInboxSectionState;
  subscribe(listener: () => void): () => void;
  /** Returns the section body. Hooks belong inside the component it returns, not in this callback. */
  render(context: TheaterInboxBodyContext): ReactNode;
  /** The Console switched to the phone layout while this section was shown; hand the reader to the phone screen. */
  onLeaveDesktop?(context: { readonly theater: ConsoleTheaterSummary; readonly pageId: string }): void;
}
