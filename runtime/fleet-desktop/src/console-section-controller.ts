import { randomUUID } from "node:crypto";
import { CONSOLE_SIDEBAR_EVENT, CONSOLE_SIDEBAR_PATH, SIDEBAR_OPERATIONS, SIDEBAR_CHUNK_CHARS, SIDEBAR_MAX_BYTES, sidebarDisplayJson, type ConsoleSidebarRequest, type ConsoleSidebarReply } from "@fleet-console/protocol/desktop/console-section";
import type { WebContents } from "electron";
import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { CONSOLE_COMMODORE_CREATE_EVENT, CONSOLE_OBJECTIVE_PEEK_EVENT, CONSOLE_OBJECTIVE_PEEK_PATH, CONSOLE_ROSTER_EVENT, CONSOLE_ROSTER_MAX_FRAME, CONSOLE_ROSTER_PATH, CONSOLE_SECTION_COMMAND, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_MAX_FRAME, CONSOLE_UNIFIED_SIDEBAR_EVENT, CONSOLE_WSL_EVENT, UNIFIED_SIDEBAR_HOME, UNIFIED_SIDEBAR_PATH, applyUnifiedSidebarCommand, fitUnifiedSidebarState, isConsoleObjectivePeek, isConsoleRosterSummary, isUnifiedSidebarLayout, isUnifiedSidebarState, parseConsoleSectionCommand, projectUnifiedSidebar, reconcileUnifiedSidebar, seedUnifiedFromSnapshots, withoutUnifiedConsole, type ConsoleCommodoreCreateResult, type ConsoleManagedDetail, type ConsoleWslInspection, type ConsoleWslState, type ConsoleRightPanel, type ConsoleObjectivePeekReply, type ConsoleRosterCommodore, type ConsoleRosterEntry, type ConsoleRosterState, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState, type UnifiedCreateReason, type UnifiedMachineSnapshot, type UnifiedSidebarLayout } from "@fleet-console/protocol/desktop/console-section";
import { consoleLifecycleActions, type ConsoleAccessPath, type ConsoleLifecycleAction, type ConsoleManagedLifecycle, type ConsoleManagementRelation } from "@fleet-console/protocol/lifecycle/management";
import type { RemotePinRecord } from "./remote-access.js";

type Contents = Pick<WebContents, "on" | "removeListener" | "getURL" | "isDestroyed" | "executeJavaScript">;
type Overlay = Pick<WebContents, "on" | "once" | "getURL" | "isDestroyed" | "executeJavaScript">;
/** `origin` is empty for a managed Console that is not running; `managedKey` names it to its manager. */
interface Target { readonly origin: string; readonly recordId?: string; readonly managedKey?: string; readonly entry: ConsoleSectionEntry }
/** The management relation of one Console as this Desktop proved it (docs/console-lifecycle-contract.md). */
export interface ManagedConsoleState {
  readonly management: ConsoleManagementRelation;
  readonly lifecycle: ConsoleManagedLifecycle | null;
  readonly identityProven: boolean;
}
/** The Console this Desktop's window lives on, as its lifecycle manager sees it. */
export interface ManagedHomeConsole {
  readonly state: () => Promise<ManagedConsoleState>;
  /**
   * Runs an action this controller judged allowed. Rejects when it could not be carried out. `follow` says the window
   * stood on this Console when the action was asked for, so it goes to the Console that comes back.
   */
  readonly run: (action: ConsoleLifecycleAction, follow: boolean) => Promise<void>;
}
/** A Console this Desktop manages besides its home one, as its manager judged it just now. */
export interface ManagedConsoleView {
  readonly key: string;
  readonly label: string;
  /** Where it answers, once it proved itself; null while it does not run. */
  readonly origin: string | null;
  readonly version: string | null;
  readonly path: ConsoleAccessPath;
  readonly state: ManagedConsoleState;
  readonly detail: ConsoleManagedDetail;
}
/** The managers of those Consoles. On Windows these are WSL distributions; the port names no OS. */
export interface ManagedConsoles {
  readonly list: () => Promise<readonly ManagedConsoleView[]>;
  /** Carries out an action this controller judged allowed and resolves to where the Console answers afterwards. */
  readonly run: (key: string, action: ConsoleLifecycleAction) => Promise<string | null>;
  readonly takeOver: (key: string) => Promise<string | null>;
  readonly update?: (key: string) => Promise<string>;
  /** Drops the registration only. */
  readonly remove: (key: string) => Promise<boolean>;
  readonly wsl: {
    readonly distros: () => Promise<ConsoleWslState["distros"]>;
    readonly inspect: (distro: string) => Promise<ConsoleWslInspection>;
    readonly add: (distro: string) => Promise<void>;
  };
}
type Relations = Pick<ConsoleSectionEntry, "management" | "path" | "lifecycle" | "actions">;
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
  readonly pinRemote?: (record: RemotePinRecord) => void;
  /** known-hosts 읽기를 시작하기 전의 장부 차례. 그 뒤에 넣은 항목을 옛 목록이 지우지 않게 한다. */
  readonly pinMark?: () => number;
  /** 성공적으로 읽은 known-hosts 전체로, 그 표식 이전 항목만 걷어 낸다. 새 항목은 넣지 않는다. */
  readonly reconcileRemotes?: (records: readonly RemotePinRecord[], mark: number) => void;
  readonly open: (origin: string) => Promise<void>;
  readonly add: (url: string) => void;
  /** Opens the management surface the home Console draws. Absent in a shell that offers none. */
  readonly manage?: (url: string) => void;
  readonly managedHome?: ManagedHomeConsole;
  /** The shell's own question before it starts its Console for a document that Console does not serve. */
  readonly confirmStart?: (label: string) => Promise<boolean>;
  readonly managedConsoles?: ManagedConsoles;
  /** The shell's own question before it drops a managed Console's registration. */
  readonly confirmUnmanage?: (label: string) => Promise<boolean>;
  readonly confirmForget: (label: string) => Promise<boolean>;
  readonly report: (error: unknown) => void;
}
interface RosterMemory {
  readonly status: ConsoleRosterEntry["status"];
  readonly at: number | null;
  readonly commodores: readonly ConsoleRosterCommodore[];
  readonly more: number;
  /** 그 Console의 사이드바 섹션. 요약에 실린 그대로이고, 실패 때는 마지막 성공 목록과 함께 남는다. */
  readonly sections?: ConsoleRosterEntry["sections"];
  /** 엿보기 경로를 가진 Console. 요약에 실린 그대로이고, 실패 때는 마지막 성공 목록과 함께 남는다. */
  readonly objectivePeek?: true;
  readonly unsectionedCollapsed?: true;
  readonly attemptedAt: number;
}
interface Arrival { readonly origin: string; readonly commodore: string; readonly anchorY: number | null; readonly commander: string | null; readonly scrollTop: number | null; readonly rightPanel: ConsoleRightPanel | null }
/** 집의 원격 목록에 있는 신원. 핸드오프(토큰 소진)로는 받지 않고, 문서에도 보내지 않는다. */
interface RemoteIdentity { readonly hostname: string; readonly port: number; readonly fingerprint: string }

const ROSTER_INTERVAL_MS = 15_000;
const ROSTER_TIMEOUT_MS = 5_000;
/** 엿보기 읽기의 타임아웃. 명부 읽기와 같다. */
const PEEK_TIMEOUT_MS = 5_000;
/** 같은 목표의 재요청 최소 간격. 그 안의 반복은 새로 읽지 않고 직전 답을 다시 건넨다. */
const PEEK_MIN_INTERVAL_MS = 2_000;
/** 같은 목표의 직전 답을 기억하는 상한. 창당 동시 1건과 함께 폭주를 막는다. */
const PEEK_CACHE_SIZE = 20;
const ARRIVAL_TTL_MS = 30_000;

const text = (value: unknown, fallback: string, max = 120): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max) : "") || fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/**
 * A Console found on this computer says who started it; that names its manager, it does not make this Desktop one.
 * The list carries only locks it could read and trust, so one without a Desktop owner is a Console no Desktop started.
 */
const managementOfLocal = (owner: unknown): ConsoleManagementRelation => owner === "desktop" ? "other-desktop" : owner === "cli" || owner === null ? "cli" : "unknown";
const cleanId = (value: string): boolean => value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);

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
  /** A lifecycle request is being judged, confirmed, or carried out. */
  let judging = false;
  const noWsl: ConsoleWslState = { v: 1, distros: [], inspection: null, busy: null, added: null, error: null };
  let wslState = noWsl;
  let switchSerial = 0;
  let arrival: Arrival | null = null;
  let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
  const folded = new Set<string>();
  const rosterMemory = new Map<string, RosterMemory>();
  /** 진행 중인 엿보기 읽기. 창당 동시 1건 — 다음 요청은 이것이 끝난 뒤에 간다. */
  let peekFlight: Promise<void> | null = null;
  /** 목표 키(`${consoleId}\n${objectiveId}`)별 직전 답. 2초 안의 반복에 다시 건넨다. */
  const peekReplies = new Map<string, { readonly at: number; readonly status: ConsoleObjectivePeekReply["status"]; readonly snapshot?: ConsoleObjectivePeekReply["snapshot"] }>();
  let unifiedLayout: UnifiedSidebarLayout | null = null;
  let remoteIdentities = new Map<string, RemoteIdentity>();
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
    const kept = (target: Target): boolean => target.origin === homeOrigin || target.origin === current || target.managedKey !== undefined;
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
  /**
   * The home Console's relations. Management comes only from the manager's own proof; while an action runs, the
   * section says so and offers nothing. A shell without a manager sends no relation, as shells did before this contract.
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
  const kept = (memory: RosterMemory | undefined): Pick<RosterMemory, "sections" | "unsectionedCollapsed" | "objectivePeek"> => ({
    ...(memory?.sections ? { sections: memory.sections } : {}), ...(memory?.unsectionedCollapsed ? { unsectionedCollapsed: true as const } : {}),
    ...(memory?.objectivePeek ? { objectivePeek: true as const } : {}),
  });
  function rosterEntries(): ConsoleRosterEntry[] {
    const standing = at();
    return [...targets.values()].filter((target) => target.origin !== "" && target.origin !== standing).map((target) => {
      const memory = rosterMemory.get(target.origin);
      return { id: target.entry.id, status: memory?.status ?? "unavailable", at: memory?.at ?? null, commodores: memory?.commodores ?? [], more: memory?.more ?? 0, ...kept(memory) };
    });
  }
  /**
   * 틀이 상한을 넘으면 뒤쪽부터 세 단계로 줄인다: 미리보기, 다음에 진행 중 사령관, 마지막에 사령관과 명부.
   * 사령관을 빼면 그 사령관의 moreCommanders를, 사령관(commodore)을 빼면 그 명부의 more를 올린다. 기억은 건드리지 않는다.
   */
  function fitRosters(entries: readonly ConsoleRosterEntry[], foldedList: readonly string[], arrivalField: ConsoleRosterState["arrival"]): ConsoleRosterEntry[] {
    const rosters = entries.map((entry) => ({ ...entry, commodores: [...entry.commodores] }));
    const bytes = (): number => new TextEncoder().encode(JSON.stringify({ v: 1, rosters, folded: foldedList, arrival: arrivalField })).length;
    // 줄일 때마다 해당 사령관 객체를 새로 만든다. 같은 객체가 기억에도 있다.
    const trimLast = (shrink: (commodore: ConsoleRosterCommodore) => ConsoleRosterCommodore | null): boolean => {
      for (let cursor = rosters.length - 1; cursor >= 0; cursor -= 1) {
        const roster = rosters[cursor];
        if (!roster) continue;
        for (let position = roster.commodores.length - 1; position >= 0; position -= 1) {
          const commodore = roster.commodores[position];
          const smaller = commodore ? shrink(commodore) : null;
          if (smaller) { roster.commodores[position] = smaller; return true; }
        }
      }
      return false;
    };
    const dropPreview = (commodore: ConsoleRosterCommodore): ConsoleRosterCommodore | null => {
      if (commodore.preview === undefined) return null;
      const { preview: _preview, ...rest } = commodore;
      return rest;
    };
    const dropCommander = (commodore: ConsoleRosterCommodore): ConsoleRosterCommodore | null => {
      const list = commodore.commanders;
      if (!list || list.length === 0) return null;
      return { ...commodore, commanders: list.slice(0, -1), moreCommanders: (commodore.moreCommanders ?? 0) + 1 };
    };
    while (bytes() > CONSOLE_ROSTER_MAX_FRAME) {
      if (trimLast(dropPreview) || trimLast(dropCommander)) continue;
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
    const arrivalField: ConsoleRosterState["arrival"] = arrival && origin === arrival.origin ? {
      commodore: arrival.commodore, anchorY: arrival.anchorY,
      ...(arrival.commander !== null ? { commander: arrival.commander } : {}), ...(arrival.scrollTop !== null ? { scrollTop: arrival.scrollTop } : {}),
      ...(arrival.rightPanel !== null ? { rightPanel: arrival.rightPanel } : {}),
    } : null;
    const state: ConsoleRosterState = { v: 1, rosters: fitRosters(rosterEntries(), foldedList, arrivalField), folded: foldedList, arrival: arrivalField };
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_ROSTER_EVENT)},{detail:${JSON.stringify(state)}}))`;
    await receiver.executeJavaScript(script).catch(() => undefined);
  }
  function rememberUnavailable(origin: string, previous: RosterMemory | undefined, attemptedAt: number): void {
    const keep = previous && previous.status !== "unsupported";
    rosterMemory.set(origin, { status: "unavailable", at: keep ? previous.at : null, commodores: keep ? previous.commodores : [], more: keep ? previous.more : 0, ...(keep ? kept(previous) : {}), attemptedAt });
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
      return { status: "ok", at: attemptedAt, commodores: [...body.commodores], more: body.more, ...(body.sections ? { sections: [...body.sections] } : {}), ...(body.unsectionedCollapsed ? { unsectionedCollapsed: true as const } : {}), ...(body.objectivePeek ? { objectivePeek: true as const } : {}), attemptedAt };
    } catch {
      return { status: "unsupported", at: null, commodores: [], more: 0, attemptedAt };
    }
  }
  function unavailableFrom(previous: RosterMemory | undefined, attemptedAt: number): RosterMemory {
    const keep = previous && previous.status !== "unsupported";
    return { status: "unavailable", at: keep ? previous.at : null, commodores: keep ? previous.commodores : [], more: keep ? previous.more : 0, ...(keep ? kept(previous) : {}), attemptedAt };
  }
  function remoteIdentity(host: Record<string, unknown>): RemoteIdentity | null {
    const hostname = host.hostname;
    const port = host.port;
    const fingerprint = host.fingerprint;
    if (typeof hostname !== "string" || hostname.length === 0 || hostname.length > 255) return null;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;
    if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65_535) return null;
    return { hostname, port: port as number, fingerprint };
  }
  /**
   * 목록에 있는 지문으로만 대조하고, 맞은 뒤에만 핀한다. 핸드오프는 부르지 않는다 —
   * 그 호출은 1회용 토큰을 소진하고 연 시각을 남긴다. 목록에 없으면 세션 fetch도 없다.
   */
  async function admitRemote(origin: string): Promise<boolean> {
    if (!deps.confirmIdentity || !deps.pinRemote) return false;
    const identity = remoteIdentities.get(origin);
    if (!identity) return false;
    try { await deps.confirmIdentity(identity.hostname, identity.port, identity.fingerprint); } catch { return false; }
    deps.pinRemote({ origin, hostname: identity.hostname, port: identity.port, fingerprint: identity.fingerprint });
    return true;
  }
  async function fetchRoster(target: Target): Promise<void> {
    const origin = target.origin;
    const previous = rosterMemory.get(origin);
    const now = Date.now();
    if (previous && now - previous.attemptedAt < ROSTER_INTERVAL_MS) return;
    // 집 프로브가 이미 거절한 원격에는 세션 fetch를 보내지 않는다.
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
  /** 엿보기 답을 요청한 origin의 문서에만 건넨다. 창이 그새 다른 Console로 가면 버린다. */
  async function dispatchPeek(origin: string | null, reply: ConsoleObjectivePeekReply): Promise<void> {
    const receiver = contents;
    if (!receiver || receiver.isDestroyed() || !origin || at() !== origin) return;
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_OBJECTIVE_PEEK_EVENT)},{detail:${JSON.stringify(reply)}}))`;
    await receiver.executeJavaScript(script).catch(() => undefined);
  }
  function rememberPeek(key: string, status: ConsoleObjectivePeekReply["status"], snapshot?: ConsoleObjectivePeekReply["snapshot"]): void {
    peekReplies.set(key, { at: Date.now(), status, ...(snapshot ? { snapshot } : {}) });
    while (peekReplies.size > PEEK_CACHE_SIZE) {
      const oldest = peekReplies.keys().next();
      if (oldest.done) break;
      peekReplies.delete(oldest.value);
    }
  }
  /**
   * 다른 Console의 진행 중 목표 하나를 명부와 같은 배관으로 읽는다. 세션을 열거나 join하지 않는다.
   * 불투명 id가 창 목록에 없으면 요청을 보내지 않고, 실패는 네 가지로만 구분해 넘긴다.
   */
  async function fetchPeek(consoleId: string, objectiveId: string, key: string): Promise<{ readonly status: ConsoleObjectivePeekReply["status"]; readonly snapshot?: ConsoleObjectivePeekReply["snapshot"] }> {
    const target = targets.get(consoleId);
    if (!target || target.origin === "") return { status: "not_found" };
    const origin = target.origin;
    // 믿을 수 없거나 닿지 않는 원격에는 보내지 않는다.
    if (target.entry.kind === "remote" && (target.entry.status === "untrusted" || target.entry.status === "unreachable")) return { status: "unavailable" };
    const memory = rosterMemory.get(origin);
    // 명부 경로가 없거나 옛 응답인 Console에는 엿보기 경로도 없다.
    if (memory && (memory.status === "unsupported" || (memory.status === "ok" && !memory.objectivePeek))) return { status: "unsupported" };
    if (target.entry.kind === "remote" && !await admitRemote(origin)) return { status: "unavailable" };
    const http = target.entry.kind === "remote" ? deps.rosterFetch : (deps.rosterFetch ?? deps.fetch);
    if (!http) return { status: "unavailable" };
    try {
      const headers = new Headers();
      // 루프백 API는 다른 Origin을 401로 거절한다. 대상 자신을 싣는다.
      headers.set("Origin", origin);
      const url = new URL(CONSOLE_OBJECTIVE_PEEK_PATH, origin);
      url.searchParams.set("id", objectiveId);
      const response = await http(url.toString(), { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(PEEK_TIMEOUT_MS) });
      if (response.status === 404) return { status: "not_found" };
      if (response.status === 401) { await drain(response); return { status: "unauthorized" }; }
      if (!response.ok) { await drain(response); return { status: "unavailable" }; }
      let body: unknown;
      try { body = await response.json(); } catch { return { status: "unsupported" }; }
      if (!isConsoleObjectivePeek(body)) return { status: "unsupported" };
      rememberPeek(key, "ok", body);
      return { status: "ok", snapshot: body };
    } catch { return { status: "unavailable" }; }
  }
  async function runPeek(peek: { readonly console: string; readonly objective: string; readonly nonce: string }, fromHome: boolean): Promise<void> {
    const origin = at();
    const answer = (status: ConsoleObjectivePeekReply["status"], snapshot?: ConsoleObjectivePeekReply["snapshot"]): Promise<void> =>
      dispatchPeek(origin, { nonce: peek.nonce, console: peek.console, objective: peek.objective, status, ...(snapshot ? { snapshot } : {}) });
    // 집 문서의 요청만 받는다 — 수명주기 명령과 같은 판정. 다른 Console의 페이지가 셸을 대리인 삼아 읽는 길을 막는다.
    if (!fromHome) { await answer("unauthorized"); return; }
    const key = `${peek.console}\n${peek.objective}`;
    const cached = peekReplies.get(key);
    if (cached && Date.now() - cached.at < PEEK_MIN_INTERVAL_MS) {
      await answer(cached.status, cached.snapshot);
      return;
    }
    // 창당 동시 1건 — 진행 중인 읽기가 있으면 그 뒤에 잇는다.
    while (peekFlight) { try { await peekFlight; } catch { /* 앞선 읽기의 실패는 그 요청이 이미 받았다. */ } }
    const fresh = peekReplies.get(key);
    if (fresh && Date.now() - fresh.at < PEEK_MIN_INTERVAL_MS) {
      await answer(fresh.status, fresh.snapshot);
      return;
    }
    let release = () => {};
    peekFlight = new Promise<void>((resolve) => { release = resolve; });
    try {
      const result = await fetchPeek(peek.console, peek.objective, key);
      await answer(result.status, result.snapshot);
    } finally {
      peekFlight = null;
      release();
    }
  }
  async function collectRosters(epoch: number, next: Map<string, Target>): Promise<void> {
    if (epoch !== generation || targets !== next) return;
    // 서 있는 콘솔의 명부도 읽어 기억해 둔다. 프레임에는 싣지 않지만(그 문서가 직접 그린다), 전환하면 떠나온 콘솔이
    // 도착 문서의 첫 프레임부터 같은 자리에 같은 내용으로 그려져야 한다.
    await Promise.all([...next.values()].filter((target) => target.origin !== "").map((target) => fetchRoster(target)));
    if (epoch !== generation || targets !== next) return;
    await publishRoster();
    await syncUnified(epoch);
  }
  async function load(): Promise<void> {
    const origin = home();
    const epoch = generation;
    if (!origin || !contents || !at()) return;
    const { reachable, ...homeExtra } = await homeRelations();
    if (epoch !== generation) return;
    const built: Target[] = [];
    const nextIds = new Map<string, string>();
    const seen = new Set<string>();
    const current = at();
    // An older shell sent no relation at all; without a manager this shell keeps doing so.
    const relate = (management: ConsoleManagementRelation, path: ConsoleAccessPath): Relations => deps.managedHome ? { management, path } : {};
    const managed = deps.managedConsoles ? await deps.managedConsoles.list().catch((error: unknown) => { deps.report(error); return []; }) : [];
    if (epoch !== generation) return;
    /**
     * Consoles this Desktop manages besides its home one. They come from its own registry, not from the home Console's
     * lists, so they stand whether or not the home Console answers, and whether or not they run.
     */
    const appendManaged = (): void => {
      for (const view of managed) {
        if (view.origin !== null && seen.has(view.origin)) continue;
        const key = `managed:${view.key}`;
        const id = ids.get(key) ?? randomUUID();
        const label = text(view.label, "WSL");
        const removable = view.state.management !== "this-desktop" || view.state.lifecycle === "stopped" || view.state.lifecycle === "failed";
        const entry: ConsoleSectionEntry = {
          id, kind: "local", label, address: view.origin ? new URL(view.origin).host : label, version: view.version ? text(view.version, "", 64) || null : null,
          active: view.origin !== null && view.origin === current, home: false,
          status: view.origin !== null ? "ready" : view.state.lifecycle === "stopping" ? "stopping" : "unreachable",
          management: view.state.management, path: view.path, lifecycle: view.state.lifecycle, actions: consoleLifecycleActions({ ...view.state, home: false }),
          managed: { ...view.detail, ...(removable ? { removable: true as const } : {}) },
        };
        built.push({ origin: view.origin ?? "", managedKey: view.key, entry });
        nextIds.set(key, id);
        if (view.origin !== null) seen.add(view.origin);
      }
    };
    const append = (targetOrigin: unknown, kind: "local" | "remote", label: unknown, version: unknown, state: ConsoleSectionEntry["status"], extra: Relations, recordId?: string) => {
      if (typeof targetOrigin !== "string" || !(kind === "local" ? isLoopbackConsoleOrigin(targetOrigin) : isRemoteConsoleOrigin(targetOrigin))) return;
      if (seen.has(targetOrigin)) return;
      const key = `${kind}:${recordId ?? targetOrigin}`;
      const id = ids.get(key) ?? randomUUID();
      const entry: ConsoleSectionEntry = { id, kind, label: text(label, new URL(targetOrigin).host), address: new URL(targetOrigin).host, version: typeof version === "string" && version ? text(version, "", 64) || null : null, active: targetOrigin === current, home: targetOrigin === origin, status: kind === "remote" ? targets.get(id)?.entry.status ?? state : state, ...extra };
      built.push({ origin: targetOrigin, ...(recordId ? { recordId } : {}), entry });
      nextIds.set(key, id);
      seen.add(targetOrigin);
    };
    /**
     * The home Console does not answer, so its own lists cannot be read. Its section stays, with the name it last had
     * and the relations the manager just proved, so the person sees what happened instead of the last list that worked.
     * The Console being viewed carries no relation here: the management surface is the home Console's to draw.
     */
    const homeOnly = async (): Promise<void> => {
      const before = [...targets.values()].find((target) => target.entry.home)?.entry;
      append(origin, "local", before?.label, before?.version, "unreachable", homeExtra);
      appendManaged();
      if (current && !seen.has(current)) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null, {});
      targets = new Map(built.map((target) => [target.entry.id, target]));
      ids = nextIds;
      await publish();
      await publishRoster();
    };
    // A managed home Console that is stopped is not a failure to report.
    if (!reachable) { await homeOnly(); return; }
    let lists: readonly [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    // 읽기가 나가기 전의 차례. 응답을 기다리는 동안 열린 원격은 이 목록에 없어도 장부에 남는다.
    const pinMark = deps.pinMark?.() ?? Number.POSITIVE_INFINITY;
    try {
      lists = await Promise.all([json("/api/v1/remote-hosts"), json("/api/v1/local-consoles"), json("/api/v1/status")]);
    } catch (error) {
      // Another owner's Console in the slot, or one that cannot be judged: still unreachable from here, and reported.
      if (deps.managedHome && epoch === generation) await homeOnly();
      throw error;
    }
    const [saved, nearby, status] = lists;
    if (epoch !== generation) return;
    // 순서는 활성과 무관하게 고정한다. 밝기만 active로 바뀐다.
    append(origin, "local", status.name, status.version, "ready", homeExtra);
    appendManaged();
    const hosts = Array.isArray(saved.hosts) ? saved.hosts.map(record) : [];
    const identities = new Map<string, RemoteIdentity>();
    for (const host of hosts) {
      if (typeof host.origin !== "string") continue;
      const identity = remoteIdentity(host);
      if (identity) identities.set(host.origin, identity);
    }
    // 화면에서 잘린 뒤가 아니라, 읽어 온 목록 전체다. 배열이 아니면 읽기 실패로 보고 장부를 비우지 않는다.
    if (Array.isArray(saved.hosts)) deps.reconcileRemotes?.([...identities].map(([origin, identity]) => ({ origin, ...identity })), pinMark);
    const locals = Array.isArray(nearby.consoles) ? nearby.consoles.map(record) : [];
    for (const local of locals) append(local.origin, "local", local.origin === origin ? status.name : undefined, local.version, local.state === "stopping" ? "stopping" : local.state === "unresponsive" ? "slow" : "ready",
      relate(managementOfLocal(local.owner), typeof local.distro === "string" && local.distro ? "wsl" : "loopback"));
    for (const host of hosts) if (typeof host.id === "string") append(host.origin, "remote", host.label, null, null, relate("unknown", "remote"), host.id);
    // 저장되지 않은 현재 origin은 맨 뒤에 둔다. 틀을 넘기면 집·현재가 아닌 뒤쪽부터 뺀다.
    if (current && !seen.has(current)) append(current, isLoopbackConsoleOrigin(current) ? "local" : "remote", new URL(current).host, null, null, relate("unknown", isLoopbackConsoleOrigin(current) ? "loopback" : "remote"));
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
      remoteIdentities = identities;
      await publish();
      await collectRosters(epoch, next);
    }
  }
  function refresh(): Promise<void> {
    if (refreshRunning) { refreshAgain = true; return refreshRunning; }
    refreshRunning = (async () => {
      do { refreshAgain = false; try { await load(); } catch (error) { deps.report(error); if (!deps.managedHome) await publish(); await publishRoster(); } } while (refreshAgain && contents);
    })().finally(() => { refreshRunning = null; });
    return refreshRunning;
  }
  /**
   * A lifecycle action on the Console this Desktop manages. Authority is judged here, from the manager's fresh proof,
   * never from what the page was last told: the entry must be the home Console and the action one the contract allows
   * for its present state.
   */
  async function runLifecycle(id: string, action: ConsoleLifecycleAction, fromHome: boolean): Promise<void> {
    const target = targets.get(id);
    // One request at a time, held from before the first await: a second press must not start a second transition.
    if (!target || judging) return;
    if (target.managedKey !== undefined) { await runManaged(target, target.managedKey, action, fromHome); return; }
    if (!target.entry.home || !deps.managedHome) return;
    judging = true;
    try {
      const state = await deps.managedHome.state();
      const lifecycle = failed && state.lifecycle === "stopped" ? "failed" : state.lifecycle;
      if (!consoleLifecycleActions({ ...state, lifecycle, home: true }).includes(action)) { await refresh(); return; }
      // A document the home Console does not serve cannot speak for the person, so the shell asks them itself.
      if (!fromHome && !await deps.confirmStart?.(target.entry.label)) { await refresh(); return; }
      // The window follows only when it stands on this Console; a person working on another one stays there.
      const follow = at() === home();
      running = action;
      failed = false;
      await refresh();
      try {
        await deps.managedHome.run(action, follow);
      } catch (error) {
        failed = true;
        deps.report(error);
      } finally {
        running = null;
        await refresh();
      }
    } finally {
      judging = false;
    }
  }
  /**
   * The same judgment for a Console this Desktop manages besides its home one. Its manager keeps its own transition
   * state, so the request is held only until the action is handed over: a first start may install for minutes.
   */
  async function runManaged(target: Target, key: string, action: ConsoleLifecycleAction, fromHome: boolean): Promise<void> {
    const consoles = deps.managedConsoles;
    if (!consoles) return;
    let standing = false;
    judging = true;
    try {
      const view = (await consoles.list()).find((entry) => entry.key === key);
      if (!view || !consoleLifecycleActions({ ...view.state, home: false }).includes(action)) { await refresh(); return; }
      if (!fromHome && !await deps.confirmStart?.(target.entry.label)) { await refresh(); return; }
      standing = target.origin !== "" && at() === target.origin;
      // The window cannot stay on a Console that is about to stop.
      const back = home();
      if (standing && action === "stop" && back) await deps.open(back);
    } finally {
      judging = false;
    }
    try {
      const origin = await consoles.run(key, action);
      if (standing && action === "restart" && origin) await deps.open(origin);
    } catch (error) {
      deps.report(error);
    } finally {
      await refresh();
    }
  }
  async function publishWsl(): Promise<void> {
    const origin = home();
    // Only the home Console's own surface hears this: it names distributions and a Linux user.
    if (!overlay || overlay.isDestroyed() || !origin) return;
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_WSL_EVENT)},{detail:${JSON.stringify(wslState)}}))`;
    await overlay.executeJavaScript(script).catch(() => undefined);
  }
  /** The WSL add flow. Listing starts no distribution; inspecting one is the person's explicit step and may. */
  async function runWsl(request: Extract<ConsoleSectionCommand, { readonly wsl: unknown }>["wsl"]): Promise<void> {
    const port = deps.managedConsoles?.wsl;
    if (!port) return;
    try {
      if ("inspect" in request) {
        wslState = { ...wslState, inspection: null, busy: "inspect", added: null, error: null };
        await publishWsl();
        wslState = { ...wslState, inspection: await port.inspect(request.inspect), busy: null };
      } else if ("add" in request) {
        await port.add(request.add);
        wslState = { ...wslState, added: request.add, error: null };
        await refresh();
      } else {
        wslState = noWsl;
      }
      wslState = { ...wslState, distros: await port.distros() };
    } catch (error) {
      // The surface says what went wrong itself; this is not a window-level failure.
      wslState = { ...wslState, busy: null, error: error instanceof Error && error.message === "wsl_distro_unusable" ? "unusable" : "failed" };
    }
    await publishWsl();
  }
  function consoleIdOf(target: Target): string | null {
    if (target.entry.home) return UNIFIED_SIDEBAR_HOME;
    if (target.recordId) return target.recordId;
    if (target.managedKey) return target.managedKey;
    return target.origin || null;
  }
  function machineSnapshots(): UnifiedMachineSnapshot[] {
    return [...targets.values()].flatMap((target) => {
      const consoleId = consoleIdOf(target);
      if (!consoleId) return [];
      const memory = target.origin ? rosterMemory.get(target.origin) : undefined;
      const roster = memory ? {
        status: memory.status, more: memory.more, sections: memory.sections ?? [], commodores: memory.commodores,
        ...(memory.unsectionedCollapsed ? { unsectionedCollapsed: true as const } : {}),
      } : null;
      return [{
        consoleId, label: target.entry.label || target.entry.address, address: target.entry.address || target.entry.label,
        home: target.entry.home, kind: target.entry.kind, status: target.entry.status, entryId: target.entry.id, ...(target.entry.path ? { path: target.entry.path } : {}), roster,
      }];
    });
  }
  async function readUnified(): Promise<"absent" | "invalid" | UnifiedSidebarLayout> {
    const origin = home();
    if (!origin) return "invalid";
    try {
      const headers = new Headers();
      headers.set("Origin", origin);
      const response = await deps.fetch(new URL(UNIFIED_SIDEBAR_PATH, origin).toString(), { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return "invalid";
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || (body as { v?: unknown }).v !== 1 || !("layout" in body)) return "invalid";
      const layout = (body as { layout: unknown }).layout;
      if (layout === null) return "absent";
      return isUnifiedSidebarLayout(layout) ? layout : "invalid";
    } catch { return "invalid"; }
  }
  async function writeUnified(layout: UnifiedSidebarLayout): Promise<void> {
    const origin = home();
    if (!origin) return;
    const headers = new Headers();
    headers.set("Origin", origin);
    headers.set("Content-Type", "application/json");
    const response = await deps.fetch(new URL(UNIFIED_SIDEBAR_PATH, origin).toString(), { method: "POST", headers, body: JSON.stringify({ layout }), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("unified_sidebar_write_failed");
  }
  async function publishUnified(): Promise<void> {
    const receiver = contents;
    const origin = at();
    if (!receiver || receiver.isDestroyed() || !origin || !unifiedLayout) return;
    const state = fitUnifiedSidebarState(projectUnifiedSidebar(unifiedLayout, machineSnapshots()));
    if (!isUnifiedSidebarState(state)) return;
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_UNIFIED_SIDEBAR_EVENT)},{detail:${JSON.stringify(state)}}))`;
    await receiver.executeJavaScript(script).catch(() => undefined);
  }
  function publishCreate(result: ConsoleCommodoreCreateResult): void {
    const receiver = contents;
    const origin = at();
    if (!receiver || receiver.isDestroyed() || !origin) return;
    const script = `if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_COMMODORE_CREATE_EVENT)},{detail:${JSON.stringify(result)}}))`;
    void receiver.executeJavaScript(script).catch(() => undefined);
  }
  async function syncUnified(epoch: number): Promise<void> {
    if (epoch !== generation) return;
    const stored = await readUnified();
    if (epoch !== generation || stored === "invalid") return;
    const snapshots = machineSnapshots();
    const seeded = stored === "absent" ? seedUnifiedFromSnapshots(snapshots, randomUUID) : stored;
    if (!seeded) return;
    const next = stored === "absent" ? seeded : reconcileUnifiedSidebar(seeded, snapshots, randomUUID);
    if (stored === "absent" || JSON.stringify(next) !== JSON.stringify(stored)) {
      try { await writeUnified(next); } catch (error) { deps.report(error); return; }
      if (epoch !== generation) return;
    }
    unifiedLayout = next;
    await publishUnified();
  }
  async function dropUnifiedConsole(consoleId: string): Promise<void> {
    if (!unifiedLayout) return;
    const next = withoutUnifiedConsole(unifiedLayout, consoleId);
    if (JSON.stringify(next) === JSON.stringify(unifiedLayout)) return;
    unifiedLayout = next;
    try { await writeUnified(next); } catch (error) { deps.report(error); }
    await publishUnified();
  }
  async function runUnified(command: Extract<ConsoleSectionCommand, { readonly unified: unknown }>["unified"]): Promise<void> {
    if (!unifiedLayout) await syncUnified(generation);
    if (command.op === "state" || !unifiedLayout) { await publishUnified(); return; }
    const next = applyUnifiedSidebarCommand(unifiedLayout, command, randomUUID);
    if (!next) return;
    unifiedLayout = next;
    try { await writeUnified(next); } catch (error) { deps.report(error); return; }
    await publishUnified();
  }
  async function runCreateCommodore(command: Extract<ConsoleSectionCommand, { readonly createCommodore: unknown }>["createCommodore"]): Promise<void> {
    const fail = (reason: UnifiedCreateReason) => {
      publishCreate({ v: 1, request: command.request, consoleId: command.consoleId, ok: false, reason });
    };
    const target = [...targets.values()].find((item) => consoleIdOf(item) === command.consoleId);
    const blocked = target?.entry.status ?? null;
    const down: UnifiedCreateReason = blocked === "unreachable" ? "unreachable" : "unavailable";
    if (!target || !target.origin) { fail(down); return; }
    if (blocked === "untrusted") { fail("untrusted"); return; }
    if (blocked === "unreachable") { fail("unreachable"); return; }
    const http = target.entry.kind === "remote" ? deps.rosterFetch ?? deps.fetch : deps.fetch;
    try {
      const headers = new Headers();
      headers.set("Origin", target.origin);
      headers.set("Content-Type", "application/json");
      const response = await http(new URL("/api/v1/commodore/create", target.origin).toString(), { method: "POST", headers, body: JSON.stringify({ alias: command.alias }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.status === 401 || response.status === 403) { fail("access"); return; }
      if (response.status === 404) { fail("unsupported"); return; }
      if (response.status === 400) { fail("invalid"); return; }
      if (!response.ok) { fail("unavailable"); return; }
      const body: unknown = await response.json();
      const commodoreId = body && typeof body === "object" && !Array.isArray(body) ? (body as { commodoreId?: unknown }).commodoreId : undefined;
      if (typeof commodoreId !== "string" || commodoreId.length === 0) { fail("unavailable"); return; }
      if (command.look) {
        // 옛 콘솔은 이 쓰기를 몰라도 생성은 유지한다. 키 모양은 콘솔의 commodoreAvatarKey와 같다.
        const face = new Headers();
        face.set("Origin", target.origin);
        face.set("Content-Type", "application/json");
        await http(new URL("/api/v1/avatars", target.origin).toString(), { method: "PUT", headers: face, body: JSON.stringify({ mode: "set", key: `theater:commodore:${commodoreId}`, base: command.look.base, tone: command.look.tone }), redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
      publishCreate({ v: 1, request: command.request, consoleId: command.consoleId, ok: true, commodoreId });
      const previous = rosterMemory.get(target.origin);
      if (previous) rosterMemory.set(target.origin, { ...previous, attemptedAt: 0 });
      await refresh();
    } catch { fail(down); }
  }
  let sidebarFlights = 0;
  const sidebarWatches = new Set<string>();
  const sidebarAborts = new Set<AbortController>();
  async function runSidebar(request: ConsoleSidebarRequest): Promise<void> {
    const receiver = contents;
    const origin = at();
    const epoch = generation;
    const send = async (reply: Omit<ConsoleSidebarReply, "console" | "nonce">) => {
      if (!origin || at() !== origin || epoch !== generation || !receiver || receiver.isDestroyed()) return;
      const detail: ConsoleSidebarReply = { console: request.console, nonce: request.nonce, ...reply };
      await receiver.executeJavaScript(`if(location.origin===${JSON.stringify(origin)}&&location.pathname.startsWith('/console/'))window.dispatchEvent(new CustomEvent(${JSON.stringify(CONSOLE_SIDEBAR_EVENT)},{detail:${JSON.stringify(detail)}}))`).catch(() => undefined);
    };
    const fail = (status: number) => send({ status, type: "application/json", data: "", index: 0, done: true });
    const target = targets.get(request.console);
    if (!target?.origin || target.entry.status === "untrusted" || target.entry.status === "unreachable" || target.entry.status === "stopping") { await fail(503); return; }
    const watchKey = `${epoch}\n${origin}\n${request.console}`;
    const watching = request.operation === "changes";
    if (watching ? sidebarWatches.has(watchKey) || sidebarWatches.size >= 100 : sidebarFlights >= 6) { await fail(429); return; }
    if (watching) sidebarWatches.add(watchKey); else sidebarFlights++;
    const abort = new AbortController(); sidebarAborts.add(abort);
    try {
      if (target.entry.kind === "remote" && !await admitRemote(target.origin)) { await fail(401); return; }
      const http = target.entry.kind === "remote" ? deps.rosterFetch : deps.rosterFetch ?? deps.fetch;
      if (!http) { await fail(503); return; }
      const operation = SIDEBAR_OPERATIONS[request.operation];
      const url = new URL(`${CONSOLE_SIDEBAR_PATH}${request.operation}`, target.origin);
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
      const response = await http(url.toString(), { method: operation.method, headers: { Origin: target.origin, "Content-Type": "application/json" },
        ...(operation.method !== "GET" && request.body !== undefined ? { body: JSON.stringify(request.body) } : {}), redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > SIDEBAR_MAX_BYTES) { await reader.cancel(); await fail(413); return; }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks);
      // 원격 HTML/SVG는 문서나 실행 코드로 중계하지 않는다. 파일은 명시적 byte blob이다.
      const incoming = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
      const json = !["evidence", "sharedFile"].includes(request.operation) || incoming === "application/json";
      const type = json ? "application/json" : /^(?:text\/plain|image\/(?:png|jpeg|webp|gif))$/.test(incoming) ? incoming : "application/octet-stream";
      const safe = json && raw.length > 0 ? Buffer.from(sidebarDisplayJson(raw.toString("utf8"))) : raw;
      const data = safe.toString("base64");
      const count = Math.max(1, Math.ceil(data.length / SIDEBAR_CHUNK_CHARS));
      for (let index = 0; index < count; index++) await send({ status: response.status, type, data: data.slice(index * SIDEBAR_CHUNK_CHARS, (index + 1) * SIDEBAR_CHUNK_CHARS), index, done: index === count - 1 });
      // 쓰기 결과는 다음 읽기에서 원천을 확인한다. 세션을 열거나 화면을 옮기지 않는다.
    } catch { await fail(503); } finally { sidebarAborts.delete(abort); if (watching) sidebarWatches.delete(watchKey); else sidebarFlights--; }
  }
  async function command(value: ConsoleSectionCommand, fromHome: boolean): Promise<void> {
    if ("sidebar" in value) { await runSidebar(value.sidebar); return; }
    // 막 적재된 문서는 도착할 사령관을 기다리며 「다 그렸다」를 미룬다. 집 목록과 명부를 다시 읽기 전에
    // 지금 아는 상태를 먼저 건네야 그 기다림이 조회 시간만큼 늘어나지 않는다.
    if ("request" in value) { await publish(); await publishRoster(); await publishUnified(); await refresh(); return; }
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
    if ("peek" in value) { await runPeek(value.peek, fromHome); return; }
    // Lifecycle is the manager's alone. A document the home Console serves may ask: the stale home page of a stopped
    // Console, or the management surface. A page of another Console shows the section too, and a stopped Console has
    // no surface of its own to be asked from, so from there only `start` is taken up, and only after the shell's own
    // confirmation.
    if ("lifecycle" in value) {
      if (fromHome || (value.lifecycle.action === "start" && deps.confirmStart)) await runLifecycle(value.lifecycle.id, value.lifecycle.action, fromHome);
      return;
    }
    if ("wsl" in value) { if (fromHome) await runWsl(value.wsl); return; }
    if ("update" in value) {
      const target = targets.get(value.update);
      if (!fromHome || !target?.managedKey || !target.entry.managed?.update || !deps.managedConsoles?.update) return;
      const follow = at() === target.origin;
      try {
        const origin = await deps.managedConsoles.update(target.managedKey);
        if (follow) await deps.open(origin);
      } catch (error) { deps.report(error); } finally { await refresh(); }
      return;
    }
    if ("unified" in value) { await runUnified(value.unified); return; }
    if ("createCommodore" in value) { await runCreateCommodore(value.createCommodore); return; }
    if ("takeover" in value) {
      // The person hands a Console they started from a terminal to this Desktop, from the surface the home Console draws.
      const taken = targets.get(value.takeover);
      if (!fromHome || !taken?.managedKey || !taken.entry.managed?.takeover || !deps.managedConsoles) return;
      try { await deps.managedConsoles.takeOver(taken.managedKey); } catch (error) { deps.report(error); } finally { await refresh(); }
      return;
    }
    const id = "switch" in value ? value.switch : "forget" in value ? value.forget : "manage" in value ? value.manage : value.rename.id;
    const target = targets.get(id);
    if (!target) return;
    if ("manage" in value) {
      const origin = home();
      // The surface is the home Console's document, so it opens only while that Console answers.
      const homeDown = [...targets.values()].some((entry) => entry.entry.home && entry.entry.status === "unreachable");
      if (!origin || !deps.manage || target.entry.management === undefined || homeDown) return;
      const url = new URL("/console/", origin);
      url.searchParams.set("desktop-surface", "host-picker"); url.searchParams.set("intent", "manage"); url.searchParams.set("target", id); url.searchParams.set("at", at() ?? origin);
      deps.manage(url.toString());
      return;
    }
    if ("switch" in value) {
      // A managed Console that is not running has nowhere to go; it is started first.
      if (target.origin === "") return;
      const serial = ++switchSerial;
      // 다음 전환이 시작되면 이전 도착 표시는 바로 지운다. 실패해도 다시 켜지 않는다.
      clearArrival();
      const commodore = value.commodore ?? null;
      const anchorY = value.anchorY ?? null;
      // 사령관 없이 Console만 바꾸는 전환에는 도착 표시가 없다(계약상 arrival.commodore는 필수). 그때의 scrollTop은 쓰이지 않는다.
      const commander = value.commander ?? null;
      const scrollTop = value.scrollTop ?? null;
      const rightPanel = value.rightPanel ?? null;
      // 새 문서는 적재되자마자 상태를 요청한다. open이 끝나기 전에 세워 두어야 그 요청에 실린다.
      // publishRoster는 도착한 origin에서만 arrival을 넣으므로 떠나는 문서에는 새지 않는다.
      if (commodore) {
        arrival = { origin: target.origin, commodore, anchorY, commander, scrollTop, rightPanel };
        arrivalTimer = setTimeout(() => {
          if (switchSerial === serial && arrival?.origin === target.origin && arrival.commodore === commodore) { clearArrival(); void publishRoster(); }
        }, ARRIVAL_TTL_MS);
        arrivalTimer.unref?.();
      }
      try { await deps.open(target.origin); } catch (error) {
        if (serial === switchSerial) clearArrival();
        throw error;
      }
      if (serial !== switchSerial) return;
      await publishRoster();
      return;
    }
    // Renaming and forgetting act on a saved record. The record grants them, not the kind the section is drawn with.
    if (target.managedKey !== undefined) {
      // Dropping a managed Console forgets its registration only, after the shell's own question.
      if (!("forget" in value) || !target.entry.managed?.removable || !deps.managedConsoles || !await deps.confirmUnmanage?.(target.entry.label)) return;
      try {
        await deps.managedConsoles.remove(target.managedKey);
        await dropUnifiedConsole(target.managedKey);
      } catch (error) { deps.report(error); } finally { await refresh(); }
      return;
    }
    if (!target.recordId || mutating) return;
    const epoch = generation;
    mutating = true;
    try {
      if ("forget" in value && !await deps.confirmForget(target.entry.label)) { await publish(); return; }
      if (epoch !== generation || targets.get(id)?.recordId !== target.recordId) return;
      await json(`/api/v1/remote-hosts/${encodeURIComponent(target.recordId)}`, "rename" in value ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: value.rename.label }) } : { method: "DELETE" });
      if ("forget" in value) await dropUnifiedConsole(target.recordId);
      await refresh();
    } finally { mutating = false; }
  }
  function close(): void {
    for (const abort of sidebarAborts) abort.abort();
    generation++;
    detach(); detach = () => {};
    contents = null;
    overlay = null;
    targets.clear(); ids.clear(); expanded = true;
    budget = 0; budgetStart = 0;
    switchSerial++;
    clearArrival();
    folded.clear();
    rosterMemory.clear();
    peekReplies.clear();
    unifiedLayout = null;
    remoteIdentities = new Map();
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
        const now = Date.now();
        if (now - budgetStart >= 1000) { budgetStart = now; budget = 0; }
        if (++budget > 20) return;
        const value = parseConsoleSectionCommand(url.searchParams.get("command") ?? "");
        if (value && ("lifecycle" in value || "request" in value || "takeover" in value || "update" in value || "wsl" in value || "forget" in value)) void command(value, true).catch((error) => { deps.report(error); void publish(); });
      }) as never);
      view.on("did-finish-load", (() => { if (overlay === view && epoch === generation) void refresh(); }) as never);
      // 성공·취소·Escape·렌더러 종료 모두 덮개 수명이 끝난 뒤 집의 상태를 다시 읽는다.
      view.once("destroyed", () => { if (overlay === view) { overlay = null; wslState = noWsl; } if (contents && epoch === generation) void refresh(); });
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
        if (value) void command(value, at() === home()).catch((error) => { deps.report(error); void publish(); void publishRoster(); });
      };
      const arrived = () => { for (const abort of sidebarAborts) abort.abort(); generation++; void publish().then(publishRoster).finally(() => { void refresh(); }); };
      receiver.on("will-navigate", navigate as never);
      receiver.on("did-navigate", arrived);
      receiver.on("did-finish-load", arrived);
      detach = () => { receiver.removeListener("will-navigate", navigate as never); receiver.removeListener("did-navigate", arrived); receiver.removeListener("did-finish-load", arrived); };
      void refresh();
    },
  };
}
