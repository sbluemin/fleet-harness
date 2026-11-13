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
  /**
   * The window's opaque `ConsoleSectionEntry.id`, so this document can switch or manage that machine.
   * The shell fills it for this window only. It is not stored in the layout and never grants a permission.
   * Absent when a shell from before this field built the state.
   */
  readonly entryId?: string;
}

/**
 * One commodore in the unified list. `home` rows draw no machine chip. `machineLabel`, `machineAddress`,
 * and `status` are the chip and its card. Roster fields match `ConsoleRosterCommodore` so a remote row
 * can be drawn without a second read; they are absent on a shell that only has the name.
 */
export interface UnifiedSidebarRow extends UnifiedSidebarRef {
  readonly name: string;
  readonly home: boolean;
  /** Same window-opaque id as `UnifiedSidebarMachine.entryId`. Absent on an older shell. */
  readonly entryId?: string;
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

/** Optional face chosen in the create dialog. Absent: the machine keeps its own default. An old shell ignores it. */
export interface UnifiedCommodoreLook { readonly base: number; readonly tone: string | null }

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

export interface UnifiedMachineSnapshot {
  readonly consoleId: string;
  readonly label: string;
  readonly address: string;
  readonly home: boolean;
  readonly kind: "local" | "remote";
  readonly path?: UnifiedSidebarMachine["path"];
  readonly status: UnifiedSidebarMachine["status"];
  /** Window-opaque section id. Not part of the stored layout. */
  readonly entryId?: string;
  /** null before the first read. `unavailable` keeps the last commodore list and must not drop placement. */
  readonly roster: {
    readonly status: "ok" | "unsupported" | "unavailable";
    /** Commodores the route left out. Above zero, the list is not a complete deletion set. */
    readonly more: number;
    readonly sections: readonly { readonly id: string; readonly name: string; readonly collapsed?: true }[];
    readonly unsectionedCollapsed?: true;
    readonly commodores: readonly { readonly id: string; readonly name: string; readonly section?: string; readonly look?: UnifiedSidebarRow["look"]; readonly run?: UnifiedSidebarRow["run"]; readonly preview?: string; readonly commanders?: UnifiedSidebarRow["commanders"]; readonly moreCommanders?: number }[];
  } | null;
}

const sameRow = (left: UnifiedSidebarRef, right: UnifiedSidebarRef): boolean => left.consoleId === right.consoleId && left.commodoreId === right.commodoreId;
const sectionOf = (layout: UnifiedSidebarLayout, row: UnifiedSidebarRef): string | null => layout.membership.find((item) => sameRow(item, row))?.sectionId ?? null;

function createOffer(snapshot: UnifiedMachineSnapshot): { readonly creatable: boolean; readonly createBlock?: UnifiedCreateReason } {
  if (snapshot.status === "untrusted") return { creatable: false, createBlock: "untrusted" };
  if (snapshot.status === "unreachable") return { creatable: false, createBlock: "unreachable" };
  if (snapshot.status === "stopping" || snapshot.roster === null || snapshot.roster.status === "unavailable") return { creatable: false, createBlock: "unavailable" };
  return { creatable: true };
}

/** First layout, once the home roster has been read. Machines that are not `ok` yet are left for a later admit. */
export function seedUnifiedFromSnapshots(snapshots: readonly UnifiedMachineSnapshot[], id: () => string): UnifiedSidebarLayout | null {
  const home = snapshots.find((snapshot) => snapshot.home && snapshot.consoleId === UNIFIED_SIDEBAR_HOME);
  if (!home?.roster || home.roster.status !== "ok") return null;
  const membership: Record<string, string> = {};
  for (const commodore of home.roster.commodores) if (commodore.section) membership[commodore.id] = commodore.section;
  return seedUnifiedSidebar({
    sections: home.roster.sections.map((section) => ({ id: section.id, name: section.name, collapsed: section.collapsed === true })),
    membership, order: home.roster.commodores.map((commodore) => commodore.id), unsectionedCollapsed: home.roster.unsectionedCollapsed === true,
  }, snapshots.filter((snapshot) => !snapshot.home && snapshot.roster?.status === "ok").map((snapshot) => ({
    consoleId: snapshot.consoleId,
    sections: snapshot.roster?.sections ?? [],
    commodores: (snapshot.roster?.commodores ?? []).map((commodore) => ({ id: commodore.id, ...(commodore.section ? { section: commodore.section } : {}) })),
  })), id);
}

/**
 * Drops commodores a complete roster (`more === 0`) no longer lists, and places commodores that were not in the layout yet
 * by the same name rule as the first seed. An incomplete roster keeps placements it omitted. An `unavailable` roster changes nothing.
 */
export function reconcileUnifiedSidebar(layout: UnifiedSidebarLayout, snapshots: readonly UnifiedMachineSnapshot[], id: () => string): UnifiedSidebarLayout {
  let order = layout.order.filter((row) => {
    const snapshot = snapshots.find((item) => item.consoleId === row.consoleId);
    if (!snapshot?.roster || snapshot.roster.status !== "ok" || snapshot.roster.more > 0) return true;
    return snapshot.roster.commodores.some((commodore) => commodore.id === row.commodoreId);
  });
  let membership = layout.membership.filter((row) => order.some((item) => sameRow(item, row)));
  const sections = layout.sections.map((section) => ({ ...section }));
  const byName = new Map<string, string>();
  for (const section of sections) if (!byName.has(section.name)) byName.set(section.name, section.id);
  const seen = new Set(order.map((row) => `${row.consoleId}\n${row.commodoreId}`));
  for (const snapshot of snapshots) {
    if (snapshot.roster?.status !== "ok") continue;
    const names = new Map(snapshot.roster.sections.map((section) => [section.id, section.name.trim()]));
    for (const commodore of snapshot.roster.commodores) {
      const key = `${snapshot.consoleId}\n${commodore.id}`;
      if (seen.has(key) || order.length >= UNIFIED_SIDEBAR_MAX_ROWS || !clean(commodore.id, 128)) continue;
      seen.add(key);
      const remoteName = commodore.section ? names.get(commodore.section) : undefined;
      let sectionId = remoteName ? byName.get(remoteName) ?? null : null;
      if (remoteName && !sectionId && sectionName(remoteName) && sections.length < UNIFIED_SIDEBAR_MAX_SECTIONS) {
        const created = id();
        if (clean(created, 128) && !sections.some((section) => section.id === created)) {
          const source = snapshot.roster.sections.find((section) => section.id === commodore.section);
          sections.push({ id: created, name: remoteName, collapsed: source?.collapsed === true });
          byName.set(remoteName, created);
          sectionId = created;
        }
      }
      order.push({ consoleId: snapshot.consoleId, commodoreId: commodore.id });
      if (sectionId) membership.push({ consoleId: snapshot.consoleId, commodoreId: commodore.id, sectionId });
    }
  }
  const next = { v: 1 as const, seeded: true, sections, membership, order, unsectionedCollapsed: layout.unsectionedCollapsed };
  return isUnifiedSidebarLayout(next) ? next : layout;
}

export function applyUnifiedSidebarCommand(layout: UnifiedSidebarLayout, command: UnifiedSidebarCommand, id: () => string): UnifiedSidebarLayout | null {
  if (command.op === "state") return layout;
  const sections = layout.sections.map((section) => ({ ...section }));
  let membership = layout.membership.map((row) => ({ ...row }));
  let order = layout.order.map((row) => ({ ...row }));
  let unsectionedCollapsed = layout.unsectionedCollapsed;
  const indexOf = (sectionId: string) => sections.findIndex((section) => section.id === sectionId);
  if (command.op === "create") {
    if (sections.length >= UNIFIED_SIDEBAR_MAX_SECTIONS) return null;
    const after = command.afterId ? indexOf(command.afterId) : -1;
    if (command.afterId && after < 0) return null;
    const created = id();
    if (!clean(created, 128) || sections.some((section) => section.id === created)) return null;
    sections.splice(command.afterId ? after + 1 : 0, 0, { id: created, name: command.name, collapsed: false });
    if (command.row && !order.some((row) => sameRow(row, command.row!))) order.push({ consoleId: command.row.consoleId, commodoreId: command.row.commodoreId });
    if (command.row) {
      membership = membership.filter((row) => !sameRow(row, command.row!));
      membership.push({ consoleId: command.row.consoleId, commodoreId: command.row.commodoreId, sectionId: created });
    }
  } else if (command.op === "collapse" && command.sectionId === null) unsectionedCollapsed = command.collapsed;
  else if (command.op === "move") {
    if (command.sectionId !== null && indexOf(command.sectionId) < 0) return null;
    if (command.target) {
      const targetSection = sectionOf({ ...layout, membership }, command.target);
      if (targetSection !== command.sectionId) return null;
    }
    if (!order.some((row) => sameRow(row, command.row))) order.push({ consoleId: command.row.consoleId, commodoreId: command.row.commodoreId });
    membership = membership.filter((row) => !sameRow(row, command.row));
    if (command.sectionId) membership.push({ consoleId: command.row.consoleId, commodoreId: command.row.commodoreId, sectionId: command.sectionId });
    order = order.filter((row) => !sameRow(row, command.row));
    const draft = { ...layout, membership };
    const last = [...order].reverse().find((row) => sectionOf(draft, row) === command.sectionId);
    const anchor = command.target ?? last;
    const at = anchor ? order.findIndex((row) => sameRow(row, anchor)) : -1;
    const index = at < 0 ? order.length : at + (command.target ? Number(command.after === true) : 1);
    order.splice(index, 0, { consoleId: command.row.consoleId, commodoreId: command.row.commodoreId });
  } else {
    const sectionId = command.op === "collapse" ? command.sectionId : command.sectionId;
    if (!sectionId) return null;
    const index = indexOf(sectionId);
    if (index < 0) return null;
    if (command.op === "rename") sections[index] = { ...sections[index]!, name: command.name };
    else if (command.op === "collapse") sections[index] = { ...sections[index]!, collapsed: command.collapsed };
    else if (command.op === "reorder") {
      const next = index + (command.direction === "up" ? -1 : 1);
      if (next >= 0 && next < sections.length) [sections[index], sections[next]] = [sections[next]!, sections[index]!];
    } else if (command.op === "delete") {
      sections.splice(index, 1);
      membership = membership.filter((row) => row.sectionId !== sectionId);
    }
  }
  const next = { v: 1 as const, seeded: true, sections, membership, order, unsectionedCollapsed };
  return isUnifiedSidebarLayout(next) ? next : null;
}

export function projectUnifiedSidebar(layout: UnifiedSidebarLayout, snapshots: readonly UnifiedMachineSnapshot[]): UnifiedSidebarState {
  const machines = snapshots.map((snapshot) => {
    const offer = createOffer(snapshot);
    return {
      consoleId: snapshot.consoleId, label: snapshot.label, address: snapshot.address, home: snapshot.home, kind: snapshot.kind, status: snapshot.status,
      ...(snapshot.path ? { path: snapshot.path } : {}), creatable: offer.creatable, ...(offer.createBlock ? { createBlock: offer.createBlock } : {}),
      ...(snapshot.entryId && clean(snapshot.entryId, 128) ? { entryId: snapshot.entryId } : {}),
    };
  });
  const rows: UnifiedSidebarRow[] = [];
  for (const ref of layout.order) {
    const snapshot = snapshots.find((item) => item.consoleId === ref.consoleId);
    const commodore = snapshot?.roster?.commodores.find((item) => item.id === ref.commodoreId);
    if (!snapshot || !commodore || !clean(commodore.name, 120)) continue;
    rows.push({
      consoleId: ref.consoleId, commodoreId: ref.commodoreId, name: commodore.name, home: snapshot.home,
      machineLabel: snapshot.label, machineAddress: snapshot.address, status: snapshot.status,
      ...(snapshot.entryId && clean(snapshot.entryId, 128) ? { entryId: snapshot.entryId } : {}),
      ...(commodore.look !== undefined ? { look: commodore.look } : {}),
      ...(commodore.run !== undefined ? { run: commodore.run } : {}),
      ...(commodore.preview !== undefined ? { preview: commodore.preview } : {}),
      ...(commodore.commanders !== undefined ? { commanders: commodore.commanders } : {}),
      ...(commodore.moreCommanders !== undefined ? { moreCommanders: commodore.moreCommanders } : {}),
    });
  }
  return { v: 1, layout, machines, rows };
}

/** Published frame only. The stored layout is never trimmed. */
export function fitUnifiedSidebarState(state: UnifiedSidebarState): UnifiedSidebarState {
  let rows = [...state.rows];
  const bytes = () => new TextEncoder().encode(JSON.stringify({ ...state, rows })).length;
  const trim = (apply: (row: UnifiedSidebarRow) => UnifiedSidebarRow | null): boolean => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const next = row ? apply(row) : null;
      if (!next) continue;
      rows = rows.map((item, cursor) => cursor === index ? next : item);
      return true;
    }
    return false;
  };
  while (bytes() > UNIFIED_SIDEBAR_MAX_FRAME) {
    const droppedPreview = trim((row) => {
      if (row.preview === undefined) return null;
      const { preview: _preview, ...rest } = row;
      return rest;
    });
    if (droppedPreview) continue;
    const droppedCommander = trim((row) => {
      const list = row.commanders;
      if (!list || list.length === 0) return null;
      return { ...row, commanders: list.slice(0, -1), moreCommanders: (row.moreCommanders ?? 0) + 1 };
    });
    if (droppedCommander) continue;
    if (rows.length === 0) break;
    rows = rows.slice(0, -1);
  }
  return { ...state, rows };
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
    && (machine.createBlock === undefined || reasonOk(machine.createBlock))
    && (machine.entryId === undefined || clean(machine.entryId, 128)));
  if (!machineOk) return false;
  return value.rows.every((row: unknown) => {
    if (!record(row) || !asRef(row) || !clean(row.name, 120) || typeof row.home !== "boolean" || !clean(row.machineLabel, 120) || !clean(row.machineAddress, 255) || !statusOk(row.status)) return false;
    if (row.entryId !== undefined && !clean(row.entryId, 128)) return false;
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

const lookOk = (value: unknown): value is UnifiedCommodoreLook => record(value) && Number.isSafeInteger(value.base) && (value.base as number) >= 0 && (value.base as number) < 10_000 && (value.tone === null || clean(value.tone, 64));

/**
 * `look` is additive. A command without it still parses, and a shell from before it stores the alias only.
 * The target Console applies the face with its existing avatar write; if that Console has no such write, creation still stands.
 */
export function parseCreateCommodoreCommand(value: Record<string, unknown>): { readonly consoleId: string; readonly alias: string; readonly request: string; readonly look?: UnifiedCommodoreLook } | null {
  const command = value.createCommodore;
  if (!record(command) || !consoleIdOk(command.consoleId) || !clean(command.request, 128) || !aliasOk(command.alias)) return null;
  const keys = Object.keys(command);
  if (!keys.every((key) => key === "consoleId" || key === "alias" || key === "request" || key === "look")) return null;
  if (command.look !== undefined && !lookOk(command.look)) return null;
  const look = lookOk(command.look) ? { base: command.look.base, tone: command.look.tone } : undefined;
  return { consoleId: command.consoleId, alias: command.alias.trim(), request: command.request, ...(look ? { look } : {}) };
}
