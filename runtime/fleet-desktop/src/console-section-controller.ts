import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { CONSOLE_ROSTER_EVENT, CONSOLE_ROSTER_MAX_FRAME, CONSOLE_ROSTER_PATH, CONSOLE_SECTION_COMMAND, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_MAX_FRAME, isConsoleRosterSummary, parseConsoleSectionCommand, type ConsoleRosterCommodore, type ConsoleRosterEntry, type ConsoleRosterState, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState } from "@fleet-console/protocol/desktop/console-section";

type Contents = Pick<WebContents, "on" | "removeListener" | "getURL" | "isDestroyed" | "executeJavaScript">;
interface Target { readonly origin: string; readonly recordId?: string; readonly entry: ConsoleSectionEntry }
interface Dependencies {
  readonly home: () => string | null;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * 명부 GET. 생산 경로는 창 세션의 페어링 쿠키를 베껴 오는 shellNetwork.fetch다.
   * 루프백은 그 함수가 Node fetch로 넘긴다. 조인 URL은 여기서 부르지 않는다.
   */
  readonly rosterFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** 평문 소켓으로 지문을 대조한다. 실패하면 그 원격에는 세션 fetch를 보내지 않는다. */
  readonly confirmIdentity?: (hostname: string, port: number, fingerprint: string) => Promise<void>;
  /** 대조가 끝난 뒤에만 핀한다. 핀은 세션 fetch가 인증서를 받아들이게 할 뿐 조인을 대신하지 않는다. */
  readonly pinRemote?: (hostname: string, fingerprint: string) => void;
  readonly open: (origin: string) => Promise<void>;
  readonly add: (url: string) => void;
  readonly confirmForget: (label: string) => Promise<boolean>;
  readonly report: (error: unknown) => void;
}
interface RosterMemory {
  readonly status: ConsoleRosterEntry["status"];
  readonly at: number | null;
  readonly commodores: readonly ConsoleRosterCommodore[];
  readonly more: number;
  readonly attemptedAt: number;
}
interface Arrival { readonly origin: string; readonly commodore: string; readonly anchorY: number | null }

const ROSTER_INTERVAL_MS = 15_000;
const ROSTER_TIMEOUT_MS = 5_000;
const ARRIVAL_TTL_MS = 30_000;
/** 열기 경로와 같은 집 API. 지문만 꺼내고 자격(token)은 읽지 않는다. */
const HANDOFF_PATH = "/api/v1/desktop/handoff";

const text = (value: unknown, fallback: string, max = 120): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max) : "") || fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cleanId = (value: string): boolean => value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

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
  let switchSerial = 0;
  let arrival: Arrival | null = null;
  let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
  const folded = new Set<string>();
  const rosterMemory = new Map<string, RosterMemory>();
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
  function clearArrival(): void {
    arrival = null;
    if (arrivalTimer) clearTimeout(arrivalTimer);
    arrivalTimer = null;
  }
  function foldedIds(): string[] {
    return [...folded].filter(cleanId).slice(0, 100);
  }
  function sectionFrame(entries: readonly ConsoleSectionEntry[]): number {
    return new TextEncoder().encode(JSON.stringify({ v: 1, expanded, entries })).length;
  }
  /** 집과 지금 서 있는 콘솔은 남기고, 잘리는 것은 뒤쪽의 나머지다. 남은 항목의 순서는 바꾸지 않는다. */
  function trimEntries(list: readonly Target[], homeOrigin: string, current: string | null): Target[] {
    const next = [...list];
    const kept = (target: Target): boolean => target.origin === homeOrigin || target.origin === current;
    const drop = (): boolean => {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index];
        if (candidate && !kept(candidate)) { next.splice(index, 1); return true; }
      }
      return false;
    };
    while (next.length > 100 && drop()) { /* 검증기가 100개를 넘기면 거절한다. */ }
    while (next.length > 1 && sectionFrame(next.map((target) => target.entry)) > CONSOLE_SECTION_MAX_FRAME && drop()) { /* 틀은 뒤쪽부터. */ }
    return next;
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
  function rosterEntries(): ConsoleRosterEntry[] {
    const standing = at();
    return [...targets.values()].filter((target) => target.origin !== standing).map((target) => {
      const memory = rosterMemory.get(target.origin);
      return { id: target.entry.id, status: memory?.status ?? "unavailable", at: memory?.at ?? null, commodores: memory?.commodores ?? [], more: memory?.more ?? 0 };
    });
  }
  /** 뒤쪽 명부의 사령관부터 빼고, 뺀 수만큼 그 명부의 more를 올린다. 기억은 건드리지 않는다. */
  function fitRosters(entries: readonly ConsoleRosterEntry[], foldedList: readonly string[], arrivalField: ConsoleRosterState["arrival"]): ConsoleRosterEntry[] {
    const rosters = entries.map((entry) => ({ ...entry, commodores: [...entry.commodores] }));
    const bytes = (): number => new TextEncoder().encode(JSON.stringify({ v: 1, rosters, folded: foldedList, arrival: arrivalField })).length;
    while (bytes() > CONSOLE_ROSTER_MAX_FRAME) {
      let index = -1;
      for (let cursor = rosters.length - 1; cursor >= 0; cursor -= 1) {
        if ((rosters[cursor]?.commodores.length ?? 0) > 0) { index = cursor; break; }
      }
      const chosen = index >= 0 ? rosters[index] : undefined;
      if (chosen) { chosen.commodores.pop(); chosen.more += 1; continue; }
      if (rosters.length === 0) break;
      rosters.pop();
    }
    return rosters;
  }
  async function publishRoster(): Promise<void> {
    const receiver = contents;
    const origin = at();
    if (!receiver || receiver.isDestroyed() || !origin) return;
    const foldedList = foldedIds();
    // arrival은 전환이 도착한 그 origin의 문서에만 실린다. 다른 문서의 스크립트에는 null이다.
    const arrivalField: ConsoleRosterState["arrival"] = arrival && origin === arrival.origin ? { commodore: arrival.commodore, anchorY: arrival.anchorY } : null;
    const state: ConsoleRosterState = { v: 1, rosters: fitRosters(rosterEntries(), foldedList, arrivalField), folded: foldedList, arrival: arrivalField };
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_ROSTER_EVENT)},{detail:${JSON.stringify(state)}}))`;
    await receiver.executeJavaScript(script).catch(() => undefined);
  }
  function rememberUnavailable(origin: string, previous: RosterMemory | undefined, attemptedAt: number): void {
    const keep = previous && previous.status !== "unsupported";
    rosterMemory.set(origin, { status: "unavailable", at: keep ? previous.at : null, commodores: keep ? previous.commodores : [], more: keep ? previous.more : 0, attemptedAt });
  }
  async function drain(response: Response): Promise<void> {
    try { await response.body?.cancel(); } catch { /* 이미 읽었거나 비어 있다. */ }
  }
  /** 404·다른 형식은 unsupported. 401·그 밖 실패는 unavailable이고 마지막 성공 목록을 남긴다. */
  async function classify(response: Response, previous: RosterMemory | undefined, attemptedAt: number): Promise<RosterMemory> {
    if (response.status === 404) { await drain(response); return { status: "unsupported", at: null, commodores: [], more: 0, attemptedAt }; }
    if (response.status === 401 || !response.ok) { await drain(response); return unavailableFrom(previous, attemptedAt); }
    try {
      const body: unknown = await response.json();
      if (!isConsoleRosterSummary(body)) return { status: "unsupported", at: null, commodores: [], more: 0, attemptedAt };
      return { status: "ok", at: attemptedAt, commodores: [...body.commodores], more: body.more, attemptedAt };
    } catch {
      return { status: "unsupported", at: null, commodores: [], more: 0, attemptedAt };
    }
  }
  function unavailableFrom(previous: RosterMemory | undefined, attemptedAt: number): RosterMemory {
    const keep = previous && previous.status !== "unsupported";
    return { status: "unavailable", at: keep ? previous.at : null, commodores: keep ? previous.commodores : [], more: keep ? previous.more : 0, attemptedAt };
  }
  /**
   * 열기와 같은 순서: 집 핸드오프에서 지문을 받고, 평문 소켓으로 대조한 뒤에만 핀한다.
   * 자격은 꺼내지 않고 조인도 부르지 않는다. 대조 실패는 핀도 세션 fetch도 없다.
   */
  async function admitRemote(origin: string): Promise<boolean> {
    if (!deps.confirmIdentity || !deps.pinRemote) return false;
    let body: Record<string, unknown>;
    try {
      body = await json(HANDOFF_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
    } catch { return false; }
    const hostname = body.hostname;
    const port = body.port;
    const fingerprint = body.fingerprint;
    if (typeof hostname !== "string" || hostname.length === 0 || hostname.length > 255 || typeof fingerprint !== "string" || fingerprint.length === 0) return false;
    if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65_535) return false;
    try { await deps.confirmIdentity(hostname, port as number, fingerprint); } catch { return false; }
    deps.pinRemote(hostname, fingerprint);
    return true;
  }
  async function fetchRoster(target: Target): Promise<void> {
    const origin = target.origin;
    const previous = rosterMemory.get(origin);
    const now = Date.now();
    if (previous && now - previous.attemptedAt < ROSTER_INTERVAL_MS) return;
    // 집 프로브가 이미 거절한 원격에는 핸드오프도 세션 fetch도 보내지 않는다.
    if (target.entry.kind === "remote" && (target.entry.status === "untrusted" || target.entry.status === "unreachable")) {
      rememberUnavailable(origin, previous, now);
      return;
    }
    if (target.entry.kind === "remote" && !await admitRemote(origin)) {
      rememberUnavailable(origin, previous, Date.now());
      return;
    }
    const http = target.entry.kind === "remote" ? deps.rosterFetch : (deps.rosterFetch ?? deps.fetch);
    if (!http) { rememberUnavailable(origin, previous, Date.now()); return; }
    const attemptedAt = Date.now();
    try {
      const headers = new Headers();
      // 루프백 API는 다른 Origin을 401로 거절한다. 대상 자신을 싣는다.
      headers.set("Origin", origin);
      const response = await http(new URL(CONSOLE_ROSTER_PATH, origin).toString(), { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS) });
      rosterMemory.set(origin, await classify(response, previous, attemptedAt));
    } catch { rememberUnavailable(origin, previous, attemptedAt); }
  }
  async function collectRosters(epoch: number, next: Map<string, Target>): Promise<void> {
    if (epoch !== generation || targets !== next) return;
    const standing = at();
    await Promise.all([...next.values()].filter((target) => target.origin !== standing).map((target) => fetchRoster(target)));
    if (epoch !== generation || targets !== next) return;
    await publishRoster();
  }
  async function load(): Promise<void> {
    const origin = home();
    const epoch = generation;
    if (!origin || !contents || !at()) return;
    const [saved, nearby, status] = await Promise.all([json("/api/v1/remote-hosts"), json("/api/v1/local-consoles"), json("/api/v1/status")]);
    if (epoch !== generation) return;
    const built: Target[] = [];
    const nextIds = new Map<string, string>();
    const seen = new Set<string>();
    const current = at();
    const append = (targetOrigin: unknown, kind: "local" | "remote", label: unknown, version: unknown, state: ConsoleSectionEntry["status"], recordId?: string) => {
      if (typeof targetOrigin !== "string" || !(kind === "local" ? isLoopbackConsoleOrigin(targetOrigin) : isRemoteConsoleOrigin(targetOrigin))) return;
      if (seen.has(targetOrigin)) return;
      const key = `${kind}:${recordId ?? targetOrigin}`;
      const id = ids.get(key) ?? randomUUID();
      const entry: ConsoleSectionEntry = { id, kind, label: text(label, new URL(targetOrigin).host), address: new URL(targetOrigin).host, version: typeof version === "string" && version ? text(version, "", 64) || null : null, active: targetOrigin === current, home: targetOrigin === origin, status: kind === "remote" ? targets.get(id)?.entry.status ?? state : state };
      built.push({ origin: targetOrigin, ...(recordId ? { recordId } : {}), entry });
      nextIds.set(key, id);
      seen.add(targetOrigin);
    };
    // 순서는 활성과 무관하게 고정한다. 밝기만 active로 바뀐다.
    append(origin, "local", status.name, status.version, "ready");
    const hosts = Array.isArray(saved.hosts) ? saved.hosts.map(record) : [];
    const locals = Array.isArray(nearby.consoles) ? nearby.consoles.map(record) : [];
    for (const local of locals) append(local.origin, "local", local.origin === origin ? status.name : undefined, local.version, local.state === "stopping" ? "stopping" : local.state === "unresponsive" ? "slow" : "ready");
    for (const host of hosts) if (typeof host.id === "string") append(host.origin, "remote", host.label, null, null, host.id);
    // 저장되지 않은 현재 origin은 맨 뒤에 둔다. 틀을 넘기면 집·현재가 아닌 뒤쪽부터 뺀다.
    if (current && !seen.has(current)) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null);
    const trimmed = trimEntries(built, origin, current);
    const keptIds = new Set(trimmed.map((target) => target.entry.id));
    for (const [key, id] of nextIds) if (!keptIds.has(id)) nextIds.delete(key);
    const next = new Map(trimmed.map((target) => [target.entry.id, target]));
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
    if (epoch === generation && targets === next) {
      await publish();
      await collectRosters(epoch, next);
    }
  }
  function refresh(): Promise<void> {
    if (refreshRunning) { refreshAgain = true; return refreshRunning; }
    refreshRunning = (async () => {
      do { refreshAgain = false; try { await load(); } catch (error) { deps.report(error); await publish(); await publishRoster(); } } while (refreshAgain && contents);
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
    if ("fold" in value) {
      if (value.fold.folded) folded.add(value.fold.id); else folded.delete(value.fold.id);
      await publishRoster();
      return;
    }
    // 도착 확인은 그 문서를 연 origin에서만 받는다. 다른 문서의 arrived는 지우지 않는다.
    if ("arrived" in value) {
      if (arrival && at() === arrival.origin) { clearArrival(); await publishRoster(); }
      return;
    }
    const id = "switch" in value ? value.switch : "forget" in value ? value.forget : value.rename.id;
    const target = targets.get(id);
    if (!target) return;
    if ("switch" in value) {
      const serial = ++switchSerial;
      // 다음 전환이 시작되면 이전 도착 표시는 바로 지운다. 실패해도 다시 켜지 않는다.
      clearArrival();
      const commodore = value.commodore ?? null;
      const anchorY = value.anchorY ?? null;
      try { await deps.open(target.origin); } catch (error) {
        if (serial === switchSerial) clearArrival();
        throw error;
      }
      if (serial !== switchSerial || !commodore) return;
      arrival = { origin: target.origin, commodore, anchorY };
      arrivalTimer = setTimeout(() => { if (arrival?.commodore === commodore && arrival.origin === target.origin) { clearArrival(); void publishRoster(); } }, ARRIVAL_TTL_MS);
      arrivalTimer.unref?.();
      await publishRoster();
      return;
    }
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
    switchSerial++;
    clearArrival();
    folded.clear();
    rosterMemory.clear();
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
        if (value) void command(value).catch((error) => { deps.report(error); void publish(); void publishRoster(); });
      };
      const arrived = () => { generation++; void refresh(); };
      receiver.on("will-navigate", navigate as never);
      receiver.on("did-navigate", arrived);
      receiver.on("did-finish-load", arrived);
      detach = () => { receiver.removeListener("will-navigate", navigate as never); receiver.removeListener("did-navigate", arrived); receiver.removeListener("did-finish-load", arrived); };
      void refresh();
    },
  };
}
