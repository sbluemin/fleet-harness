import type { EntryPageSnapshot, EntryStepSnapshot } from "./entry-page.js";

/** 링크 접속의 진행 단계. 순서가 곧 보안 순서다 — 신원을 고정한 뒤에만 통신한다. */
export type RemoteAccessPhase = "reading_link" | "pinning_identity" | "opening_session" | "verifying_console";

const FOOT = "remote access link";

type RemoteStep = Omit<EntryStepSnapshot, "state" | "result">;

const stepsFor = (host: string): readonly RemoteStep[] => [
  { name: "Reading access link", sub: "one-time credential" },
  { name: `Pinning ${host}`, sub: "certificate fingerprint" },
  { name: "Opening session", sub: "single-use grant" },
  { name: "Verifying console", sub: "Fleet Console" },
];

function activeIndex(phase: RemoteAccessPhase): number {
  switch (phase) {
    case "reading_link": return 0;
    case "pinning_identity": return 1;
    case "opening_session": return 2;
    case "verifying_console": return 3;
  }
}

export function snapshotForAccessPhase(host: string, phase: RemoteAccessPhase, failed = false): EntryPageSnapshot {
  const active = activeIndex(phase);
  return {
    platform: process.platform,
    foot: FOOT,
    dev: false,
    steps: stepsFor(host).slice(0, active + 1).map((step, index) => ({
      ...step,
      state: index < active ? "complete" : failed ? "failed" : "active",
      ...(index === active && failed ? { result: "failed" } : {}),
    })),
  };
}

export function snapshotForAccessReady(host: string): EntryPageSnapshot {
  return {
    platform: process.platform,
    foot: FOOT,
    dev: false,
    steps: stepsFor(host).map((step) => ({ ...step, state: "complete" })),
    handoff: "Console ready",
  };
}
