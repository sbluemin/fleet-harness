import type { EntryPageSnapshot, EntryStepSnapshot } from "./entry-page.js";
import type { RemoteRuntimePhase } from "./runtime/remote/contracts.js";
import type { ValidatedSshTarget } from "./runtime/remote/contracts.js";

const FOOT = "managed SSH runtime";

type RemoteStep = Omit<EntryStepSnapshot, "state" | "result">;

const stepsFor = (host: string): readonly RemoteStep[] => [
  { name: `Contacting ${host}`, sub: "SSH" },
  { name: "Installing Node runtime", sub: "managed runtime" },
  { name: "Installing Fleet Console", sub: "managed runtime" },
  { name: "Starting console", sub: "remote runtime" },
  { name: "Securing tunnel", sub: "localhost" },
  { name: "Verifying connection", sub: "Fleet Console" },
];

function activeIndex(phase: RemoteRuntimePhase): number {
  switch (phase) {
    case "provisioning_node": return 1;
    case "provisioning_console": return 2;
    case "starting_service": return 3;
    case "opening_tunnel": return 4;
    case "verifying_pairing": return 5;
    case "validating_target": case "connecting": case "detecting_platform": return 0;
  }
}

export function snapshotForRemotePhase(target: ValidatedSshTarget, phase: RemoteRuntimePhase, failed = false): EntryPageSnapshot {
  const active = activeIndex(phase);
  return {
    platform: process.platform,
    foot: FOOT,
    dev: false,
    steps: stepsFor(target.host).slice(0, active + 1).map((step, index) => ({
      ...step,
      state: index < active ? "complete" : failed ? "failed" : "active",
      ...(index === active && failed ? { result: "failed" } : {}),
    })),
  };
}

export function snapshotForRemoteReady(target: ValidatedSshTarget): EntryPageSnapshot {
  return {
    platform: process.platform,
    foot: FOOT,
    dev: false,
    steps: stepsFor(target.host).map((step) => ({ ...step, state: "complete" })),
    handoff: "Console ready",
  };
}
