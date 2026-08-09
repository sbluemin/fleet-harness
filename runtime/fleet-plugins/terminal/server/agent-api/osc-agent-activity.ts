import type { AgentCliId } from "@dotobokuri/fleet-admiral";

import type { AgentModelActivity } from "./types.js";

export type OscAgentActivityClassification = AgentModelActivity | "unknown";

export interface OscAgentActivityTracker {
  observeTitle(title: string): void;
  reset(): void;
}

interface OscAgentActivityTrackerOptions {
  readonly cliId: AgentCliId;
  readonly cwdBasename: string;
  readonly onActivity: (activity: AgentModelActivity) => void;
}

const NOT_WORKING_STABILITY_MS = 400;
const BRAILLE_START = 0x2800;
const BRAILLE_END = 0x28ff;
const CLAUDE_NOT_WORKING = 0x2733;

export function classifyOscAgentActivity(
  cliId: AgentCliId,
  title: string,
): OscAgentActivityClassification {
  const first = title.codePointAt(0);
  if (first === undefined) return "unknown";
  if (first >= BRAILLE_START && first <= BRAILLE_END) return "working";
  return first === CLAUDE_NOT_WORKING ? "not-working" : "unknown";
}

export function createOscAgentActivityTracker(options: OscAgentActivityTrackerOptions): OscAgentActivityTracker {
  let committed: AgentModelActivity | undefined;
  let pendingNotWorking: ReturnType<typeof setTimeout> | undefined;

  function observeTitle(title: string): void {
    const classification = classifyOscAgentActivity(options.cliId, title);
    if (classification === "unknown") return;
    if (classification === "working") {
      cancelPendingNotWorking();
      committed = "working";
      options.onActivity("working");
      return;
    }
    if (committed === "not-working" || pendingNotWorking) return;
    pendingNotWorking = setTimeout(() => {
      pendingNotWorking = undefined;
      commit("not-working");
    }, NOT_WORKING_STABILITY_MS);
  }

  function commit(activity: AgentModelActivity): void {
    if (committed === activity) return;
    committed = activity;
    options.onActivity(activity);
  }

  function cancelPendingNotWorking(): void {
    if (!pendingNotWorking) return;
    clearTimeout(pendingNotWorking);
    pendingNotWorking = undefined;
  }

  function reset(): void {
    cancelPendingNotWorking();
    committed = undefined;
  }

  return { observeTitle, reset };
}
