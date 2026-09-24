import type { WebContents } from "electron";

/**
 * 진입 화면은 한 줄 상태만 말한다. busy는 진행 중, done은 넘겨줄 준비, warning은 멈추지 않고
 * 이어 가는 경고, failed는 첫 설치 실패처럼 여기서 멈춘 상태다.
 */
export type EntryTone = "busy" | "done" | "warning" | "failed";

export interface EntryPageSnapshot {
  readonly platform: string;
  readonly lang: "ko" | "en";
  readonly dev: boolean;
  readonly tagline: string;
  readonly tone: EntryTone;
  readonly title: string;
  readonly detail?: string;
  /** 0–100이면 채운 막대, "indeterminate"면 흐르는 막대, 없으면 막대를 숨긴다. */
  readonly progress?: number | "indeterminate";
  /** "Desktop 0.13.4 · Console 1.107.0" — 아는 버전만 담는다. */
  readonly versions: string;
  /** true면 마크와 워드마크가 Console 상단 브랜드 자리로 줄어들고 나머지는 사라진다. */
  readonly handoff?: boolean;
}

export interface EntryPageWebContents {
  executeJavaScript(code: string): Promise<unknown>;
}

// 진입 HTML은 CSP로 스크립트를 막는다. 이 렌더러는 main이 executeJavaScript로 들여보내는 유일한
// 코드이며, 스냅샷의 글자는 textContent로만 들어간다 — 마크업으로 해석되는 경로를 두지 않는다.
const ENTRY_RENDERER = String.raw`(() => {
  const snapshot = __ENTRY_SNAPSHOT__;
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const tagline = byId("tagline");
  const title = byId("status-title");
  const detail = byId("detail");
  const bar = byId("bar");
  const fill = byId("bar-fill");
  const versions = byId("versions");
  const devTag = byId("dev-tag");
  if (!tagline || !title || !detail || !bar || !fill || !versions || !devTag) return;
  root.setAttribute("lang", snapshot.lang);
  root.setAttribute("data-platform", snapshot.platform);
  root.setAttribute("data-tone", snapshot.tone);
  tagline.textContent = snapshot.tagline;
  title.textContent = snapshot.title;
  detail.textContent = snapshot.detail || "";
  versions.textContent = snapshot.versions;
  devTag.classList.toggle("is-visible", snapshot.dev);
  const progress = snapshot.progress;
  bar.classList.toggle("is-visible", progress !== undefined);
  bar.classList.toggle("is-indeterminate", progress === "indeterminate");
  fill.setAttribute("style", typeof progress === "number" ? "width: " + progress + "%" : "");
  if (snapshot.handoff) root.classList.add("is-handoff");
})();`;

export async function pushEntrySnapshot(contents: EntryPageWebContents | WebContents, snapshot: EntryPageSnapshot): Promise<void> {
  await contents.executeJavaScript(createEntrySnapshotScript(snapshot));
}

export function createEntrySnapshotScript(snapshot: EntryPageSnapshot): string {
  return ENTRY_RENDERER.replace("__ENTRY_SNAPSHOT__", serializeSnapshot(normalizeEntrySnapshot(snapshot)));
}

export function normalizeEntrySnapshot(snapshot: EntryPageSnapshot): EntryPageSnapshot {
  return typeof snapshot.progress === "number" ? { ...snapshot, progress: clampProgress(snapshot.progress) } : snapshot;
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function serializeSnapshot(snapshot: EntryPageSnapshot): string {
  return JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);
}
