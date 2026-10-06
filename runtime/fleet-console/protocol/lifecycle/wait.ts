import { CONSOLE_START_TIMEOUT_MS, EXTERNAL_ESCALATION_MS } from "./budgets.js";
import { UPDATE_WORKER_PREFLIGHT_MS } from "./update.js";

/**
 * A wait a person can see (docs/console-lifecycle-contract.md, "Waits a person watches").
 * The actor that is in the wait names it. The sentence comes only from describeConsoleLifecycleWait.
 */
export type ConsoleLifecycleWait =
  | "update-preflight"
  | "owner-starting"
  | "owner-stopping"
  | "stop-ladder"
  | "spawned-starting";

const LIFECYCLE_WAITS: readonly ConsoleLifecycleWait[] = [
  "update-preflight",
  "owner-starting",
  "owner-stopping",
  "stop-ladder",
  "spawned-starting",
];

/** A recorded wait as a reader sees it. Null when nothing was recorded or the value is not one of these; never a guess. */
export function parseConsoleLifecycleWait(value: unknown): ConsoleLifecycleWait | null {
  if (typeof value !== "string") return null;
  return LIFECYCLE_WAITS.includes(value as ConsoleLifecycleWait) ? value as ConsoleLifecycleWait : null;
}

const seconds = (ms: number): string => `${Math.round(ms / 1_000)}s`;

/** The shared, path-free sentence for a wait a person is sitting through. Budgets are read from the contract, not restated. */
export function describeConsoleLifecycleWait(wait: ConsoleLifecycleWait): string {
  switch (wait) {
    case "update-preflight":
      return `Fleet Console is fetching and checking the update while it keeps running. Nothing is stopped until the update worker finishes its checks; if they take longer than ${seconds(UPDATE_WORKER_PREFLIGHT_MS)}, the update ends there and installs nothing.`;
    case "owner-starting":
      return `The Fleet Console holding the Console lock is still starting. It is not signalled while it starts; this waits up to ${seconds(CONSOLE_START_TIMEOUT_MS)} for it to finish.`;
    case "owner-stopping":
      return `The previous Fleet Console closed its listener and is still shutting down. Nothing starts beside it; this waits up to ${seconds(EXTERNAL_ESCALATION_MS)} for it to release the Console lock.`;
    case "stop-ladder":
      return `Waiting up to ${seconds(EXTERNAL_ESCALATION_MS)} for Fleet Console to finish shutting down.`;
    case "spawned-starting":
      return `Fleet Console is starting. This waits up to ${seconds(CONSOLE_START_TIMEOUT_MS)} for it to answer.`;
  }
}
