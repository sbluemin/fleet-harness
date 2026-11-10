/**
 * Who manages a Console, apart from who is operating it and how it is reached
 * (docs/console-lifecycle-contract.md, "Management, operation, and access path").
 *
 * Three relations describe a Console as one Desktop sees it, and each answers one question only:
 *
 * - **management** — which Desktop is responsible for the Console's lifecycle. It alone grants lifecycle actions.
 * - **operation** — which client is driving the Console right now (pairing, session, control). Owned by remote access.
 * - **path** — how the Console is reached. It decides transport trust and what this device shares with the page.
 *
 * None of them stands in for another: a loopback address, a listed entry, or an open session is never management.
 * This module is pure and browser-safe; the proof behind `identityProven` belongs to `@fleet-console/lifecycle`.
 */

/** The Desktop this Console's lock names as its lifecycle owner, as seen from one Desktop. */
export type ConsoleManagementRelation = "this-desktop" | "other-desktop" | "cli" | "unknown";
export const CONSOLE_MANAGEMENT_RELATIONS: readonly ConsoleManagementRelation[] = ["this-desktop", "other-desktop", "cli", "unknown"];

/**
 * How a Console is reached from this Desktop. `loopback` is this computer's own OS; `wsl` is a Linux distribution on
 * this computer, reached over the same loopback address but living in another process and file namespace; `remote`
 * is another computer behind a pinned certificate.
 */
export type ConsoleAccessPath = "loopback" | "wsl" | "remote";
export const CONSOLE_ACCESS_PATHS: readonly ConsoleAccessPath[] = ["loopback", "wsl", "remote"];

/** What the person sees a managed Console doing. A Console this Desktop does not manage reports none. */
export type ConsoleManagedLifecycle = "running" | "stopped" | "starting" | "stopping" | "failed";
export const CONSOLE_MANAGED_LIFECYCLES: readonly ConsoleManagedLifecycle[] = ["running", "stopped", "starting", "stopping", "failed"];

/** The lifecycle actions a managing Desktop may take for the person. */
export type ConsoleLifecycleAction = "start" | "stop" | "restart";
export const CONSOLE_LIFECYCLE_ACTIONS: readonly ConsoleLifecycleAction[] = ["start", "stop", "restart"];

/**
 * Reads the owner record a Console published in its lock. The owner id is adoption policy, not a credential: it names
 * the manager, and only a token-authenticated answer from the lock's own pid proves the instance behind it.
 */
export function classifyConsoleManagement(owner: unknown, desktopOwnerId: string | null): ConsoleManagementRelation {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return "unknown";
  const { kind, id } = owner as { readonly kind?: unknown; readonly id?: unknown };
  if (kind === "cli") return "cli";
  if (kind !== "desktop" || typeof id !== "string" || id.length === 0) return "unknown";
  return desktopOwnerId !== null && id === desktopOwnerId ? "this-desktop" : "other-desktop";
}

/**
 * The lifecycle actions this Desktop may take on a Console.
 *
 * Only management by this Desktop grants any, and never on the strength of the owner record alone: a running Console
 * must also have proven its identity (an unreaped own child, or an authenticated health answer from the lock's pid).
 * A stopped Console has nothing to prove; starting it is how this Desktop takes responsibility for it. `home` is the
 * Console the Desktop window itself lives on: it cannot be stopped from inside without closing the window on the
 * person, so stopping it stays with quitting the Desktop.
 */
export function consoleLifecycleActions(input: {
  readonly management: ConsoleManagementRelation;
  readonly lifecycle: ConsoleManagedLifecycle | null;
  readonly identityProven: boolean;
  readonly home: boolean;
}): readonly ConsoleLifecycleAction[] {
  if (input.management !== "this-desktop") return [];
  if (input.lifecycle === "stopped" || input.lifecycle === "failed") return ["start"];
  if (input.lifecycle !== "running" || !input.identityProven) return [];
  return input.home ? ["restart"] : ["restart", "stop"];
}

export function isConsoleLifecycleAction(value: unknown): value is ConsoleLifecycleAction {
  return typeof value === "string" && (CONSOLE_LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}
