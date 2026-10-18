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
export type ConsoleSectionCommand = { readonly request: "state" } | { readonly switch: string }
  | { readonly expanded: boolean } | { readonly add: true }
  | { readonly rename: { readonly id: string; readonly label: string } } | { readonly forget: string };
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Unknown fields cannot be forwarded by a caller: only the recognized command is returned. */
export function parseConsoleSectionCommand(raw: string): ConsoleSectionCommand | null {
  if (new TextEncoder().encode(raw).length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value)) return null;
  const keys = ["request", "switch", "expanded", "add", "rename", "forget"].filter((key) => key in value);
  if (keys.length !== 1) return null;
  if (value.request === "state") return { request: "state" };
  if (clean(value.switch, 128)) return { switch: value.switch };
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
