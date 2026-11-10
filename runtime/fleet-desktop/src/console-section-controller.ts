import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { CONSOLE_SECTION_COMMAND, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_MAX_FRAME, parseConsoleSectionCommand, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState } from "@fleet-console/protocol/desktop/console-section";
import { consoleLifecycleActions, type ConsoleAccessPath, type ConsoleLifecycleAction, type ConsoleManagedLifecycle, type ConsoleManagementRelation } from "@fleet-console/protocol/lifecycle/management";

type Contents = Pick<WebContents, "on" | "removeListener" | "getURL" | "isDestroyed" | "executeJavaScript">;
type Overlay = Pick<WebContents, "on" | "once" | "getURL" | "isDestroyed" | "executeJavaScript">;
interface Target { readonly origin: string; readonly recordId?: string; readonly entry: ConsoleSectionEntry }
/** The management relation of one Console as this Desktop proved it (docs/console-lifecycle-contract.md). */
export interface ManagedConsoleState {
  readonly management: ConsoleManagementRelation;
  readonly lifecycle: ConsoleManagedLifecycle | null;
  readonly identityProven: boolean;
}
/** The Console this Desktop's window lives on, as its lifecycle manager sees it. */
export interface ManagedHomeConsole {
  readonly state: () => Promise<ManagedConsoleState>;
  /** Runs an action this controller judged allowed. Rejects when it could not be carried out. */
  readonly run: (action: ConsoleLifecycleAction) => Promise<void>;
}
interface Dependencies {
  readonly home: () => string | null;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly open: (origin: string) => Promise<void>;
  readonly add: (url: string) => void;
  /** Opens the management surface the home Console draws. Absent in a shell that offers none. */
  readonly manage?: (url: string) => void;
  readonly managedHome?: ManagedHomeConsole;
  readonly confirmForget: (label: string) => Promise<boolean>;
  readonly report: (error: unknown) => void;
}
type Relations = Pick<ConsoleSectionEntry, "management" | "path" | "lifecycle" | "actions">;
const text = (value: unknown, fallback: string, max = 120): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max) : "") || fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** A Console found on this computer says who started it; that names its manager, it does not make this Desktop one. */
const managementOfLocal = (owner: unknown): ConsoleManagementRelation => owner === "desktop" ? "other-desktop" : owner === "cli" ? "cli" : "unknown";

/** 불투명 id는 창 하나가 소유한다. 활성 문서에는 명시한 표시 필드만 보낸다. */
export function createConsoleSectionController(deps: Dependencies) {
  let contents: Contents | null = null;
  let overlay: Overlay | null = null;
  let detach = () => {};
  let generation = 0;
  let expanded = true;
  let targets = new Map<string, Target>();
  let ids = new Map<string, string>();
  let refreshRunning: Promise<void> | null = null;
  let refreshAgain = false;
  let budgetStart = 0;
  let budget = 0;
  let mutating = false;
  /** The lifecycle action in flight on the home Console, and whether the last one failed. */
  let running: ConsoleLifecycleAction | null = null;
  let failed = false;
  const at = () => {
    try { const url = new URL(contents?.getURL() ?? ""); return url.pathname.startsWith("/console/") ? url.origin : null; } catch { return null; }
  };
  const home = () => { const origin = deps.home(); return origin && isLoopbackConsoleOrigin(origin) ? origin : null; };
  async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const origin = home();
    if (!origin) throw new Error("console_section_home_unavailable");
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);
    const response = await deps.fetch(new URL(path, origin).toString(), { ...init, headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const alreadyForgotten = init?.method === "DELETE" && response.status === 404;
    if (!response.ok && !alreadyForgotten) throw new Error("console_section_request_failed");
    if (response.status === 204 || alreadyForgotten) return {};
    return record(await response.json());
  }
  /**
   * The home Console's relations. Management comes only from the manager's own proof; while an action runs, the row
   * says so and offers nothing. A shell without a manager sends no relation, as shells did before this contract.
   */
  async function homeRelations(): Promise<Relations & { readonly reachable: boolean }> {
    if (!deps.managedHome) return { reachable: true };
    let state: ManagedConsoleState;
    try { state = await deps.managedHome.state(); } catch { return { management: "unknown", path: "loopback", lifecycle: null, actions: [], reachable: true }; }
    if (running !== null) return { management: state.management, path: "loopback", lifecycle: running === "stop" ? "stopping" : state.lifecycle === "stopping" ? "stopping" : "starting", actions: [], reachable: state.lifecycle === "running" };
    if (state.lifecycle === "running") failed = false;
    const lifecycle = failed && state.lifecycle === "stopped" ? "failed" : state.lifecycle;
    return { management: state.management, path: "loopback", lifecycle, actions: consoleLifecycleActions({ ...state, lifecycle, home: true }), reachable: state.lifecycle === "running" || state.lifecycle === null };
  }
  async function publish(): Promise<void> {
    const origin = at();
    if (!origin) return;
    const state: ConsoleSectionState = { v: 1, expanded, entries: [...targets.values()].map(({ origin: target, entry }) => ({ ...entry, active: target === origin })) };
    const send = async (receiver: Pick<WebContents, "isDestroyed" | "executeJavaScript"> | null, expected: string): Promise<void> => {
      if (!receiver || receiver.isDestroyed()) return;
      // 실행 직전에 문서가 바뀌어도 옛 origin의 상태를 새 문서로 넘기지 않는다.
      const script = `if(location.origin===${JSON.stringify(expected)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_SECTION_EVENT)},{detail:${JSON.stringify(state)}}))`;
      await receiver.executeJavaScript(script).catch(() => undefined);
    };
    await send(contents, origin);
    // The management surface is the home Console's own document; it never receives another origin's state.
    const homeOrigin = home();
    if (overlay && homeOrigin) await send(overlay, homeOrigin);
  }
  async function load(): Promise<void> {
    const origin = home();
    const epoch = generation;
    if (!origin || !contents || !at()) return;
    const relations = await homeRelations();
    if (epoch !== generation) return;
    const current = at();
    const next = new Map<string, Target>();
    const nextIds = new Map<string, string>();
    const append = (targetOrigin: unknown, kind: "local" | "remote", label: unknown, version: unknown, state: ConsoleSectionEntry["status"], extra: Relations, recordId?: string) => {
      if (typeof targetOrigin !== "string" || !(kind === "local" ? isLoopbackConsoleOrigin(targetOrigin) : isRemoteConsoleOrigin(targetOrigin))) return;
      if (next.size >= 100 || [...next.values()].some((target) => target.origin === targetOrigin)) return;
      const key = `${kind}:${recordId ?? targetOrigin}`;
      const id = ids.get(key) ?? randomUUID();
      const entry: ConsoleSectionEntry = { id, kind, label: text(label, new URL(targetOrigin).host), address: new URL(targetOrigin).host, version: typeof version === "string" && version ? text(version, "", 64) || null : null, active: targetOrigin === current, home: targetOrigin === origin, status: kind === "remote" ? targets.get(id)?.entry.status ?? state : state, ...extra };
      const candidate = { v: 1, expanded, entries: [...next.values()].map((target) => target.entry).concat(entry) };
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > CONSOLE_SECTION_MAX_FRAME) return;
      next.set(id, { origin: targetOrigin, ...(recordId ? { recordId } : {}), entry });
      nextIds.set(key, id);
    };
    const { reachable, ...homeExtra } = relations;
    /**
     * The home Console does not answer, so its own lists cannot be read. The row stays, with the name it last had and
     * the relations the manager just proved, so the person sees what happened instead of the last list that worked.
     */
    const homeOnly = async (): Promise<void> => {
      const before = [...targets.values()].find((target) => target.entry.home)?.entry;
      append(origin, "local", before?.label, before?.version, "unreachable", homeExtra);
      if (current && current !== origin) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null, { management: "unknown", path: isLoopbackConsoleOrigin(current) ? "loopback" : "remote" });
      targets = next;
      ids = nextIds;
      await publish();
    };
    // A managed home Console that is stopped is not a failure to report.
    if (!reachable) { await homeOnly(); return; }
    let lists: readonly [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    try {
      lists = await Promise.all([json("/api/v1/remote-hosts"), json("/api/v1/local-consoles"), json("/api/v1/status")]);
    } catch (error) {
      // Another owner's Console in the slot, or one that cannot be judged: still unreachable from here, and reported.
      if (deps.managedHome && epoch === generation) await homeOnly();
      throw error;
    }
    const [saved, nearby, status] = lists;
    if (epoch !== generation) return;
    // An older shell sent no relation at all; without a manager this shell keeps doing so.
    const relate = (management: ConsoleManagementRelation, path: ConsoleAccessPath): Relations => deps.managedHome ? { management, path } : {};
    append(origin, "local", status.name, status.version, "ready", homeExtra);
    const hosts = Array.isArray(saved.hosts) ? saved.hosts.map(record) : [];
    const locals = Array.isArray(nearby.consoles) ? nearby.consoles.map(record) : [];
    // 크기 상한에 닿더라도 집과 지금 서 있는 Console은 남긴다.
    const activeRemote = hosts.find((host) => host.origin === current);
    if (activeRemote && typeof activeRemote.id === "string") append(activeRemote.origin, "remote", activeRemote.label, null, null, relate("unknown", "remote"), activeRemote.id);
    if (current && current !== origin && !activeRemote) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null, relate("unknown", isLoopbackConsoleOrigin(current) ? "loopback" : "remote"));
    for (const local of locals) append(local.origin, "local", local.origin === origin ? status.name : undefined, local.version, local.state === "stopping" ? "stopping" : local.state === "unresponsive" ? "slow" : "ready",
      relate(managementOfLocal(local.owner), typeof local.distro === "string" && local.distro ? "wsl" : "loopback"));
    for (const host of hosts) if (typeof host.id === "string") append(host.origin, "remote", host.label, null, null, relate("unknown", "remote"), host.id);
    targets = next;
    ids = nextIds;
    await publish();
    // 닫힌 패널도 지금 서 있는 원격의 상태는 갱신한다. 다른 원격은 열었을 때만 확인한다.
    // 연결 확인도 집 API가 맡는다. 원본 DTO는 활성 문서에 보내지 않는다.
    await Promise.all([...next].filter(([, target]) => target.recordId && (expanded || target.origin === current)).map(async ([id, target]) => {
      try {
        const reach = await json(`/api/v1/remote-hosts/${encodeURIComponent(target.recordId!)}/probes`, { method: "POST" });
        if (epoch !== generation || targets !== next) return;
        next.set(id, { ...target, entry: { ...target.entry, status: reach.reachable !== true ? "unreachable" : reach.trusted !== true ? "untrusted" : "ready" } });
      } catch { /* 조회 실패는 알 수 없음이지 인증서 불일치 판정이 아니다. */ }
    }));
    if (epoch === generation && targets === next) await publish();
  }
  function refresh(): Promise<void> {
    if (refreshRunning) { refreshAgain = true; return refreshRunning; }
    refreshRunning = (async () => {
      do { refreshAgain = false; try { await load(); } catch (error) { deps.report(error); if (!deps.managedHome) await publish(); } } while (refreshAgain && contents);
    })().finally(() => { refreshRunning = null; });
    return refreshRunning;
  }
  /**
   * A lifecycle action on the Console this Desktop manages. Authority is judged here, from the manager's fresh proof,
   * never from what the page was last told: the entry must be the home Console and the action one the contract allows
   * for its present state.
   */
  async function runLifecycle(id: string, action: ConsoleLifecycleAction): Promise<void> {
    const target = targets.get(id);
    if (!target?.entry.home || !deps.managedHome || running !== null) return;
    const state = await deps.managedHome.state();
    const lifecycle = failed && state.lifecycle === "stopped" ? "failed" : state.lifecycle;
    if (!consoleLifecycleActions({ ...state, lifecycle, home: true }).includes(action)) { await refresh(); return; }
    running = action;
    failed = false;
    await refresh();
    try {
      await deps.managedHome.run(action);
    } catch (error) {
      failed = true;
      deps.report(error);
    } finally {
      running = null;
      await refresh();
    }
  }
  async function command(value: ConsoleSectionCommand, fromHome: boolean): Promise<void> {
    if ("request" in value) { await refresh(); return; }
    if ("expanded" in value) { expanded = value.expanded; await publish(); if (expanded) await refresh(); return; }
    if ("add" in value) {
      const origin = home();
      if (origin) { const url = new URL("/console/", origin); url.searchParams.set("desktop-surface", "host-picker"); url.searchParams.set("intent", "add"); url.searchParams.set("at", at() ?? origin); deps.add(url.toString()); }
      return;
    }
    // Lifecycle is the manager's alone. A page of another Console may show the row, but only a document the home
    // Console serves may ask: the stale home page of a stopped Console, or the management surface.
    if ("lifecycle" in value) { if (fromHome) await runLifecycle(value.lifecycle.id, value.lifecycle.action); return; }
    const id = "switch" in value ? value.switch : "forget" in value ? value.forget : "manage" in value ? value.manage : value.rename.id;
    const target = targets.get(id);
    if (!target) return;
    if ("switch" in value) { await deps.open(target.origin); return; }
    if ("manage" in value) {
      const origin = home();
      // The surface is the home Console's document, so it opens only while that Console answers.
      if (!origin || !deps.manage || target.entry.management === undefined || target.entry.status === "unreachable") return;
      const url = new URL("/console/", origin);
      url.searchParams.set("desktop-surface", "host-picker"); url.searchParams.set("intent", "manage"); url.searchParams.set("target", id); url.searchParams.set("at", at() ?? origin);
      deps.manage(url.toString());
      return;
    }
    // Renaming and forgetting act on a saved record. The record grants them, not the kind the row is drawn with.
    if (!target.recordId || mutating) return;
    const epoch = generation;
    mutating = true;
    try {
      if ("forget" in value && !await deps.confirmForget(target.entry.label)) { await publish(); return; }
      if (epoch !== generation || targets.get(id)?.recordId !== target.recordId) return;
      await json(`/api/v1/remote-hosts/${encodeURIComponent(target.recordId)}`, "rename" in value ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: value.rename.label }) } : { method: "DELETE" });
      await refresh();
    } finally { mutating = false; }
  }
  /** Rate-limits and parses a command navigation. Returns the command, or null when it is to be dropped. */
  function accept(url: URL): ConsoleSectionCommand | null {
    const now = Date.now();
    if (now - budgetStart >= 1000) { budgetStart = now; budget = 0; }
    if (++budget > 20) return null;
    return parseConsoleSectionCommand(url.searchParams.get("command") ?? "");
  }
  function close(): void {
    generation++;
    detach(); detach = () => {};
    contents = null;
    overlay = null;
    targets.clear(); ids.clear(); expanded = true;
    budget = 0; budgetStart = 0;
  }
  return {
    refresh,
    close,
    /**
     * The home Console's own overlay: the add dialog and the management surface. It hears the same minimized state,
     * and it is the one place besides the home page itself whose lifecycle commands are honored.
     */
    observeHomeOverlay(view: Overlay): void {
      const epoch = generation;
      overlay = view;
      view.on("will-navigate", ((event: { preventDefault(): void }, raw: string, _redirect?: unknown, mainFrame?: boolean) => {
        let url: URL;
        try { url = new URL(raw); } catch { return; }
        if (url.searchParams.get("desktop-surface") !== CONSOLE_SECTION_COMMAND) return;
        event.preventDefault();
        if (mainFrame === false || overlay !== view || view.isDestroyed() || epoch !== generation || url.origin !== home() || url.pathname !== "/console/") return;
        let from: string;
        try { from = new URL(view.getURL()).origin; } catch { return; }
        if (from !== home()) return;
        const value = accept(url);
        if (value && ("lifecycle" in value || "request" in value)) void command(value, true).catch((error) => { deps.report(error); void publish(); });
      }) as never);
      view.on("did-finish-load", (() => { if (overlay === view && epoch === generation) void refresh(); }) as never);
      // 성공·취소·Escape·렌더러 종료 모두 덮개 수명이 끝난 뒤 집의 상태를 다시 읽는다.
      view.once("destroyed", () => { if (overlay === view) overlay = null; if (contents && epoch === generation) void refresh(); });
    },
    attach(receiver: Contents): void {
      close();
      contents = receiver;
      const navigate = (event: { preventDefault(): void }, raw: string, _redirect?: unknown, mainFrame?: boolean) => {
        let url: URL;
        try { url = new URL(raw); } catch { return; }
        if (url.searchParams.get("desktop-surface") !== CONSOLE_SECTION_COMMAND) return;
        event.preventDefault();
        if (mainFrame === false || contents !== receiver || receiver.isDestroyed() || url.origin !== at() || url.pathname !== "/console/") return;
        const value = accept(url);
        if (value) void command(value, at() === home()).catch((error) => { deps.report(error); void publish(); });
      };
      const arrived = () => { generation++; void refresh(); };
      receiver.on("will-navigate", navigate as never);
      receiver.on("did-navigate", arrived);
      receiver.on("did-finish-load", arrived);
      detach = () => { receiver.removeListener("will-navigate", navigate as never); receiver.removeListener("did-navigate", arrived); receiver.removeListener("did-finish-load", arrived); };
    },
  };
}
