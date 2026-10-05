/**
 * The single Console lifecycle contract's time budgets (docs/console-lifecycle-contract.md). Import-free, so every actor
 * — a browser included — derives its waits from the same values. Re-exported by `./index.ts`.
 */

/** B_int: from the first accepted stop request until the serve process exits, whatever is still running. */
export const CONSOLE_STOP_DEADLINE_MS = 10_000;
/** The longest a process table read (`ps`) may take before the reader gives up without signalling anyone. */
export const PROCESS_TABLE_TIMEOUT_MS = 1_000;
/** Covers a busy event loop delaying the stop handler at signal time and the deadline timer at expiry. */
export const ESCALATION_MARGIN_MS = 1_000;
/**
 * B_ext: how long an actor that sent SIGTERM waits before it may escalate to SIGKILL. Derived so that a Console within
 * its own budget (deadline + process table read + loop delay) always ends by its own deadline first.
 */
export const EXTERNAL_ESCALATION_MS = CONSOLE_STOP_DEADLINE_MS + PROCESS_TABLE_TIMEOUT_MS + ESCALATION_MARGIN_MS;
/** How long an actor that sent SIGKILL waits to see the pid exit. */
export const KILL_CONFIRM_MS = 3_000;
/**
 * SIGTERM to an owned process group, then this long before SIGKILL: the Console's own stop path for its plugins' groups
 * and its watcher after a crash use this one value, the same gap as the agent SDK's between its SIGTERM and SIGKILL.
 * On Windows the same wait is how long a plugin job may exit on its own before TerminateJobObject, and that path reads
 * no process table. It must stay well inside the stop deadline:
 * OWNED_GROUP_TERM_GRACE_MS + ε < CONSOLE_STOP_DEADLINE_MS − ESCALATION_MARGIN_MS.
 */
export const OWNED_GROUP_TERM_GRACE_MS = 2_000;
/** How often a waiting actor looks again at the pid and the lock. */
export const STOP_POLL_MS = 50;
/**
 * How long a lock without a readable owner (empty, being written, unparseable) is read again before an actor reports
 * it, and how long a lock acquirer waits on another reclaimer. A monotonic budget, not a bound on blocking file I/O;
 * elapsed time is never evidence that the owner is dead.
 */
export const LOCK_OBSERVE_BUDGET_MS = 2_000;
/** How often such a lock is read again within that budget. */
export const LOCK_REREAD_INTERVAL_MS = 50;
/** The whole budget for one token-authenticated health probe, primary and legacy endpoints together. */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/**
 * The health probe budget on a path a person is waiting on, such as quitting the app. A probe that runs out reads as
 * unverified and nothing is signalled, so waiting longer would not change the outcome; a working Console answers in
 * milliseconds.
 */
export const INTERACTIVE_PROBE_TIMEOUT_MS = 2_000;
/** How long `fleet console start` waits for a Console it spawned, or one another starter is restoring, to become ready. */
export const CONSOLE_START_TIMEOUT_MS = 60_000;
/** How often `fleet console start` probes while it waits. */
export const CONSOLE_START_POLL_MS = 100;
/**
 * How long a starter waits after SIGTERM before SIGKILL for a child it spawned that has not taken the lock: such a child
 * has written nothing yet. A child that holds the lock gets the full stop ladder instead.
 */
export const PRELOCK_CHILD_GRACE_MS = 500;
