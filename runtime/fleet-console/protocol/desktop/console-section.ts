/** Renderer-only, minimized sidebar contract. Never publish its state through a Console server. */
export const CONSOLE_DIRECTORY_CAPABILITY = "console-directory";
export const CONSOLE_SECTION_COMMAND = "console-section-command";
export const CONSOLE_SECTION_EVENT = "fleet:console-section-state";
export const CONSOLE_SECTION_MAX_FRAME = 16_384;
export interface ConsoleSectionEntry {
  readonly id: string;
  readonly kind: "local" | "remote";
  readonly label: string;
  readonly address: string;
  readonly version: string | null;
  readonly active: boolean;
  readonly home: boolean;
  readonly status: "ready" | "unreachable" | "untrusted" | "stopping" | "slow" | null;
}
export interface ConsoleSectionState {
  readonly v: 1;
  readonly expanded: boolean;
  readonly entries: readonly ConsoleSectionEntry[];
}
/**
 * `commodore` and `anchorY` ride only on `switch`: the commodore to open on arrival and the pressed row's top
 * inside the sidebar viewport (CSS px). A shell without `CONSOLE_ROSTER_CAPABILITY` ignores both and only switches.
 */
export type ConsoleSectionCommand = { readonly request: "state" }
  | { readonly switch: string; readonly commodore?: string; readonly anchorY?: number }
  | { readonly expanded: boolean } | { readonly add: true }
  | { readonly rename: { readonly id: string; readonly label: string } } | { readonly forget: string }
  | { readonly fold: { readonly id: string; readonly folded: boolean } } | { readonly arrived: true };

/**
 * A Console's own roster summary: names, looks, order and one run word. No previews, theaters or objectives.
 * `GET` only. Loopback follows the loopback API rule; the remote listener answers a live session or a valid
 * pairing cookie alone, and answering never opens a session or moves control. Everything else is 401.
 */
export const CONSOLE_ROSTER_PATH = "/api/v1/console-roster";
export const CONSOLE_ROSTER_MAX_COMMODORES = 40;
export type ConsoleRosterRun = "working" | "waiting" | "quiet";
export interface ConsoleRosterCommodore {
  readonly id: string;
  readonly name: string;
  /** The avatar book entry of that Console; null when it has none yet. */
  readonly look: { readonly base: string; readonly tone: string | null } | null;
  readonly run: ConsoleRosterRun;
}
export interface ConsoleRosterSummary {
  readonly v: 1;
  /** Sidebar order, at most `CONSOLE_ROSTER_MAX_COMMODORES`. */
  readonly commodores: readonly ConsoleRosterCommodore[];
  /** How many were left out by the cap. */
  readonly more: number;
}

/** The shell relays rosters and accepts `switch.commodore`, `fold` and `arrived`. */
export const CONSOLE_ROSTER_CAPABILITY = "console-roster";
/** Renderer-only, like the section state: the shell dispatches it on the active document's window. */
export const CONSOLE_ROSTER_EVENT = "fleet:console-roster-state";
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
}
export interface ConsoleRosterState {
  readonly v: 1;
  readonly rosters: readonly ConsoleRosterEntry[];
  /** Entry ids the person folded in this window. */
  readonly folded: readonly string[];
  /** Set for the document a `switch.commodore` landed on, until that document sends `arrived`. */
  readonly arrival: { readonly commodore: string; readonly anchorY: number | null } | null;
}
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const anchor = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000;
const rosterCommodore = (value: unknown): value is ConsoleRosterCommodore => object(value) && clean(value.id, 128) && clean(value.name, 120)
  && (value.look === null || (object(value.look) && clean(value.look.base, 64) && (value.look.tone === null || clean(value.look.tone, 64))))
  && (value.run === "working" || value.run === "waiting" || value.run === "quiet");
const rosterList = (value: Record<string, unknown>): boolean => Array.isArray(value.commodores) && value.commodores.length <= CONSOLE_ROSTER_MAX_COMMODORES
  && value.commodores.every(rosterCommodore) && Number.isSafeInteger(value.more) && (value.more as number) >= 0;
export function isConsoleRosterSummary(value: unknown): value is ConsoleRosterSummary {
  return object(value) && value.v === 1 && rosterList(value);
}
export function isConsoleRosterState(value: unknown): value is ConsoleRosterState {
  if (!object(value) || value.v !== 1 || !Array.isArray(value.rosters) || value.rosters.length > 100 || !Array.isArray(value.folded) || value.folded.length > 100) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > CONSOLE_ROSTER_MAX_FRAME) return false; } catch { return false; }
  if (!value.folded.every((id: unknown) => clean(id, 128))) return false;
  if (value.arrival !== null && !(object(value.arrival) && clean(value.arrival.commodore, 128) && (value.arrival.anchorY === null || anchor(value.arrival.anchorY)))) return false;
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
  const keys = ["request", "switch", "expanded", "add", "rename", "forget", "fold", "arrived"].filter((key) => key in value);
  if (keys.length !== 1) return null;
  if (value.request === "state") return { request: "state" };
  if (clean(value.switch, 128)) {
    if ("commodore" in value && !clean(value.commodore, 128)) return null;
    if ("anchorY" in value && !anchor(value.anchorY)) return null;
    return { switch: value.switch, ...(clean(value.commodore, 128) ? { commodore: value.commodore } : {}), ...(anchor(value.anchorY) ? { anchorY: value.anchorY } : {}) };
  }
  if (object(value.fold) && clean(value.fold.id, 128) && typeof value.fold.folded === "boolean") return { fold: { id: value.fold.id, folded: value.fold.folded } };
  if (value.arrived === true) return { arrived: true };
  if (typeof value.expanded === "boolean") return { expanded: value.expanded };
  if (value.add === true) return { add: true };
  if (clean(value.forget, 128)) return { forget: value.forget };
  if (object(value.rename) && clean(value.rename.id, 128) && clean(value.rename.label, 120) && value.rename.label.trim()) {
    return { rename: { id: value.rename.id, label: value.rename.label.trim() } };
  }
  return null;
}
export function isConsoleSectionState(value: unknown): value is ConsoleSectionState {
  if (!object(value) || value.v !== 1 || typeof value.expanded !== "boolean" || !Array.isArray(value.entries) || value.entries.length > 100) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > CONSOLE_SECTION_MAX_FRAME) return false; } catch { return false; }
  return value.entries.every((entry: unknown) => object(entry) && clean(entry.id, 128)
    && (entry.kind === "local" || entry.kind === "remote") && clean(entry.label, 120) && clean(entry.address, 255)
    && (entry.version === null || clean(entry.version, 64)) && typeof entry.active === "boolean" && typeof entry.home === "boolean"
    && [null, "ready", "unreachable", "untrusted", "stopping", "slow"].includes(entry.status as null));
}
/** Desktop intercepts this navigation before it leaves the active document. */
export function consoleSectionCommandUrl(origin: string, command: ConsoleSectionCommand): string {
  const url = new URL("/console/", origin);
  url.searchParams.set("desktop-surface", CONSOLE_SECTION_COMMAND);
  url.searchParams.set("command", JSON.stringify(command));
  return url.toString();
}
