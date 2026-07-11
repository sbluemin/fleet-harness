import type { WebContents } from "electron";

export type EntryStepState = "waiting" | "active" | "complete" | "warning" | "failed";

export interface EntryStepSnapshot {
  readonly name: string;
  readonly sub: string;
  readonly state: EntryStepState;
  readonly result?: string;
  readonly progress?: number;
}

export interface EntryPageSnapshot {
  readonly platform: string;
  readonly foot: string;
  readonly dev: boolean;
  readonly steps: readonly EntryStepSnapshot[];
  readonly handoff?: string;
}

export interface EntryPageWebContents {
  executeJavaScript(code: string): Promise<unknown>;
}

const ENTRY_RENDERER = String.raw`(() => {
  const snapshot = __ENTRY_SNAPSHOT__;
  const stack = document.getElementById("boot-stack");
  const handoff = document.getElementById("handoff");
  const footLeft = document.getElementById("foot-left");
  const devTag = document.getElementById("dev-tag");
  if (!stack || !handoff || !footLeft || !devTag) return;
  stack.textContent = "";
  for (const step of snapshot.steps) {
    const row = document.createElement("div");
    row.classList.add("boot-step", step.state);
    const dot = document.createElement("span");
    dot.classList.add("boot-dot");
    const label = document.createElement("span");
    label.classList.add("boot-name");
    label.textContent = step.name;
    const sub = document.createElement("small");
    sub.classList.add("boot-sub");
    sub.textContent = step.sub;
    label.append(sub);
    const result = document.createElement("span");
    result.classList.add("boot-result");
    result.textContent = step.result || "";
    row.append(dot, label, result);
    if (typeof step.progress === "number") {
      const bar = document.createElement("span");
      bar.classList.add("boot-bar");
      const fill = document.createElement("span");
      fill.classList.add("boot-bar-fill");
      fill.setAttribute("style", "width: " + step.progress + "%");
      bar.append(fill);
      row.append(bar);
    }
    stack.append(row);
  }
  handoff.textContent = snapshot.handoff || "";
  handoff.classList.toggle("is-visible", Boolean(snapshot.handoff));
  footLeft.textContent = snapshot.foot;
  devTag.classList.toggle("is-visible", snapshot.dev);
  document.documentElement.setAttribute("data-platform", snapshot.platform);
})();`;

export async function pushEntrySnapshot(contents: EntryPageWebContents | WebContents, snapshot: EntryPageSnapshot): Promise<void> {
  await contents.executeJavaScript(createEntrySnapshotScript(snapshot));
}

export function createEntrySnapshotScript(snapshot: EntryPageSnapshot): string {
  return ENTRY_RENDERER.replace("__ENTRY_SNAPSHOT__", serializeSnapshot(normalizeEntrySnapshot(snapshot)));
}

export function normalizeEntrySnapshot(snapshot: EntryPageSnapshot): EntryPageSnapshot {
  return { ...snapshot, steps: snapshot.steps.map((step) => ({ ...step, ...(step.progress === undefined ? {} : { progress: clampProgress(step.progress) }) })) };
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function serializeSnapshot(snapshot: EntryPageSnapshot): string {
  return JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);
}
