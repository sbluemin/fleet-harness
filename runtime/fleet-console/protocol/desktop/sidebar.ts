/** Sidebar requests are not screen sessions. The shell resolves a window-owned id, verifies the
 * target's pin, and relays only these operations. Neither join nor arbitrary URLs are accepted. */
export const CONSOLE_SIDEBAR_CAPABILITY = "console-sidebar";
export const CONSOLE_SIDEBAR_EVENT = "fleet:console-sidebar-reply";
export const CONSOLE_SIDEBAR_PATH = "/api/v1/console-sidebar/";
export const SIDEBAR_CHUNK_CHARS = 48_000;
export const SIDEBAR_MAX_BYTES = 16 * 1024 * 1024;

export const SIDEBAR_OPERATIONS = {
  folders: { method: "POST", path: "theaters/folder-listings", read: true },
  folderGrant: { method: "POST", path: "theaters/folder-grants", read: false },
  addTheater: { method: "POST", path: "commodore/theaters/add", read: false },
  computerUse: { method: "POST", path: "console-roster/computer-use", read: false },
  objective: { method: "GET", path: "console-roster/objective-full", read: true },
  runtime: { method: "GET", path: "console-roster/runtime", read: true },
  changes: { method: "GET", path: "console-roster/changes", read: true },
  shared: { method: "GET", path: "objectives/shared/list", read: true },
  sharedFile: { method: "GET", path: "objectives/shared/file", read: true },
  sharedChunk: { method: "GET", path: "objectives/shared/chunk", read: true },
  evidence: { method: "GET", path: "objectives/result/file", read: true },
  alias: { method: "POST", path: "commodore/alias", read: false },
  patch: { method: "POST", path: "objectives/objective/patch", read: false },
  archive: { method: "POST", path: "objectives/objective/archive", read: false },
  complete: { method: "POST", path: "objectives/objective/complete", read: false },
  createCommodore: { method: "POST", path: "commodore/create", read: false },
  deletePreview: { method: "POST", path: "commodore/delete-preview", read: true },
  deleteCommodore: { method: "POST", path: "commodore/delete", read: false },
  groupCreate: { method: "POST", path: "objectives/records/groups", read: false },
  saveSettings: { method: "POST", path: "console-roster/preferences", read: false },
  taskforces: { method: "POST", path: "taskforce/list", read: true },
  taskforceCreate: { method: "POST", path: "taskforce/create", read: false },
  taskforceUpdate: { method: "POST", path: "taskforce/update", read: false },
  taskforceDelete: { method: "POST", path: "taskforce/delete", read: false },
} as const;
export type SidebarOperation = keyof typeof SIDEBAR_OPERATIONS;
export interface ConsoleSidebarRequest {
  readonly console: string;
  readonly nonce: string;
  readonly operation: SidebarOperation;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
}
export interface ConsoleSidebarReply {
  readonly console: string;
  readonly nonce: string;
  readonly status: number;
  readonly type: string;
  /** Base64 bytes. Each event is bounded; done closes this request, not the screen session. */
  readonly data: string;
  readonly index: number;
  readonly done: boolean;
}
const SIDEBAR_PRIVATE_FIELDS = new Set(["sessionName", "providerSession", "cwd", "canonicalCwd", "transcriptPath", "token", "ticket", "realpath"]);
/** JSON responses never turn the shell into a route for provider coordinates or credentials. */
export function sidebarDisplayJson(text: string): string {
  return JSON.stringify(JSON.parse(text), (key, value: unknown) => SIDEBAR_PRIVATE_FIELDS.has(key) ? null : value);
}
const clean = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(v);
export function sidebarOperation(value: unknown): SidebarOperation | null {
  return typeof value === "string" && Object.hasOwn(SIDEBAR_OPERATIONS, value) ? value as SidebarOperation : null;
}
export function parseSidebarRequest(value: unknown): ConsoleSidebarRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const operation = sidebarOperation(v.operation);
  if (!clean(v.console) || !clean(v.nonce) || !operation) return null;
  if (v.query !== undefined && (!v.query || typeof v.query !== "object" || Array.isArray(v.query)
    || Object.entries(v.query).some(([key, text]) => !["objectiveId", "resultId", "path", "download", "commodoreId", "offset", "after", "version"].includes(key) || typeof text !== "string" || text.length > 2048 || /[\u0000-\u001f\u007f]/u.test(text)))) return null;
  try { if (JSON.stringify(value).length > 16_000) return null; } catch { return null; }
  return { console: v.console, nonce: v.nonce, operation, ...(v.body !== undefined ? { body: v.body } : {}), ...(v.query ? { query: v.query as Record<string, string> } : {}) };
}
export function sidebarTarget(pathname: string): { readonly operation: SidebarOperation; readonly path: string; readonly method: string; readonly read: boolean } | null {
  if (!pathname.startsWith(CONSOLE_SIDEBAR_PATH)) return null;
  const operation = sidebarOperation(pathname.slice(CONSOLE_SIDEBAR_PATH.length));
  return operation ? { operation, ...SIDEBAR_OPERATIONS[operation] } : null;
}
