import { useEffect, useSyncExternalStore } from "react";
import { CONSOLE_SIDEBAR_CAPABILITY } from "@fleet-console/protocol/desktop/console-section";
import { useDesktopHomeOrigin } from "../../../../core/client/src/integration/desktop-shell.js";
import { sidebarJson } from "../../../remote-access/client/sidebar-transport.js";
import type { ConsoleSections } from "../../../remote-access/client/console-sections.js";
import { mongleStateOf } from "../../shared/avatars.js";
import { isCommodoreWaiting } from "../../../objectives/shared/board-state.js";
import type { SidebarMotion, SidebarRemotePage } from "../../shared/sidebar-remote.js";

const pages = new Map<string, SidebarRemotePage>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const workers = new Map<string, { users: number; stop: () => void }>();
let revision = 0;
const emit = () => { revision++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const keyOf = (console: string, owner?: string) => `${console}\n${owner ?? ""}`;

/** 명부 상한과 독립적인 페이지 순회. 한 페이지 실패를 완전한 목록으로 게시하지 않는다. */
async function readPages(console: string, owner: string | undefined, signal: AbortSignal): Promise<SidebarRemotePage> {
  let offset: number | null = 0;
  let result: SidebarRemotePage | null = null;
  while (offset !== null) {
    const page: SidebarRemotePage = await sidebarJson(console, "runtime", undefined,
      { offset: String(offset), ...(owner ? { commodoreId: owner } : {}) }, signal);
    if (page.v !== 1 || !Array.isArray(page.commodores) || !Array.isArray(page.objectives)
      || !page.preferences || !Number.isFinite(page.at) || typeof page.writable !== "boolean"
      || (page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= offset))) throw new Error("sidebar_invalid_page");
    result = result ? { ...page, commodores: [...result.commodores, ...page.commodores], objectives: [...result.objectives, ...page.objectives] } : page;
    offset = page.next;
  }
  if (!result) throw new Error("sidebar_empty_page");
  return result;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
async function watchMotions(console: string, signal: AbortSignal): Promise<void> {
  let after = 0;
  let baseline: number | null = null;
  while (!signal.aborted) {
    try {
      const change = await sidebarJson<{ revision: number; reset: boolean; next: number; motions: readonly SidebarMotion[] }>(console, "changes", undefined, { after: String(after) }, signal);
      if (!Number.isSafeInteger(change.next) || !Array.isArray(change.motions)) throw new Error("sidebar_invalid_changes");
      if (baseline === null) baseline = pages.get(keyOf(console))?.at ?? null;
      after = change.next;
      if (change.reset) { refreshRemoteSidebar(console); baseline = null; }
      for (const motion of change.motions) {
        if (signal.aborted) return;
        if (motion.at < (baseline ?? Infinity)) continue;
        for (const [key, page] of pages) {
          if (!key.startsWith(`${console}\n`)) continue;
          const commodores = page.commodores.map((row) => motion.kind === "commodore" && row.id === motion.id
            ? { ...row, live: motion.live, state: motion.state === "idle" && row.decisions > 0 ? "decision" as const : motion.state, activity: motion.activity } : row);
          const objectives = page.objectives.map((row) => {
            if (motion.kind !== "objective" || !row.faces[motion.id]) return row;
            const state = row.objective.id === motion.id ? mongleStateOf({
              session: true, awaitingReview: row.objective.awaitingReview, workDone: row.objective.done !== null,
              personTurn: isCommodoreWaiting(row.objective),
              activity: motion.state === "running" ? "running" : motion.state === "awaiting" ? "awaiting" : motion.state === "ended" ? "ended" : "idle",
            }) : motion.state;
            return { ...row, faces: { ...row.faces, [motion.id]: { ...row.faces[motion.id]!, state, activity: motion.activity } } };
          });
          pages.set(key, { ...page, commodores, objectives });
        }
        emit();
        // 같은 응답에 든 짧은 턴의 시작/끝도 서로 다른 페인트로 전달한다.
        await pause(100, signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      errors.set(keyOf(console), error instanceof Error ? error.message : "sidebar_unavailable"); emit();
      await pause(1000, signal);
    }
  }
}
function watch(console: string, owner?: string): () => void {
  const key = keyOf(console, owner);
  const current = workers.get(key);
  if (current) { current.users++; return () => release(key); }
  const abort = new AbortController();
  let timer: number | undefined;
  const run = async () => {
    try {
      if (document.visibilityState === "visible") {
        const page = await readPages(console, owner, abort.signal);
        if (!abort.signal.aborted) { pages.set(key, page); errors.delete(key); emit(); }
      }
    } catch (error) {
      if (!abort.signal.aborted) { errors.set(key, error instanceof Error ? error.message : "sidebar_unavailable"); emit(); }
    } finally { if (!abort.signal.aborted) timer = window.setTimeout(run, 750); }
  };
  workers.set(key, { users: 1, stop: () => { abort.abort(); window.clearTimeout(timer); } });
  void run();
  if (!owner) void watchMotions(console, abort.signal);
  return () => release(key);
}
function release(key: string): void {
  const worker = workers.get(key);
  if (worker && --worker.users === 0) { worker.stop(); workers.delete(key); }
}
export function useRemoteSidebar(console: string | null, owner?: string): { readonly page: SidebarRemotePage | null; readonly error: string | null } {
  useSyncExternalStore(subscribe, () => revision, () => 0);
  useEffect(() => console ? watch(console, owner) : undefined, [console, owner]);
  return { page: console ? pages.get(keyOf(console, owner)) ?? null : null, error: console ? errors.get(keyOf(console, owner)) ?? null : null };
}
export function useRemoteSidebarDirectory(consoles: ConsoleSections): ReadonlyMap<string, SidebarRemotePage> {
  const shell = useDesktopHomeOrigin();
  const supported = shell.capabilities.includes(CONSOLE_SIDEBAR_CAPABILITY);
  useSyncExternalStore(subscribe, () => revision, () => 0);
  const ids = supported ? consoles.entries.filter((entry) => !entry.active && entry.status !== "untrusted" && entry.status !== "unreachable" && entry.status !== "stopping").map((entry) => entry.id).join("\n") : "";
  useEffect(() => {
    const stops = ids.split("\n").filter(Boolean).map((id) => watch(id));
    return () => { for (const stop of stops) stop(); };
  }, [ids]);
  return new Map(ids.split("\n").filter(Boolean).flatMap((id) => {
    const page = pages.get(keyOf(id)); return page ? [[id, page] as const] : [];
  }));
}
export function refreshRemoteSidebar(console: string, owner?: string): void {
  const abort = new AbortController();
  void readPages(console, owner, abort.signal).then((page) => { pages.set(keyOf(console, owner), page); errors.delete(keyOf(console, owner)); emit(); })
    .catch((error: unknown) => { errors.set(keyOf(console, owner), error instanceof Error ? error.message : "sidebar_unavailable"); emit(); });
}
