/**
 * Unified sidebar placement for one viewing computer.
 *
 * The home Console stores this. It is not that Console's own `commodoreSidebar`: other machines'
 * commodores are named here, and writing this never rewrites a machine's own sections. A document
 * reads and edits it only through the shell (`CONSOLE_UNIFIED_SIDEBAR_EVENT` / `unified` commands).
 * The shell persists it on the home Console with `UNIFIED_SIDEBAR_PATH`. An old shell has no
 * capability and ignores the commands; an old page never sends them.
 *
 * `consoleId` is durable: `UNIFIED_SIDEBAR_HOME` for this computer's home Console, a known-hosts
 * record id for a remote Console, or a managed-console registration key. It is never the
 * window-opaque section id. Disconnect keeps the rows. Forgetting a machine drops only its rows
 * (`withoutUnifiedConsole`).
 *
 * The shell seeds once, when the stored layout is absent, from the home sections plus each other
 * machine's roster (`seedUnifiedSidebar`). The home Console cannot seed: it does not hold the
 * other rosters. After `seeded`, the shell does not seed again.
 */

export const UNIFIED_SIDEBAR_HOME = "home";
export const CONSOLE_UNIFIED_SIDEBAR_CAPABILITY = "console-unified-sidebar";
export const CONSOLE_UNIFIED_SIDEBAR_EVENT = "fleet:console-unified-sidebar-state";
export const CONSOLE_COMMODORE_CREATE_EVENT = "fleet:console-commodore-create";
/** Loopback listener of the home Console only. The shell's main process calls it; a document does not. */
export const UNIFIED_SIDEBAR_PATH = "/api/v1/desktop/unified-sidebar";
export const UNIFIED_SIDEBAR_MAX_SECTIONS = 100;
export const UNIFIED_SIDEBAR_MAX_ROWS = 200;
export const UNIFIED_SIDEBAR_MAX_FRAME = 65_536;
/** Matches the commodore alias cap. The protocol package cannot import the commodore feature. */
export const UNIFIED_CREATE_ALIAS_MAX = 40;
export const UNIFIED_CREATE_REASONS = ["unreachable", "untrusted", "access", "unavailable", "invalid", "unsupported"] as const;
export type UnifiedCreateReason = (typeof UNIFIED_CREATE_REASONS)[number];

export interface UnifiedSidebarSection {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
}
export interface UnifiedSidebarRef {
  readonly consoleId: string;
  readonly commodoreId: string;
}
export interface UnifiedSidebarMembership extends UnifiedSidebarRef {
  readonly sectionId: string;
}
export interface UnifiedSidebarLayout {
  readonly v: 1;
  readonly seeded: boolean;
  readonly sections: readonly UnifiedSidebarSection[];
  readonly membership: readonly UnifiedSidebarMembership[];
  readonly order: readonly UnifiedSidebarRef[];
  readonly unsectionedCollapsed: boolean;
}

/** What the shell tells every document about one machine, including machines that contribute no row. */
export interface UnifiedSidebarMachine {
  readonly consoleId: string;
  readonly label: string;
  readonly address: string;
  readonly home: boolean;
  readonly kind: "local" | "remote";
  /** Absent on a shell or entry from before access paths. */
  readonly path?: "loopback" | "wsl" | "remote";
  readonly status: "ready" | "unreachable" | "untrusted" | "stopping" | "slow" | null;
  /** False when the create dialog must not offer this machine. Home is true while it answers. */
  readonly creatable: boolean;
  readonly createBlock?: UnifiedCreateReason;
}

/**
 * One commodore in the unified list. `home` rows draw no machine chip. `machineLabel`, `machineAddress`,
 * and `status` are the chip and its card. Roster fields match `ConsoleRosterCommodore` so a remote row
 * can be drawn without a second read; they are absent on a shell that only has the name.
 */
export interface UnifiedSidebarRow extends UnifiedSidebarRef {
  readonly name: string;
  readonly home: boolean;
  readonly machineLabel: string;
  readonly machineAddress: string;
  readonly status: UnifiedSidebarMachine["status"];
  readonly look?: { readonly base: number; readonly tone: string | null } | null;
  readonly run?: "working" | "waiting" | "quiet";
  readonly preview?: string;
  readonly commanders?: readonly { readonly id: string; readonly title: string; readonly done: number; readonly total: number; readonly run: "working" | "waiting" | "quiet" }[];
  readonly moreCommanders?: number;
}

export interface UnifiedSidebarState {
  readonly v: 1;
  readonly layout: UnifiedSidebarLayout;
  readonly machines: readonly UnifiedSidebarMachine[];
  readonly rows: readonly UnifiedSidebarRow[];
}

export type UnifiedSidebarCommand =
  | { readonly op: "state" }
  | { readonly op: "move"; readonly row: UnifiedSidebarRef; readonly sectionId: string | null; readonly target?: UnifiedSidebarRef; readonly after?: boolean }
  | { readonly op: "create"; readonly name: string; readonly afterId?: string; readonly row?: UnifiedSidebarRef }
  | { readonly op: "rename"; readonly sectionId: string; readonly name: string }
  | { readonly op: "reorder"; readonly sectionId: string; readonly direction: "up" | "down" }
  | { readonly op: "collapse"; readonly sectionId: string | null; readonly collapsed: boolean }
  | { readonly op: "delete"; readonly sectionId: string; readonly confirm: true };

export type ConsoleCommodoreCreateResult =
  | { readonly v: 1; readonly request: string; readonly consoleId: string; readonly ok: true; readonly commodoreId: string }
  | { readonly v: 1; readonly request: string; readonly consoleId: string; readonly ok: false; readonly reason: UnifiedCreateReason };

export interface UnifiedSeedHome {
  readonly sections: readonly { readonly id: string; readonly name: string; readonly collapsed: boolean }[];
  readonly membership: Readonly<Record<string, string>>;
  readonly order: readonly string[];
  readonly unsectionedCollapsed: boolean;
}
export interface UnifiedSeedMachine {
  readonly consoleId: string;
  readonly sections: readonly { readonly id: string; readonly name: string; readonly collapsed?: true }[];
  readonly commodores: readonly { readonly id: string; readonly section?: string }[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const aliasOk = (value: unknown): value is string => typeof value === "string" && [...value.trim()].length > 0 && [...value.trim()].length <= UNIFIED_CREATE_ALIAS_MAX && !CONTROL.test(value.trim());
const asRef = (value: unknown): UnifiedSidebarRef | null => record(value) && consoleIdOk(value.consoleId) && clean(value.commodoreId, 128) ? { consoleId: value.consoleId, commodoreId: value.commodoreId } : null;
const consoleIdOk = (value: unknown): value is string => value === UNIFIED_SIDEBAR_HOME || clean(value, 128);
const sectionName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80 && !CONTROL.test(value.trim());

/** Drops a forgotten machine's rows. Home cannot be forgotten here. Sections stay; they may still hold other machines. */
export function withoutUnifiedConsole(layout: UnifiedSidebarLayout, consoleId: string): UnifiedSidebarLayout {
  if (consoleId === UNIFIED_SIDEBAR_HOME || !clean(consoleId, 128)) return layout;
  return {
    ...layout,
    membership: layout.membership.filter((row) => row.consoleId !== consoleId),
    order: layout.order.filter((row) => row.consoleId !== consoleId),
  };
}

/**
 * First placement. Home section names win. A remote commodore joins the home section of the same
 * trimmed name; a name the home does not have is appended, collapsed as that machine stored it.
 * A commodore with no section on its machine stays unsectioned. `id` must return a fresh section id
 * each call. Does not read or write a machine's own sidebar.
 */
export function seedUnifiedSidebar(home: UnifiedSeedHome, machines: readonly UnifiedSeedMachine[], id: () => string): UnifiedSidebarLayout {
  const sections: UnifiedSidebarSection[] = [];
  const byName = new Map<string, string>();
  const homeSectionById = new Map<string, string>();
  const addSection = (name: string, collapsed: boolean): string | null => {
    if (sections.length >= UNIFIED_SIDEBAR_MAX_SECTIONS) return null;
    const next = id();
    if (!clean(next, 128) || sections.some((section) => section.id === next)) return null;
    sections.push({ id: next, name, collapsed });
    return next;
  };
  for (const section of home.sections) {
    const name = typeof section.name === "string" ? section.name.trim() : "";
    if (!sectionName(name) || !clean(section.id, 128)) continue;
    const created = addSection(name, section.collapsed === true);
    if (!created) continue;
    homeSectionById.set(section.id, created);
    if (!byName.has(name)) byName.set(name, created);
  }
  const membership: UnifiedSidebarMembership[] = [];
  const order: UnifiedSidebarRef[] = [];
  const seen = new Set<string>();
  const push = (consoleId: string, commodoreId: string, sectionId: string | null) => {
    if (order.length >= UNIFIED_SIDEBAR_MAX_ROWS) return;
    const key = `${consoleId}\n${commodoreId}`;
    if (seen.has(key) || !consoleIdOk(consoleId) || !clean(commodoreId, 128)) return;
    seen.add(key);
    order.push({ consoleId, commodoreId });
    if (sectionId && sections.some((section) => section.id === sectionId)) membership.push({ consoleId, commodoreId, sectionId });
  };
  const homeIds = [...home.order, ...Object.keys(home.membership)];
  for (const commodoreId of homeIds) {
    const previous = home.membership[commodoreId];
    push(UNIFIED_SIDEBAR_HOME, commodoreId, previous ? homeSectionById.get(previous) ?? null : null);
  }
  for (const machine of machines) {
    if (!clean(machine.consoleId, 128) || machine.consoleId === UNIFIED_SIDEBAR_HOME) continue;
    const remoteName = new Map<string, string>();
    for (const section of machine.sections) {
      const name = typeof section.name === "string" ? section.name.trim() : "";
      if (!sectionName(name) || !clean(section.id, 128)) continue;
      remoteName.set(section.id, name);
      if (!byName.has(name)) {
        const created = addSection(name, section.collapsed === true);
        if (created) byName.set(name, created);
      }
    }
    for (const commodore of machine.commodores) {
      const name = commodore.section ? remoteName.get(commodore.section) : undefined;
      push(machine.consoleId, commodore.id, name ? byName.get(name) ?? null : null);
    }
  }
  return { v: 1, seeded: true, sections, membership, order, unsectionedCollapsed: home.unsectionedCollapsed === true };
}

export function isUnifiedSidebarLayout(value: unknown): value is UnifiedSidebarLayout {
  if (!record(value) || value.v !== 1 || typeof value.seeded !== "boolean" || typeof value.unsectionedCollapsed !== "boolean") return false;
  if (!Array.isArray(value.sections) || value.sections.length > UNIFIED_SIDEBAR_MAX_SECTIONS) return false;
  if (!Array.isArray(value.membership) || value.membership.length > UNIFIED_SIDEBAR_MAX_ROWS) return false;
  if (!Array.isArray(value.order) || value.order.length > UNIFIED_SIDEBAR_MAX_ROWS) return false;
  const ids = new Set<string>();
  for (const section of value.sections) {
    if (!record(section) || !clean(section.id, 128) || !sectionName(section.name) || section.name !== section.name.trim() || typeof section.collapsed !== "boolean" || ids.has(section.id)) return false;
    ids.add(section.id);
  }
  const rows = new Set<string>();
  for (const row of value.order) {
    const ref = asRef(row);
    if (!ref) return false;
    const key = `${ref.consoleId}\n${ref.commodoreId}`;
    if (rows.has(key)) return false;
    rows.add(key);
  }
  const placed = new Set<string>();
  for (const row of value.membership) {
    const ref = asRef(row);
    if (!ref || !record(row) || !clean(row.sectionId, 128) || !ids.has(row.sectionId)) return false;
    const key = `${ref.consoleId}\n${ref.commodoreId}`;
    if (placed.has(key) || !rows.has(key)) return false;
    placed.add(key);
  }
  return true;
}

const statusOk = (value: unknown): value is UnifiedSidebarMachine["status"] => value === null || value === "ready" || value === "unreachable" || value === "untrusted" || value === "stopping" || value === "slow";
const reasonOk = (value: unknown): value is UnifiedCreateReason => typeof value === "string" && (UNIFIED_CREATE_REASONS as readonly string[]).includes(value);
const runOk = (value: unknown): boolean => value === "working" || value === "waiting" || value === "quiet";

export function isUnifiedSidebarState(value: unknown): value is UnifiedSidebarState {
  if (!record(value) || value.v !== 1 || !isUnifiedSidebarLayout(value.layout)) return false;
  if (!Array.isArray(value.machines) || value.machines.length > 100 || !Array.isArray(value.rows) || value.rows.length > UNIFIED_SIDEBAR_MAX_ROWS) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > UNIFIED_SIDEBAR_MAX_FRAME) return false; } catch { return false; }
  const machineOk = value.machines.every((machine) => record(machine) && consoleIdOk(machine.consoleId) && clean(machine.label, 120) && clean(machine.address, 255)
    && typeof machine.home === "boolean" && (machine.kind === "local" || machine.kind === "remote") && statusOk(machine.status) && typeof machine.creatable === "boolean"
    && (machine.path === undefined || machine.path === "loopback" || machine.path === "wsl" || machine.path === "remote")
    && (machine.createBlock === undefined || reasonOk(machine.createBlock)));
  if (!machineOk) return false;
  return value.rows.every((row: unknown) => {
    if (!record(row) || !asRef(row) || !clean(row.name, 120) || typeof row.home !== "boolean" || !clean(row.machineLabel, 120) || !clean(row.machineAddress, 255) || !statusOk(row.status)) return false;
    if (row.run !== undefined && !runOk(row.run)) return false;
    if (row.preview !== undefined && !clean(row.preview, 160)) return false;
    const more = row.moreCommanders;
    if (more !== undefined && (typeof more !== "number" || !Number.isSafeInteger(more) || more < 0)) return false;
    const look = row.look;
    if (look !== undefined && look !== null && !(record(look) && typeof look.base === "number" && Number.isSafeInteger(look.base) && look.base >= 0 && (look.tone === null || clean(look.tone, 64)))) return false;
    if (row.commanders === undefined) return true;
    return Array.isArray(row.commanders) && row.commanders.length <= 8 && row.commanders.every((commander: unknown) => {
      if (!record(commander) || !clean(commander.id, 128) || !clean(commander.title, 120) || !runOk(commander.run)) return false;
      const done = commander.done;
      const total = commander.total;
      return typeof done === "number" && typeof total === "number" && Number.isSafeInteger(done) && Number.isSafeInteger(total) && done >= 0 && total >= done;
    });
  });
}

export function isConsoleCommodoreCreateResult(value: unknown): value is ConsoleCommodoreCreateResult {
  if (!record(value) || value.v !== 1 || !clean(value.request, 128) || !consoleIdOk(value.consoleId) || typeof value.ok !== "boolean") return false;
  if (value.ok === true) return clean(value.commodoreId, 128);
  return reasonOk(value.reason);
}

export function parseUnifiedSidebarCommand(value: Record<string, unknown>): UnifiedSidebarCommand | null {
  const command = value.unified;
  if (!record(command)) return null;
  const keys = Object.keys(command);
  if (command.op === "state" && keys.length === 1) return { op: "state" };
  const moveRow = command.op === "move" ? asRef(command.row) : null;
  const moveTarget = command.op === "move" && command.target !== undefined ? asRef(command.target) : null;
  if (command.op === "move" && moveRow && (command.sectionId === null || clean(command.sectionId, 128))
    && (command.target === undefined || moveTarget) && (command.after === undefined || typeof command.after === "boolean")
    && keys.every((key) => key === "op" || key === "row" || key === "sectionId" || key === "target" || key === "after")) {
    return { op: "move", row: moveRow, sectionId: command.sectionId, ...(moveTarget ? { target: moveTarget } : {}), ...(command.after === true ? { after: true } : {}) };
  }
  const createRow = command.op === "create" && command.row !== undefined ? asRef(command.row) : null;
  if (command.op === "create" && sectionName(command.name) && (command.afterId === undefined || clean(command.afterId, 128)) && (command.row === undefined || createRow)
    && keys.every((key) => key === "op" || key === "name" || key === "afterId" || key === "row")) {
    return { op: "create", name: command.name.trim(), ...(command.afterId ? { afterId: command.afterId } : {}), ...(createRow ? { row: createRow } : {}) };
  }
  if (command.op === "rename" && keys.length === 3 && clean(command.sectionId, 128) && sectionName(command.name)) return { op: "rename", sectionId: command.sectionId, name: command.name.trim() };
  if (command.op === "reorder" && keys.length === 3 && clean(command.sectionId, 128) && (command.direction === "up" || command.direction === "down")) return { op: "reorder", sectionId: command.sectionId, direction: command.direction };
  if (command.op === "collapse" && keys.length === 3 && (command.sectionId === null || clean(command.sectionId, 128)) && typeof command.collapsed === "boolean") return { op: "collapse", sectionId: command.sectionId, collapsed: command.collapsed };
  if (command.op === "delete" && keys.length === 3 && clean(command.sectionId, 128) && command.confirm === true) return { op: "delete", sectionId: command.sectionId, confirm: true };
  return null;
}

export function parseCreateCommodoreCommand(value: Record<string, unknown>): { readonly consoleId: string; readonly alias: string; readonly request: string } | null {
  const command = value.createCommodore;
  if (!record(command) || Object.keys(command).length !== 3 || !consoleIdOk(command.consoleId) || !clean(command.request, 128) || !aliasOk(command.alias)) return null;
  return { consoleId: command.consoleId, alias: command.alias.trim(), request: command.request };
}
