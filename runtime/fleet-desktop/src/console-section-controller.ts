import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { CONSOLE_SECTION_COMMAND, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_MAX_FRAME, parseConsoleSectionCommand, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState } from "@fleet-console/protocol/desktop/console-section";

type Contents = Pick<WebContents, "on" | "removeListener" | "getURL" | "isDestroyed" | "executeJavaScript">;
interface Target { readonly origin: string; readonly recordId?: string; readonly entry: ConsoleSectionEntry }
interface Dependencies {
  readonly home: () => string | null;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly open: (origin: string) => Promise<void>;
  readonly add: (url: string) => void;
  readonly confirmForget: (label: string) => Promise<boolean>;
  readonly report: (error: unknown) => void;
}
const text = (value: unknown, fallback: string, max = 120): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max) : "") || fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 불투명 id는 창 하나가 소유한다. 활성 문서에는 명시한 표시 필드만 보낸다. */
export function createConsoleSectionController(deps: Dependencies) {
  let contents: Contents | null = null;
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
  async function publish(): Promise<void> {
    const receiver = contents;
    const origin = at();
    if (!receiver || receiver.isDestroyed() || !origin) return;
    const state: ConsoleSectionState = { v: 1, expanded, entries: [...targets.values()].map(({ origin: target, entry }) => ({ ...entry, active: target === origin })) };
    // 실행 직전에 문서가 바뀌어도 옛 origin의 상태를 새 문서로 넘기지 않는다.
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_SECTION_EVENT)},{detail:${JSON.stringify(state)}}))`;
    await receiver.executeJavaScript(script).catch(() => undefined);
  }
  async function load(): Promise<void> {
    const origin = home();
    const epoch = generation;
    if (!origin || !contents || !at()) return;
    const [saved, nearby, status] = await Promise.all([json("/api/v1/remote-hosts"), json("/api/v1/local-consoles"), json("/api/v1/status")]);
    if (epoch !== generation) return;
    const next = new Map<string, Target>();
    const nextIds = new Map<string, string>();
    const current = at();
    const append = (targetOrigin: unknown, kind: "local" | "remote", label: unknown, version: unknown, state: ConsoleSectionEntry["status"], recordId?: string) => {
      if (typeof targetOrigin !== "string" || !(kind === "local" ? isLoopbackConsoleOrigin(targetOrigin) : isRemoteConsoleOrigin(targetOrigin))) return;
      if (next.size >= 100 || [...next.values()].some((target) => target.origin === targetOrigin)) return;
      const key = `${kind}:${recordId ?? targetOrigin}`;
      const id = ids.get(key) ?? randomUUID();
      const entry: ConsoleSectionEntry = { id, kind, label: text(label, new URL(targetOrigin).host), address: new URL(targetOrigin).host, version: typeof version === "string" && version ? text(version, "", 64) || null : null, active: targetOrigin === current, home: targetOrigin === origin, status: kind === "remote" ? targets.get(id)?.entry.status ?? state : state };
      const candidate = { v: 1, expanded, entries: [...next.values()].map((target) => target.entry).concat(entry) };
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > CONSOLE_SECTION_MAX_FRAME) return;
      next.set(id, { origin: targetOrigin, ...(recordId ? { recordId } : {}), entry });
      nextIds.set(key, id);
    };
    append(origin, "local", status.name, status.version, "ready");
    const hosts = Array.isArray(saved.hosts) ? saved.hosts.map(record) : [];
    const locals = Array.isArray(nearby.consoles) ? nearby.consoles.map(record) : [];
    // 크기 상한에 닿더라도 집과 지금 서 있는 Console은 남긴다.
    const activeRemote = hosts.find((host) => host.origin === current);
    if (activeRemote && typeof activeRemote.id === "string") append(activeRemote.origin, "remote", activeRemote.label, null, null, activeRemote.id);
    if (current && current !== origin && !activeRemote) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null);
    for (const local of locals) append(local.origin, "local", local.origin === origin ? status.name : undefined, local.version, local.state === "stopping" ? "stopping" : local.state === "unresponsive" ? "slow" : "ready");
    for (const host of hosts) if (typeof host.id === "string") append(host.origin, "remote", host.label, null, null, host.id);
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
      do { refreshAgain = false; try { await load(); } catch (error) { deps.report(error); await publish(); } } while (refreshAgain && contents);
    })().finally(() => { refreshRunning = null; });
    return refreshRunning;
  }
  async function command(value: ConsoleSectionCommand): Promise<void> {
    if ("request" in value) { await refresh(); return; }
    if ("expanded" in value) { expanded = value.expanded; await publish(); if (expanded) await refresh(); return; }
    if ("add" in value) {
      const origin = home();
      if (origin) { const url = new URL("/console/", origin); url.searchParams.set("desktop-surface", "host-picker"); url.searchParams.set("intent", "add"); url.searchParams.set("at", at() ?? origin); deps.add(url.toString()); }
      return;
    }
    const id = "switch" in value ? value.switch : "forget" in value ? value.forget : value.rename.id;
    const target = targets.get(id);
    if (!target) return;
    if ("switch" in value) { await deps.open(target.origin); return; }
    if (!target.recordId || target.entry.kind !== "remote" || mutating) return;
    const epoch = generation;
    mutating = true;
    try {
      if ("forget" in value && !await deps.confirmForget(target.entry.label)) { await publish(); return; }
      if (epoch !== generation || targets.get(id)?.recordId !== target.recordId) return;
      await json(`/api/v1/remote-hosts/${encodeURIComponent(target.recordId)}`, "rename" in value ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: value.rename.label }) } : { method: "DELETE" });
      await refresh();
    } finally { mutating = false; }
  }
  function close(): void {
    generation++;
    detach(); detach = () => {};
    contents = null;
    targets.clear(); ids.clear(); expanded = true;
    budget = 0; budgetStart = 0;
  }
  return {
    refresh,
    close,
    observeHomeOverlay(overlay: Pick<WebContents, "once">): void {
      // 성공·취소·Escape·렌더러 종료 모두 덮개 수명이 끝난 뒤 집의 상태를 다시 읽는다.
      const epoch = generation;
      overlay.once("destroyed", () => { if (contents && epoch === generation) void refresh(); });
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
        const now = Date.now();
        if (now - budgetStart >= 1000) { budgetStart = now; budget = 0; }
        if (++budget > 20) return;
        const value = parseConsoleSectionCommand(url.searchParams.get("command") ?? "");
        if (value) void command(value).catch((error) => { deps.report(error); void publish(); });
      };
      const arrived = () => { generation++; void refresh(); };
      receiver.on("will-navigate", navigate as never);
      receiver.on("did-navigate", arrived);
      receiver.on("did-finish-load", arrived);
      detach = () => { receiver.removeListener("will-navigate", navigate as never); receiver.removeListener("did-navigate", arrived); receiver.removeListener("did-finish-load", arrived); };
    },
  };
}
