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

/** Renderer-only, minimized sidebar contract. Never publish its state through a Console server. */
export const CONSOLE_DIRECTORY_CAPABILITY = "console-directory";
export const CONSOLE_SECTION_COMMAND = "console-section-command";
export const CONSOLE_SECTION_EVENT = "fleet:console-section-state";
export const CONSOLE_SECTION_MAX_FRAME = 16_384;
export interface ConsoleSectionEntry {
  readonly id: string;
  /** Display only: which glyph and section the row gets. Never a permission; see `management` and `path`. */
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
}
export interface ConsoleSectionState {
  readonly v: 1;
  readonly expanded: boolean;
  readonly entries: readonly ConsoleSectionEntry[];
}
export type ConsoleSectionCommand = { readonly request: "state" } | { readonly switch: string }
  | { readonly expanded: boolean } | { readonly add: true }
  | { readonly rename: { readonly id: string; readonly label: string } } | { readonly forget: string }
  /** Opens the management surface for an entry. The surface is drawn by the home Console, never by the active document. */
  | { readonly manage: string }
  /** A lifecycle action on a managed entry. The shell honors it only from a document of the home Console. */
  | { readonly lifecycle: { readonly id: string; readonly action: ConsoleLifecycleAction } };
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Unknown fields cannot be forwarded by a caller: only the recognized command is returned. */
export function parseConsoleSectionCommand(raw: string): ConsoleSectionCommand | null {
  if (new TextEncoder().encode(raw).length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value)) return null;
  const keys = ["request", "switch", "expanded", "add", "rename", "forget", "manage", "lifecycle"].filter((key) => key in value);
  if (keys.length !== 1) return null;
  if (value.request === "state") return { request: "state" };
  if (clean(value.switch, 128)) return { switch: value.switch };
  if (typeof value.expanded === "boolean") return { expanded: value.expanded };
  if (value.add === true) return { add: true };
  if (clean(value.forget, 128)) return { forget: value.forget };
  if (clean(value.manage, 128)) return { manage: value.manage };
  if (object(value.lifecycle) && clean(value.lifecycle.id, 128) && isConsoleLifecycleAction(value.lifecycle.action)) {
    return { lifecycle: { id: value.lifecycle.id, action: value.lifecycle.action } };
  }
  if (object(value.rename) && clean(value.rename.id, 128) && clean(value.rename.label, 120) && value.rename.label.trim()) {
    return { rename: { id: value.rename.id, label: value.rename.label.trim() } };
  }
  return null;
}
const oneOf = (allowed: readonly string[], value: unknown): boolean => typeof value === "string" && allowed.includes(value);
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
    && (entry.actions === undefined || (Array.isArray(entry.actions) && entry.actions.length <= CONSOLE_LIFECYCLE_ACTIONS.length && entry.actions.every(isConsoleLifecycleAction))));
}
/** Desktop intercepts this navigation before it leaves the active document. */
export function consoleSectionCommandUrl(origin: string, command: ConsoleSectionCommand): string {
  const url = new URL("/console/", origin);
  url.searchParams.set("desktop-surface", CONSOLE_SECTION_COMMAND);
  url.searchParams.set("command", JSON.stringify(command));
  return url.toString();
}
