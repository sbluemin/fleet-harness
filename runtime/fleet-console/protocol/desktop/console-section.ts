import {
  CONSOLE_ACCESS_PATHS,
  CONSOLE_LIFECYCLE_ACTIONS,
  CONSOLE_MANAGED_LIFECYCLES,
  CONSOLE_MANAGEMENT_RELATIONS,
  isConsoleLifecycleAction,
  type ConsoleAccessPath,
  type ConsoleLifecycleAction,
  type ConsoleManagedLifecycle,
  type ConsoleManagementRelation,
} from "../lifecycle/management.js";
import { parseCreateCommodoreCommand, parseUnifiedSidebarCommand, type UnifiedSidebarCommand } from "./unified-sidebar.js";

/** Renderer-only, minimized sidebar contract. Never publish its state through a Console server. */
export const CONSOLE_DIRECTORY_CAPABILITY = "console-directory";
export const CONSOLE_SECTION_COMMAND = "console-section-command";
export const CONSOLE_SECTION_EVENT = "fleet:console-section-state";
export const CONSOLE_SECTION_MAX_FRAME = 16_384;
export interface ConsoleSectionEntry {
  readonly id: string;
  /** Display only: which glyph the section gets. Never a permission; see `management` and `path`. */
  readonly kind: "local" | "remote";
  readonly label: string;
  readonly address: string;
  readonly version: string | null;
  readonly active: boolean;
  readonly home: boolean;
  readonly status: "ready" | "unreachable" | "untrusted" | "stopping" | "slow" | null;
  /**
   * The relations of docs/console-lifecycle-contract.md ("Management, operation, and access path"), as the shell
   * judged them. All four are additive: a shell from before them sends none, and a page from before them ignores them.
   * `actions` is what the shell will accept for this entry right now; the shell judges every command again.
   */
  readonly management?: ConsoleManagementRelation;
  readonly path?: ConsoleAccessPath;
  readonly lifecycle?: ConsoleManagedLifecycle | null;
  readonly actions?: readonly ConsoleLifecycleAction[];
  /** More about a Console this Desktop manages besides its home one. Additive and display only, like the relations. */
  readonly managed?: ConsoleManagedDetail;
}
/**
 * `installing`: its runtime is being installed before the first start. `failure`: why the last action did not finish.
 * `takeover`: a Console started from a terminal holds its slot and the person may hand it to this Desktop.
 * `removable`: the registration may be dropped now (the Console is not running under this Desktop).
 */
export interface ConsoleManagedDetail {
  readonly installing?: true;
  readonly failure?: ConsoleManagedFailure;
  readonly takeover?: true;
  readonly removable?: true;
  /** Installed and target runtime versions, only while this Desktop proves ownership. */
  readonly update?: ConsoleRuntimeUpdate;
  readonly updating?: true;
}
export interface ConsoleRuntimeUpdate {
  readonly node: { readonly installed: string; readonly target: string };
  readonly console: { readonly installed: string; readonly target: string };
}
export type ConsoleManagedFailure = "build-tools" | "download" | "install" | "start" | "other-owner" | "stop";
export const CONSOLE_MANAGED_FAILURES: readonly ConsoleManagedFailure[] = ["build-tools", "download", "install", "start", "other-owner", "stop"];
export interface ConsoleSectionState {
  readonly v: 1;
  readonly expanded: boolean;
  readonly entries: readonly ConsoleSectionEntry[];
}
/**
 * `commodore` and `anchorY` ride only on `switch`: the commodore to open on arrival and the pressed row's top
 * inside the sidebar viewport (CSS px). A shell without `CONSOLE_ROSTER_CAPABILITY` ignores both and only switches.
 * `commander` (an objective of that commodore, only with `commodore`) and `scrollTop` (the sidebar list's scroll
 * offset, CSS px) ride on `switch` too; a shell without `CONSOLE_ROSTER_SEAMLESS_CAPABILITY` ignores both.
 * `rightPanel` (only with `commodore`) is the right sidebar's state at the press; the same shell hands it to the arriving document.
 */
export type ConsoleSectionCommand = { readonly request: "state" }
  | { readonly switch: string; readonly commodore?: string; readonly commander?: string; readonly anchorY?: number; readonly scrollTop?: number; readonly rightPanel?: ConsoleRightPanel }
  | { readonly expanded: boolean } | { readonly add: true }
  | { readonly rename: { readonly id: string; readonly label: string } } | { readonly forget: string }
  | { readonly fold: { readonly id: string; readonly folded: boolean } } | { readonly arrived: true }
  /** Opens the management surface for an entry. The surface is drawn by the home Console, never by the active document. */
  | { readonly manage: string }
  /** A lifecycle action on a managed entry. The shell honors it only from a document of the home Console. */
  | { readonly lifecycle: { readonly id: string; readonly action: ConsoleLifecycleAction } }
  /** Hands a Console the person started from a terminal to this Desktop. Honored only from a document of the home Console. */
  | { readonly takeover: string }
  /** Explicit, confirmed runtime update. Like takeover, only the home Console's document may ask. */
  | { readonly update: string }
  /** The WSL add flow, drawn by the home Console and honored only from its documents. `inspect` may start a stopped distribution. */
  | { readonly wsl: { readonly list: true } | { readonly inspect: string } | { readonly add: string } }
  /**
   * Unified placement. A shell without `CONSOLE_UNIFIED_SIDEBAR_CAPABILITY` ignores it. The page sends it
   * only when that capability is posted, so an old shell never has to understand it.
   */
  | { readonly unified: UnifiedSidebarCommand }
  /**
   * Create a commodore on a machine without switching the window to it. `request` pairs the result event.
   * The shell performs the write; a monitoring session is `access` and does not create.
   */
  | { readonly createCommodore: { readonly consoleId: string; readonly alias: string; readonly request: string; readonly look?: { readonly base: number; readonly tone: string | null } } };

/**
 * What the shell tells the home Console's add surface about WSL on this computer. Renderer-only and never sent to a
 * document another Console serves: it names distributions and a Linux user. Listing starts no distribution.
 */
export const CONSOLE_WSL_EVENT = "fleet:console-wsl-state";
/** The shell runs on Windows and answers the `wsl` commands. A page asks nothing of a shell without it. */
export const CONSOLE_WSL_CAPABILITY = "console-wsl";
export interface ConsoleWslDistro {
  readonly name: string;
  readonly running: boolean;
  readonly version: 1 | 2 | null;
  /** Already registered with this Desktop. */
  readonly managed: boolean;
}
export interface ConsoleWslInspection {
  readonly distro: string;
  readonly user: string;
  readonly runtime: "ready" | "missing";
  readonly missingTools: readonly string[];
  /** A Console already in that user's standard slot, by who manages it; `stale` is a lock an ended Console left. */
  readonly existing: "none" | "stale" | ConsoleManagementRelation;
  readonly ownFleet: boolean;
}
export interface ConsoleWslState {
  readonly v: 1;
  readonly distros: readonly ConsoleWslDistro[];
  readonly inspection: ConsoleWslInspection | null;
  readonly busy: "inspect" | null;
  /** The distribution that was just registered; the surface closes on it. */
  readonly added: string | null;
  readonly error: "unusable" | "failed" | null;
}

/**
 * A Console's own roster summary: names, looks, order and one run word. No previews, theaters or objectives.
 * `GET` only. Loopback follows the loopback API rule; the remote listener answers a live session or a valid
 * pairing cookie alone, and answering never opens a session or moves control. Everything else is 401.
 */
export const CONSOLE_ROSTER_PATH = "/api/v1/console-roster";
export const CONSOLE_ROSTER_MAX_COMMODORES = 40;
/** In-progress commanders listed under one commodore; the rest are counted in `moreCommanders`. */
export const CONSOLE_ROSTER_MAX_COMMANDERS = 8;
/** UTF-16 units of `preview`, one line. */
export const CONSOLE_ROSTER_PREVIEW_MAX = 160;
export type ConsoleRosterRun = "working" | "waiting" | "quiet";
/** An avatar book entry: base index and identity tone. */
export interface ConsoleRosterLook { readonly base: number; readonly tone: string | null }
/** One objective in progress under a commodore, as its sidebar row shows it: title, mission progress and one run word. */
export interface ConsoleRosterCommander {
  /** The objective's id on that Console. */
  readonly id: string;
  readonly title: string;
  /** Missions done and in all; `done <= total`. */
  readonly done: number;
  readonly total: number;
  readonly run: ConsoleRosterRun;
  /** Additive: the objective's avatar book entry on that Console, so its row keeps the same face in every document. Absent or null: none yet. */
  readonly look?: ConsoleRosterLook | null;
}
/** A section the person made in that Console's sidebar, in sidebar order. Its rows are hidden there while `collapsed`, so other documents hide them too. */
export interface ConsoleRosterSection {
  readonly id: string;
  readonly name: string;
  readonly collapsed?: true;
}
export const CONSOLE_ROSTER_MAX_SECTIONS = 100;
export interface ConsoleRosterCommodore {
  readonly id: string;
  readonly name: string;
  /** The avatar book entry of that Console (base index and identity tone); null when it has none yet. */
  readonly look: ConsoleRosterLook | null;
  readonly run: ConsoleRosterRun;
  /** Additive: the id of the `sections` entry this commodore sits in. Absent: it sits in no section. */
  readonly section?: string;
  /**
   * The three below are additive: a Console from before them sends none and its rows show the name alone.
   * `preview` is the one-line last message the commodore's own sidebar row shows, control characters removed.
   * `commanders` are the objectives in progress, in sidebar order. The route's reader rule is unchanged by them.
   */
  readonly preview?: string;
  readonly commanders?: readonly ConsoleRosterCommander[];
  readonly moreCommanders?: number;
}
export interface ConsoleRosterSummary {
  readonly v: 1;
  /** Sidebar order, at most `CONSOLE_ROSTER_MAX_COMMODORES`. */
  readonly commodores: readonly ConsoleRosterCommodore[];
  /** How many were left out by the cap. */
  readonly more: number;
  /**
   * Additive: that sidebar's own sections, so another document draws the same headers in the same order.
   * A Console without sections sends none. `unsectionedCollapsed` hides the commodores that sit in no section.
   */
  readonly sections?: readonly ConsoleRosterSection[];
  readonly unsectionedCollapsed?: true;
}
/** What the right sidebar showed when the person pressed a row: open or not, and which tab. */
export interface ConsoleRightPanel { readonly open: boolean; readonly tab?: string }

/** The shell relays rosters and accepts `switch.commodore`, `fold` and `arrived`. */
export const CONSOLE_ROSTER_CAPABILITY = "console-roster";
/**
 * The shell keeps the sidebar where it was across a switch: it accepts `switch.commander` and `switch.scrollTop`
 * and hands both to the arriving document in `arrival`. Every document then draws the sections in `entries` order,
 * its own in place, so the order does not depend on which Console is active.
 */
export const CONSOLE_ROSTER_SEAMLESS_CAPABILITY = "console-roster-seamless";
/** Renderer-only, like the section state: the shell dispatches it on the active document's window. */
export const CONSOLE_ROSTER_EVENT = "fleet:console-roster-state";
/** A page from before the additive fields rejects a larger frame, so the cap stays. To fit, the shell drops previews first, then commanders, then commodores. */
export const CONSOLE_ROSTER_MAX_FRAME = 65_536;
export interface ConsoleRosterEntry {
  /** A `ConsoleSectionEntry.id` of the same window. The active entry has no roster: its document draws its own. */
  readonly id: string;
  /** `unsupported`: that Console has no roster route. `unavailable`: the read failed; `commodores` is the last good list. */
  readonly status: "ok" | "unsupported" | "unavailable";
  /** Epoch ms of the last good read, or null when there was none. */
  readonly at: number | null;
  readonly commodores: readonly ConsoleRosterCommodore[];
  readonly more: number;
  /** Additive, relayed from that Console's summary as they are. */
  readonly sections?: readonly ConsoleRosterSection[];
  readonly unsectionedCollapsed?: true;
}
export interface ConsoleRosterState {
  readonly v: 1;
  readonly rosters: readonly ConsoleRosterEntry[];
  /** Entry ids the person folded in this window. */
  readonly folded: readonly string[];
  /**
   * Set for the document a `switch.commodore` landed on, until that document sends `arrived`.
   * `commander` and `scrollTop` are additive (`CONSOLE_ROSTER_SEAMLESS_CAPABILITY`): the objective to open under that
   * commodore, and the sidebar list offset to restore before the first paint. Absent or null means none.
   * `rightPanel` is additive too: the right sidebar state to show on arrival; absent or null leaves the document's own.
   */
  readonly arrival: { readonly commodore: string; readonly anchorY: number | null; readonly commander?: string | null; readonly scrollTop?: number | null; readonly rightPanel?: ConsoleRightPanel | null } | null;
}
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const anchor = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000;
const rosterRun = (value: unknown): value is ConsoleRosterRun => value === "working" || value === "waiting" || value === "quiet";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000;
const rosterLook = (value: unknown): value is ConsoleRosterLook => object(value) && Number.isSafeInteger(value.base) && (value.base as number) >= 0 && (value.base as number) < 10_000
  && (value.tone === null || clean(value.tone, 64));
const rosterCommander = (value: unknown): value is ConsoleRosterCommander => object(value) && clean(value.id, 128) && clean(value.title, 120)
  && count(value.done) && count(value.total) && value.done <= value.total && rosterRun(value.run)
  && (value.look === undefined || value.look === null || rosterLook(value.look));
const rosterSection = (value: unknown): value is ConsoleRosterSection => object(value) && clean(value.id, 128) && clean(value.name, 80)
  && (value.collapsed === undefined || value.collapsed === true);
const rightPanel = (value: unknown): value is ConsoleRightPanel => object(value) && typeof value.open === "boolean" && (value.tab === undefined || clean(value.tab, 32));
const rosterCommodore = (value: unknown): value is ConsoleRosterCommodore => object(value) && clean(value.id, 128) && clean(value.name, 120)
  && (value.preview === undefined || clean(value.preview, CONSOLE_ROSTER_PREVIEW_MAX))
  && (value.commanders === undefined || (Array.isArray(value.commanders) && value.commanders.length <= CONSOLE_ROSTER_MAX_COMMANDERS && value.commanders.every(rosterCommander)))
  && (value.moreCommanders === undefined || count(value.moreCommanders))
  && (value.section === undefined || clean(value.section, 128))
  && (value.look === null || rosterLook(value.look))
  && rosterRun(value.run);
const rosterList = (value: Record<string, unknown>): boolean => Array.isArray(value.commodores) && value.commodores.length <= CONSOLE_ROSTER_MAX_COMMODORES
  && value.commodores.every(rosterCommodore) && Number.isSafeInteger(value.more) && (value.more as number) >= 0
  && (value.sections === undefined || (Array.isArray(value.sections) && value.sections.length <= CONSOLE_ROSTER_MAX_SECTIONS && value.sections.every(rosterSection)))
  && (value.unsectionedCollapsed === undefined || value.unsectionedCollapsed === true);
export function isConsoleRosterSummary(value: unknown): value is ConsoleRosterSummary {
  return object(value) && value.v === 1 && rosterList(value);
}
export function isConsoleRosterState(value: unknown): value is ConsoleRosterState {
  if (!object(value) || value.v !== 1 || !Array.isArray(value.rosters) || value.rosters.length > 100 || !Array.isArray(value.folded) || value.folded.length > 100) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > CONSOLE_ROSTER_MAX_FRAME) return false; } catch { return false; }
  if (!value.folded.every((id: unknown) => clean(id, 128))) return false;
  if (value.arrival !== null && !(object(value.arrival) && clean(value.arrival.commodore, 128) && (value.arrival.anchorY === null || anchor(value.arrival.anchorY))
    && (value.arrival.commander === undefined || value.arrival.commander === null || clean(value.arrival.commander, 128))
    && (value.arrival.scrollTop === undefined || value.arrival.scrollTop === null || anchor(value.arrival.scrollTop))
    && (value.arrival.rightPanel === undefined || value.arrival.rightPanel === null || rightPanel(value.arrival.rightPanel)))) return false;
  return value.rosters.every((entry: unknown) => object(entry) && clean(entry.id, 128)
    && (entry.status === "ok" || entry.status === "unsupported" || entry.status === "unavailable")
    && (entry.at === null || (typeof entry.at === "number" && Number.isFinite(entry.at))) && rosterList(entry));
}
/** Unknown fields cannot be forwarded by a caller: only the recognized command is returned. */
export function parseConsoleSectionCommand(raw: string): ConsoleSectionCommand | null {
  if (new TextEncoder().encode(raw).length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value)) return null;
  const keys = ["request", "switch", "expanded", "add", "rename", "forget", "fold", "arrived", "manage", "lifecycle", "takeover", "update", "wsl", "unified", "createCommodore"].filter((key) => key in value);
  if (keys.length !== 1) return null;
  if (value.request === "state") return { request: "state" };
  if (clean(value.switch, 128)) {
    if ("commodore" in value && !clean(value.commodore, 128)) return null;
    if ("anchorY" in value && !anchor(value.anchorY)) return null;
    // A commander belongs to a commodore: alone it names nothing to open.
    if ("commander" in value && !(clean(value.commander, 128) && clean(value.commodore, 128))) return null;
    if ("scrollTop" in value && !anchor(value.scrollTop)) return null;
    // Like a commander, the right sidebar state belongs to an arrival, and there is none without a commodore.
    if ("rightPanel" in value && !(rightPanel(value.rightPanel) && clean(value.commodore, 128))) return null;
    return {
      switch: value.switch, ...(clean(value.commodore, 128) ? { commodore: value.commodore } : {}), ...(clean(value.commander, 128) ? { commander: value.commander } : {}),
      ...(anchor(value.anchorY) ? { anchorY: value.anchorY } : {}), ...(anchor(value.scrollTop) ? { scrollTop: value.scrollTop } : {}),
      ...(rightPanel(value.rightPanel) ? { rightPanel: { open: value.rightPanel.open, ...(value.rightPanel.tab !== undefined ? { tab: value.rightPanel.tab } : {}) } } : {}),
    };
  }
  if (object(value.fold) && clean(value.fold.id, 128) && typeof value.fold.folded === "boolean") return { fold: { id: value.fold.id, folded: value.fold.folded } };
  if (value.arrived === true) return { arrived: true };
  if (typeof value.expanded === "boolean") return { expanded: value.expanded };
  if (value.add === true) return { add: true };
  if (clean(value.forget, 128)) return { forget: value.forget };
  if (clean(value.manage, 128)) return { manage: value.manage };
  if (clean(value.takeover, 128)) return { takeover: value.takeover };
  if (clean(value.update, 128)) return { update: value.update };
  if ("unified" in value) {
    const unified = parseUnifiedSidebarCommand(value);
    return unified ? { unified } : null;
  }
  if ("createCommodore" in value) {
    const createCommodore = parseCreateCommodoreCommand(value);
    return createCommodore ? { createCommodore } : null;
  }
  if (object(value.wsl)) {
    if (value.wsl.list === true) return { wsl: { list: true } };
    if (clean(value.wsl.inspect, 64)) return { wsl: { inspect: value.wsl.inspect } };
    if (clean(value.wsl.add, 64)) return { wsl: { add: value.wsl.add } };
    return null;
  }
  if (object(value.lifecycle) && clean(value.lifecycle.id, 128) && isConsoleLifecycleAction(value.lifecycle.action)) {
    return { lifecycle: { id: value.lifecycle.id, action: value.lifecycle.action } };
  }
  if (object(value.rename) && clean(value.rename.id, 128) && clean(value.rename.label, 120) && value.rename.label.trim()) {
    return { rename: { id: value.rename.id, label: value.rename.label.trim() } };
  }
  return null;
}
const oneOf = (allowed: readonly string[], value: unknown): boolean => typeof value === "string" && allowed.includes(value);
const flag = (value: unknown): boolean => value === undefined || value === true;
export function isConsoleSectionState(value: unknown): value is ConsoleSectionState {
  if (!object(value) || value.v !== 1 || typeof value.expanded !== "boolean" || !Array.isArray(value.entries) || value.entries.length > 100) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > CONSOLE_SECTION_MAX_FRAME) return false; } catch { return false; }
  return value.entries.every((entry: unknown) => object(entry) && clean(entry.id, 128)
    && (entry.kind === "local" || entry.kind === "remote") && clean(entry.label, 120) && clean(entry.address, 255)
    && (entry.version === null || clean(entry.version, 64)) && typeof entry.active === "boolean" && typeof entry.home === "boolean"
    && [null, "ready", "unreachable", "untrusted", "stopping", "slow"].includes(entry.status as null)
    && (entry.management === undefined || oneOf(CONSOLE_MANAGEMENT_RELATIONS, entry.management))
    && (entry.path === undefined || oneOf(CONSOLE_ACCESS_PATHS, entry.path))
    && (entry.lifecycle === undefined || entry.lifecycle === null || oneOf(CONSOLE_MANAGED_LIFECYCLES, entry.lifecycle))
    && (entry.actions === undefined || (Array.isArray(entry.actions) && entry.actions.length <= CONSOLE_LIFECYCLE_ACTIONS.length && entry.actions.every(isConsoleLifecycleAction)))
    && (entry.managed === undefined || (object(entry.managed) && flag(entry.managed.installing) && flag(entry.managed.takeover) && flag(entry.managed.removable) && flag(entry.managed.updating)
      && (entry.managed.update === undefined || (object(entry.managed.update) && [entry.managed.update.node, entry.managed.update.console].every((part: unknown) => object(part) && clean(part.installed, 64) && clean(part.target, 64))))
      && (entry.managed.failure === undefined || oneOf(CONSOLE_MANAGED_FAILURES, entry.managed.failure)))));
}
export {
  CONSOLE_COMMODORE_CREATE_EVENT,
  CONSOLE_UNIFIED_SIDEBAR_CAPABILITY,
  CONSOLE_UNIFIED_SIDEBAR_EVENT,
  UNIFIED_CREATE_ALIAS_MAX,
  UNIFIED_CREATE_REASONS,
  UNIFIED_SIDEBAR_HOME,
  UNIFIED_SIDEBAR_MAX_FRAME,
  UNIFIED_SIDEBAR_MAX_ROWS,
  UNIFIED_SIDEBAR_MAX_SECTIONS,
  UNIFIED_SIDEBAR_PATH,
  isConsoleCommodoreCreateResult,
  applyUnifiedSidebarCommand,
  fitUnifiedSidebarState,
  isUnifiedSidebarLayout,
  isUnifiedSidebarState,
  projectUnifiedSidebar,
  reconcileUnifiedSidebar,
  seedUnifiedFromSnapshots,
  seedUnifiedSidebar,
  withoutUnifiedConsole,
} from "./unified-sidebar.js";
export type {
  ConsoleCommodoreCreateResult,
  UnifiedCreateReason,
  UnifiedSeedHome,
  UnifiedSeedMachine,
  UnifiedSidebarCommand,
  UnifiedSidebarLayout,
  UnifiedSidebarMachine,
  UnifiedSidebarMembership,
  UnifiedSidebarRef,
  UnifiedSidebarRow,
  UnifiedSidebarSection,
  UnifiedCommodoreLook,
  UnifiedMachineSnapshot,
  UnifiedSidebarState,
} from "./unified-sidebar.js";

export function isConsoleWslState(value: unknown): value is ConsoleWslState {
  if (!object(value) || value.v !== 1 || !Array.isArray(value.distros) || value.distros.length > 64) return false;
  if (!value.distros.every((distro: unknown) => object(distro) && clean(distro.name, 64) && typeof distro.running === "boolean" && [1, 2, null].includes(distro.version as null) && typeof distro.managed === "boolean")) return false;
  if (![null, "inspect"].includes(value.busy as null) || ![null, "unusable", "failed"].includes(value.error as null) || !(value.added === null || clean(value.added, 64))) return false;
  const seen = value.inspection;
  return seen === null || (object(seen) && clean(seen.distro, 64) && clean(seen.user, 64) && (seen.runtime === "ready" || seen.runtime === "missing")
    && Array.isArray(seen.missingTools) && seen.missingTools.length <= 8 && seen.missingTools.every((tool: unknown) => clean(tool, 32))
    && (seen.existing === "none" || seen.existing === "stale" || oneOf(CONSOLE_MANAGEMENT_RELATIONS, seen.existing)) && typeof seen.ownFleet === "boolean");
}
/** Desktop intercepts this navigation before it leaves the active document. */
export function consoleSectionCommandUrl(origin: string, command: ConsoleSectionCommand): string {
  const url = new URL("/console/", origin);
  url.searchParams.set("desktop-surface", CONSOLE_SECTION_COMMAND);
  url.searchParams.set("command", JSON.stringify(command));
  return url.toString();
}
