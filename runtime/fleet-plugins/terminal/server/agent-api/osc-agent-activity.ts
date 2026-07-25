import type { AgentCliId } from "@dotobokuri/fleet-admiral";

import type { AgentModelActivity } from "./types.js";

export type OscAgentActivityClassification = AgentModelActivity | "unknown";

export interface OscAgentActivityTracker {
  observeTitle(title: string): void;
  reset(): void;
}

interface OscAgentActivityTrackerOptions {
  readonly cliId: AgentCliId;
  readonly onActivity: (activity: AgentModelActivity) => void;
}

const NOT_WORKING_STABILITY_MS = 400;
const BRAILLE_START = 0x2800;
const BRAILLE_END = 0x28ff;
const CLAUDE_NOT_WORKING = 0x2733;

export function classifyOscAgentActivity(
  cliId: AgentCliId,
  title: string,
  codexWorkingSeen = false,
): OscAgentActivityClassification {
  const first = title.codePointAt(0);
  if (first === undefined) return "unknown";
  if (first >= BRAILLE_START && first <= BRAILLE_END) return "working";
  if (cliId === "claude" || cliId === "claude-kimi") {
    return first === CLAUDE_NOT_WORKING ? "not-working" : "unknown";
  }
  if (!codexWorkingSeen) return "unknown";
  return isOrdinaryTitlePrefix(first) ? "not-working" : "unknown";
}

export function createOscAgentActivityTracker(options: OscAgentActivityTrackerOptions): OscAgentActivityTracker {
  let codexWorkingSeen = false;
  let committed: AgentModelActivity | undefined;
  let pendingNotWorking: ReturnType<typeof setTimeout> | undefined;

  function observeTitle(title: string): void {
    const classification = classifyOscAgentActivity(options.cliId, title, codexWorkingSeen);
    if (classification === "unknown") return;
    if (classification === "working") {
      codexWorkingSeen = true;
      cancelPendingNotWorking();
      commit("working");
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
    codexWorkingSeen = false;
    committed = undefined;
  }

  return { observeTitle, reset };
}

function isOrdinaryTitlePrefix(codePoint: number): boolean {
  return codePoint > 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
}
