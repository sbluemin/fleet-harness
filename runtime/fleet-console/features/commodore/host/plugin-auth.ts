import { createHash } from "node:crypto";
import { ClaudeMcpControlUnsupportedError, type ClaudeGatewayExternalMcpServer, type ClaudeMcpControl, type ClaudeMcpServerState } from "@fleet-console/agent-runtime/claude";

import { CommodoreStoreError } from "./errors.js";
import type { PluginAuthServer } from "./plugins.js";
import type { CommodorePluginAuthView, PluginAuthFailure, PluginServerAuthView } from "../shared/contracts/plugins.js";

/**
 * 사령관 플러그인 MCP 인증 — 상태를 읽고, Claude Code 의 내장 MCP OAuth 로 로그인시키고, 해제한다.
 *
 * Console 은 OAuth 클라이언트로 등록하지 않는다(서비스가 클라이언트 이름으로 동적 등록을 거르는 일이 있다). 대신 모델 턴 없는
 * Claude 자식(인증 확인 자식)을 사령관 세션과 따로 띄워, 세션들이 쓰는 것과 같은 서버 이름·설정으로 붙인다. 토큰은 그 자식이
 * Claude Code 보안 저장소에 두고(이름과 `{type,url,headers}`가 열쇠), 사령관·목표 세션이 같은 열쇠로 읽는다. 이 모듈은
 * 토큰을 보지도 저장하지도 않는다.
 *
 * - 상태: 화면이 물을 때 자식을 띄워 `mcp_status`를 읽고 잠시 기억한다. 사령관 세션이 살아 있든 없든 같은 답이다.
 * - 인증: 자식이 인증 주소를 주면 화면이 연다. 콜백은 자식이 loopback 에서 직접 받고, 완료는 상태를 다시 읽어 판정한다.
 * - 키(`${VAR}`): 값이 없으면 확인하지 않고 「키 필요」다. 값이 있는 원격 서버는 함께 붙여 거절되면 실패로 보인다.
 */

export interface PluginAuthControlPort {
  /** 서버들을 붙인 인증 확인 자식을 연다. `env`는 선언의 `${VAR}` 키다. 닫기는 `release`다. */
  open(servers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>, env: Readonly<Record<string, string>>): Promise<{ readonly control: ClaudeMcpControl; release(): Promise<void> }>;
}

export interface CommodorePluginAuthOptions {
  readonly servers: (pluginIds: readonly string[]) => readonly PluginAuthServer[];
  readonly env: (pluginIds: readonly string[]) => Readonly<Record<string, string>>;
  readonly control: PluginAuthControlPort;
  /** OAuth 서버의 MCP 표준 신호를 직접 읽는다. 생략하면 `readMcpAuthSignal`이다. */
  readonly signal?: (config: ClaudeGatewayExternalMcpServer) => Promise<"needs-auth" | PluginAuthFailure>;
  /** 토큰이 생기거나 지워진 플러그인 — 그 플러그인을 고른 사령관의 다음 턴이 새 세션으로 이어지게 한다. */
  readonly changed: (pluginIds: readonly string[]) => void;
  readonly now?: () => number;
}

/** 확인한 상태를 다시 읽지 않고 쓰는 시간. 사람이 할 일이 있는 동안(진행 중)은 매번 자식에게 묻는다. */
const STATUS_FRESH_MS = 60_000;
/** 서버가 붙기를 기다리는 상한 — 넘으면 남은 것은 모르는 상태로 둔다. */
const SETTLE_MS = 15_000;
const SETTLE_POLL_MS = 300;
/** 브라우저에서 돌아오기를 기다리는 상한. */
const FLOW_MS = 5 * 60_000;
const FLOW_POLL_MS = 2_000;
/** 옮겨 붙인 콜백 뒤 저장이 끝나기를 한 번 기다리는 시간. */
const CALLBACK_SETTLE_MS = 1_000;
/** 할 일이 끝난 자식을 접기까지 — 상태를 본 사람이 곧 「인증…」을 누르면 같은 자식을 쓴다. */
const IDLE_MS = 30_000;
/** 실패 표시를 남겨 두는 시간. */
const FAILURE_MS = 10 * 60_000;
const SIGNAL_TIMEOUT_MS = 8_000;

/**
 * 토큰 없이 서버에 MCP `initialize`를 보내 표준 신호를 읽는다 — 401 과 `WWW-Authenticate: Bearer`면 로그인이 필요한 서버다.
 * Claude Code 는 401 뒤에 보안 저장소를 엄격하게 한 번 더 읽는데, 그 읽기가 실패하는 Mac 에서는 로그인 전 서버를
 * `needs-auth`가 아니라 `failed`로 보고한다(CLI 2.1.312 실측). 그때 이 신호로 다시 판정한다. 응답 본문은 읽지 않는다.
 */
export async function readMcpAuthSignal(config: ClaudeGatewayExternalMcpServer): Promise<"needs-auth" | PluginAuthFailure> {
  if (config.type === "stdio") return "error";
  // 펼치지 않은 자리표시가 남은 주소·헤더는 보내지 않는다.
  if (config.url.includes("${") || Object.values(config.headers ?? {}).some((value) => value.includes("${"))) return "error";
  let response: Response;
  try {
    response = await fetch(config.url, config.type === "sse"
      ? { method: "GET", redirect: "manual", signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS), headers: { ...config.headers, accept: "text/event-stream" } }
      : { method: "POST", redirect: "manual", signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS), headers: { ...config.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleet-console", version: "1" } } }) });
  } catch (error) { return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable"; }
  void response.body?.cancel().catch(() => undefined);
  return response.status === 401 && /^\s*bearer\b/i.test(response.headers.get("www-authenticate") ?? "") ? "needs-auth" : "error";
}

interface Broker {
  readonly commodoreId: string;
  readonly signature: string;
  /** 서버 이름 → 그 서버의 서명(이름·설정·그 서버가 참조하는 키 값의 해시). */
  readonly servers: ReadonlyMap<string, string>;
  readonly names: ReadonlySet<string>;
  readonly control: ClaudeMcpControl;
  release(): Promise<void>;
  idle: ReturnType<typeof setTimeout> | null;
  /** 지금 이 자식으로 상태를 읽거나 인증을 시작하는 호출 수. */
  uses: number;
  /** 더는 그 사령관의 확인 자식이 아니다 — 쥔 흐름과 사용이 끝나면 접는다. */
  retired: boolean;
  closed: boolean;
}
interface Flow {
  readonly broker: Broker;
  readonly pluginId: string;
  readonly authUrl: string;
  readonly local: boolean;
  readonly deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
}
type States = ReadonlyMap<string, ClaudeMcpServerState["status"]>;

export function createCommodorePluginAuth(options: CommodorePluginAuthOptions) {
  const now = options.now ?? Date.now;
  /**
   * 사령관마다 지금의 확인 자식 하나 — 고른 플러그인과 키가 다르면 붙일 서버와 환경도 다르다. 바뀌어 물러난 자식은 쥔 인증
   * 흐름이 끝날 때까지 살아 있다(그 자식이 loopback 콜백을 기다린다).
   */
  const brokers = new Map<string, Broker>();
  const live = new Set<Broker>();
  /** 사령관마다 마지막으로 원한 서명 — 늦게 열린 옛 서명의 자식이 새 자식을 밀어내지 않게 한다. */
  const wanted = new Map<string, string>();
  const opening = new Map<string, Promise<Broker>>();
  const cache = new Map<string, { readonly at: number; readonly signature: string; readonly states: States }>();
  /** 진행 중인 확인 — 사령관과 서명으로 묶는다. 키를 바꾼 뒤의 확인이 옛 키로 도는 확인의 결과를 받지 않는다. */
  const probing = new Map<string, Promise<States>>();
  /** 서버 이름마다 — 토큰도 서버마다 하나라 어느 사령관에서 시작했든 같은 흐름이다. */
  const flows = new Map<string, Flow>();
  const failures = new Map<string, { readonly failure: PluginAuthFailure; readonly at: number }>();
  /** Claude Code 가 `failed`로 보고했고 표준 신호로도 로그인 요구가 아니었던 OAuth 서버의 짧은 이유. */
  const checks = new Map<string, PluginAuthFailure>();
  const signal = options.signal ?? readMcpAuthSignal;
  let disposed = false;

  /** 확인 자식에 붙일 서버 — OAuth 원격 서버와 값이 다 있는 키 원격 서버. stdio 는 띄우지 않는다(플러그인 명령이 돈다). */
  const targets = (servers: readonly PluginAuthServer[]) => servers.filter((server) => server.config.type !== "stdio" && server.missing.length === 0 && server.unsupported.length === 0);
  /** 자식에 얹을 키 — 붙일 서버가 참조하는 이름만. 다른 플러그인(예: stdio 전용)의 키는 이 자식과 무관하다. */
  const envFor = (servers: readonly PluginAuthServer[], pluginIds: readonly string[]): Record<string, string> => {
    const all = options.env(pluginIds);
    const names = new Set(servers.flatMap((server) => server.keys));
    return Object.fromEntries(Object.entries(all).filter(([name]) => names.has(name)));
  };
  /**
   * 서버 하나의 서명. 키 값은 선언이 아니라 자식 환경으로 들어가므로 그 서버가 참조하는 키 값의 해시를 함께 넣는다 — 키를 바꾸면
   * 그 키를 쓰는 서버만 달라지고, 다른 서버(진행 중인 OAuth 흐름)는 그대로다. 값은 해시로만 남긴다.
   */
  const serverSignature = (server: PluginAuthServer, env: Readonly<Record<string, string>>) =>
    JSON.stringify([server.name, server.config, createHash("sha256").update(JSON.stringify(server.keys.map((key) => [key, env[key] ?? null]))).digest("hex")]);
  const plan = (pluginIds: readonly string[]) => {
    const servers = targets(options.servers(pluginIds));
    const env = envFor(servers, pluginIds);
    const signatures = new Map(servers.map((server) => [server.name, serverSignature(server, env)]));
    const signature = JSON.stringify([...signatures.values()].sort());
    return { servers, env, signatures, signature };
  };

  const hasFlows = (broker: Broker) => [...flows.values()].some((flow) => flow.broker === broker);
  const close = (broker: Broker) => {
    if (broker.closed) return;
    broker.closed = true;
    if (broker.idle) clearTimeout(broker.idle);
    broker.idle = null;
    if (brokers.get(broker.commodoreId) === broker) brokers.delete(broker.commodoreId);
    live.delete(broker);
    broker.control.close();
    void broker.release().catch(() => undefined);
  };
  /** 물러난 자식은 쥔 흐름과 사용이 끝나면 바로, 지금의 자식은 할 일이 끝나고 잠시 뒤 접는다. */
  const settle = (broker: Broker) => {
    if (broker.closed) return;
    if (broker.idle) clearTimeout(broker.idle);
    broker.idle = null;
    if (broker.uses > 0 || hasFlows(broker)) return;
    if (broker.retired || !broker.control.alive) { close(broker); return; }
    broker.idle = setTimeout(() => close(broker), IDLE_MS);
    broker.idle.unref?.();
  };
  const unlease = (broker: Broker) => { broker.uses = Math.max(0, broker.uses - 1); settle(broker); };

  /**
   * 흐름 하나를 끝낸다. 콜백을 기다리던 loopback 포트는 그 자식을 접어야 닫히므로, 그 자식이 쥔 다른 흐름이 없으면 물려
   * 접는다(다음 확인은 새 자식으로 한다). 다른 흐름이 있으면 그 흐름들이 끝날 때까지 둔다.
   */
  const endFlow = (name: string, flow: Flow, failure?: PluginAuthFailure) => {
    if (flows.get(name) !== flow) return;
    if (flow.timer) clearTimeout(flow.timer);
    flows.delete(name);
    if (failure) fail(name, failure);
    cache.clear();
    if (!hasFlows(flow.broker)) { flow.broker.retired = true; if (brokers.get(flow.broker.commodoreId) === flow.broker) brokers.delete(flow.broker.commodoreId); }
    settle(flow.broker);
  };
  /**
   * 지금의 자식을 물린다. 쥔 흐름 중 그 서버의 서명이 새 계획에도 그대로인 것은 그 자식에서 계속되고, 서명이 바뀐(설정·키가 바뀐)
   * 서버의 흐름은 이유를 남기고 끝난다.
   */
  const retire = (broker: Broker, keep: (name: string, signature: string | undefined) => boolean) => {
    broker.retired = true;
    if (brokers.get(broker.commodoreId) === broker) brokers.delete(broker.commodoreId);
    for (const [name, flow] of [...flows]) if (flow.broker === broker && !keep(name, broker.servers.get(name))) endFlow(name, flow, "changed");
    settle(broker);
  };

  /**
   * 진행 중인 흐름을 지금의 계획과 맞춘다 — 그 흐름을 쥔 자식이 지금의 자식이든 물러난 자식이든. 흐름의 서버가 계획에 있는데
   * 서명(설정·참조 키)이 달라졌거나, 이 사령관의 흐름인데 서버가 계획에서 빠졌으면 그 흐름은 옛 설정의 로그인이라 이유를 남기고
   * 끝낸다. 다시 시작하면 새 설정으로 연다.
   */
  const revalidate = (commodoreId: string, signatures: ReadonlyMap<string, string>) => {
    for (const [name, flow] of [...flows]) {
      const next = signatures.get(name);
      if (next === undefined ? flow.broker.commodoreId === commodoreId : flow.broker.servers.get(name) !== next) endFlow(name, flow, "changed");
    }
  };

  /** 그 사령관의 확인 자식을 빌린다. 쓴 뒤 `unlease`로 돌려준다. */
  const lease = async (commodoreId: string, pluginIds: readonly string[]): Promise<{ readonly broker: Broker; readonly servers: readonly PluginAuthServer[] }> => {
    const { servers, env, signatures, signature } = plan(pluginIds);
    revalidate(commodoreId, signatures);
    if (!servers.length) throw new CommodoreStoreError("invalid_request");
    wanted.set(commodoreId, signature);
    const take = (broker: Broker) => { broker.uses += 1; if (broker.idle) clearTimeout(broker.idle); broker.idle = null; return { broker, servers }; };
    const current = brokers.get(commodoreId);
    if (current && current.control.alive && current.signature === signature) return take(current);
    if (current) retire(current, (name, kept) => kept !== undefined && signatures.get(name) === kept);
    const key = `${commodoreId}\0${signature}`;
    let work = opening.get(key);
    if (!work) {
      work = (async () => {
        const opened = await options.control.open(Object.fromEntries(servers.map(({ name, config }) => [name, config])), env);
        const broker: Broker = { commodoreId, signature, servers: signatures, names: new Set(signatures.keys()), control: opened.control, release: opened.release, idle: null, uses: 0, retired: false, closed: false };
        live.add(broker);
        if (disposed) { close(broker); throw new CommodoreStoreError("commodore_unavailable"); }
        // 여는 동안 더 새로운 계획이 왔으면 이 자식은 지금의 자식이 되지 못한다 — 빌린 호출이 끝나면 접힌다.
        if (wanted.get(commodoreId) !== signature) broker.retired = true;
        else {
          const previous = brokers.get(commodoreId);
          if (previous && previous !== broker) retire(previous, (name, kept) => kept !== undefined && signatures.get(name) === kept);
          brokers.set(commodoreId, broker);
        }
        return broker;
      })();
      opening.set(key, work);
      void work.then(() => opening.delete(key), () => opening.delete(key));
    }
    return take(await work);
  };

  /** 붙기를 기다려 상태를 읽는다. 기다리는 이름이 있으면 그것만 본다. */
  const settled = async (broker: Broker, only?: string): Promise<States> => {
    const until = now() + SETTLE_MS;
    let states = new Map<string, ClaudeMcpServerState["status"]>();
    for (;;) {
      states = new Map((await broker.control.status()).filter(({ name }) => broker.names.has(name)).map(({ name, status }) => [name, status]));
      const waiting = only ? states.get(only) === "pending" || !states.has(only) : [...broker.names].some((name) => states.get(name) === "pending" || !states.has(name));
      if (!waiting || now() >= until || !broker.control.alive) return states;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  };

  const probe = (commodoreId: string, pluginIds: readonly string[], refresh: boolean): Promise<States> => {
    const { servers, signatures, signature } = plan(pluginIds);
    revalidate(commodoreId, signatures);
    if (!servers.length) return Promise.resolve(new Map());
    const hit = cache.get(commodoreId);
    const active = servers.some(({ name }) => flows.has(name));
    if (!refresh && !active && hit && hit.signature === signature && now() - hit.at < STATUS_FRESH_MS) return Promise.resolve(hit.states);
    const key = `${commodoreId}\0${signature}`;
    const inflight = probing.get(key);
    if (inflight) return inflight;
    const work = (async () => {
      const { broker } = await lease(commodoreId, pluginIds);
      try {
        const states = new Map(await settled(broker));
        // 실패로 보고된 OAuth 서버는 표준 신호로 다시 판정한다 — 로그인 요구면 「인증 필요」, 아니면 그 이유로 실패다.
        await Promise.all(servers.filter((server) => server.mode === "oauth" && states.get(server.name) === "failed").map(async (server) => {
          const judged = await signal(server.config).catch((): PluginAuthFailure => "error");
          if (judged === "needs-auth") { states.set(server.name, "needs-auth"); checks.delete(server.name); }
          else checks.set(server.name, judged);
        }));
        for (const server of servers) if (states.get(server.name) !== "failed") checks.delete(server.name);
        // 그사이 계획이 바뀌었으면 기억하지 않는다 — 옛 키의 결과가 새 키의 기억을 덮지 않게.
        if (wanted.get(commodoreId) === signature) cache.set(commodoreId, { at: now(), signature, states });
        return states;
      } finally { unlease(broker); }
    })();
    probing.set(key, work);
    return work.finally(() => { if (probing.get(key) === work) probing.delete(key); });
  };

  const failureOf = (name: string): PluginAuthFailure | undefined => {
    const found = failures.get(name);
    if (!found) return undefined;
    if (now() - found.at > FAILURE_MS) { failures.delete(name); return undefined; }
    return found.failure;
  };
  const fail = (name: string, failure: PluginAuthFailure) => failures.set(name, { failure, at: now() });
  const classify = (error: unknown): PluginAuthFailure => {
    if (error instanceof ClaudeMcpControlUnsupportedError) return "unsupported";
    const message = error instanceof Error ? error.message : String(error);
    if (/regist|client[_ ]?(?:id|metadata|information)|forbidden|\b403\b|invalid_client|unauthorized_client/i.test(message)) return "registration";
    if (/timed? ?out|timeout/i.test(message)) return "timeout";
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|unreachable/i.test(message)) return "unreachable";
    return "error";
  };

  const invalidate = () => cache.clear();
  /**
   * 토큰이 생기거나 지워진 서버를 붙인 다른 확인 자식은 낡았다(그 자식은 토큰 없을 때 붙었다) — 물려 다음 확인이 새 자식으로
   * 읽게 한다. 쥔 흐름은 그대로 둔다.
   */
  const staleEverywhere = (name: string, except?: Broker) => {
    for (const broker of [...live]) if (broker !== except && !broker.retired && broker.names.has(name)) retire(broker, () => true);
  };
  /** 흐름이 성공했다 — 그 자식을 접고(쥔 다른 흐름이 없으면), 토큰 없을 때 붙은 다른 자식도 물려 다음 확인이 새로 읽게 한다. */
  const completeFlow = (name: string, flow: Flow) => {
    failures.delete(name);
    endFlow(name, flow);
    staleEverywhere(name);
    options.changed([flow.pluginId]);
  };
  /** 브라우저에서 돌아오기를 기다린다 — 붙으면 성공이고, 상한을 넘거나 자식이 끝나면 실패다. */
  const watch = (name: string, flow: Flow) => {
    flow.timer = setTimeout(async () => {
      if (flows.get(name) !== flow) return;
      let status: ClaudeMcpServerState["status"] | undefined;
      try { status = (await flow.broker.control.status()).find((state) => state.name === name)?.status; } catch { status = undefined; }
      if (flows.get(name) !== flow) return;
      if (status === "connected") { completeFlow(name, flow); return; }
      if (!flow.broker.control.alive || now() >= flow.deadline) { endFlow(name, flow, flow.broker.control.alive ? "timeout" : "error"); return; }
      watch(name, flow);
    }, FLOW_POLL_MS);
    flow.timer.unref?.();
  };

  const find = (pluginIds: readonly string[], pluginId: string, server: string): PluginAuthServer => {
    if (!pluginIds.includes(pluginId)) throw new CommodoreStoreError("plugin_not_found");
    const found = options.servers([pluginId]).find((candidate) => candidate.server === server);
    if (!found) throw new CommodoreStoreError("plugin_not_found");
    return found;
  };

  const view = (pluginIds: readonly string[], states: ReadonlyMap<string, ClaudeMcpServerState["status"]>, checked: boolean): CommodorePluginAuthView => {
    const servers = options.servers(pluginIds);
    const plugins = pluginIds.flatMap((pluginId) => {
      const own = servers.filter((server) => server.pluginId === pluginId);
      if (!own.length) return [];
      return [{ pluginId, servers: own.map((server): PluginServerAuthView => {
        const status = states.get(server.name);
        if (server.mode === "key") {
          const key = { server: server.server, mode: "key" as const, keys: server.keys, ...(server.saved.length ? { saved: true as const } : {}) };
          // 선언이 키로 받지 않는 실행 환경 이름을 기다린다 — 채울 길이 없다.
          if (server.unsupported.length) return { ...key, state: "failed", failure: "unsupported" };
          if (server.missing.length) return { ...key, state: "key-needed" };
          // 키를 넣었는데 서버가 받지 않는다 — 키를 바꾸게 한다.
          if (status === "needs-auth" || status === "failed") return { ...key, state: "failed", failure: "key" };
          return { ...key, state: "key-set" };
        }
        const flow = flows.get(server.name);
        if (flow) return { server: server.server, mode: "oauth", state: "pending", authUrl: flow.authUrl, ...(flow.local ? { local: true } : {}) };
        const failure = status === "connected" ? undefined : failureOf(server.name);
        if (failure) return { server: server.server, mode: "oauth", state: "failed", failure };
        if (status === "needs-auth") return { server: server.server, mode: "oauth", state: "needs-auth" };
        if (status === "connected") return { server: server.server, mode: "oauth", state: "connected" };
        if (status === "failed") return { server: server.server, mode: "oauth", state: "failed", failure: checks.get(server.name) ?? "error" };
        return { server: server.server, mode: "oauth", state: "unknown" };
      }) }];
    });
    return { plugins, checked };
  };

  /** 고른 플러그인의 인증 상태. 확인 자식을 띄울 수 없으면 키 상태만 알고, OAuth 는 모르는 상태다. */
  const status = async (commodoreId: string, pluginIds: readonly string[], refresh = false): Promise<CommodorePluginAuthView> => {
    let states: ReadonlyMap<string, ClaudeMcpServerState["status"]> = new Map();
    let checked = true;
    try { states = await probe(commodoreId, pluginIds, refresh); }
    catch (error) { checked = false; if (!(error instanceof CommodoreStoreError)) console.warn(`[commodore] plugin auth status unavailable: ${error instanceof Error ? error.name : "error"}`); }
    return view(pluginIds, states, checked);
  };

  return {
    status,
    /** 인증을 시작한다. 사람이 열 주소가 있으면 돌려주고, 콜백과 완료 판정은 이 모듈이 맡는다. */
    async start(commodoreId: string, pluginIds: readonly string[], pluginId: string, server: string): Promise<{ readonly authUrl?: string; readonly view: CommodorePluginAuthView }> {
      const target = find(pluginIds, pluginId, server);
      if (target.mode !== "oauth") throw new CommodoreStoreError("invalid_request");
      revalidate(commodoreId, plan(pluginIds).signatures);
      const existing = flows.get(target.name);
      if (existing) return { authUrl: existing.authUrl, view: view(pluginIds, cache.get(commodoreId)?.states ?? new Map(), true) };
      failures.delete(target.name);
      const { broker } = await lease(commodoreId, pluginIds);
      let authUrl: string | undefined;
      try {
        const states = await settled(broker, target.name);
        if (states.get(target.name) !== "connected") {
          const started = await broker.control.authenticate(target.name);
          if (started.requiresUserAction && started.authUrl) {
            authUrl = started.authUrl;
            const flow: Flow = { broker, pluginId, authUrl, local: started.redirectScheme === "localhost", deadline: now() + FLOW_MS, timer: null };
            flows.set(target.name, flow);
            watch(target.name, flow);
          }
        }
      } catch (error) { fail(target.name, classify(error)); }
      finally { unlease(broker); }
      invalidate();
      const states = await probe(commodoreId, pluginIds, true).catch(() => new Map<string, ClaudeMcpServerState["status"]>());
      if (!authUrl && states.get(target.name) === "connected") options.changed([pluginId]);
      return { ...(authUrl ? { authUrl } : {}), view: view(pluginIds, states, true) };
    },
    /** 진행 중인 인증을 그만둔다. 콜백을 기다리던 자식을 접어 loopback 포트를 닫는다. */
    async cancel(commodoreId: string, pluginIds: readonly string[], pluginId: string, server: string): Promise<CommodorePluginAuthView> {
      const target = find(pluginIds, pluginId, server);
      const flow = flows.get(target.name);
      if (flow) endFlow(target.name, flow);
      failures.delete(target.name);
      invalidate();
      return await status(commodoreId, pluginIds, true);
    },
    /** 저장된 토큰을 지운다(Claude Code 보안 저장소). 그 서버를 쓰는 모든 세션이 다음 세션부터 다시 인증을 요구한다. */
    async clear(commodoreId: string, pluginIds: readonly string[], pluginId: string, server: string): Promise<CommodorePluginAuthView> {
      const target = find(pluginIds, pluginId, server);
      if (target.mode !== "oauth") throw new CommodoreStoreError("invalid_request");
      const { broker } = await lease(commodoreId, pluginIds);
      try {
        await broker.control.clearAuth(target.name);
        await broker.control.reconnect(target.name).catch(() => undefined);
      } catch (error) { throw new CommodoreStoreError(classify(error) === "unsupported" ? "auth_unsupported" : "auth_failed"); }
      finally { unlease(broker); }
      staleEverywhere(target.name, broker);
      failures.delete(target.name);
      invalidate();
      options.changed([pluginId]);
      return await status(commodoreId, pluginIds, true);
    },
    /** loopback 콜백이 닿지 않는 기기(원격 접속)에서 사람이 옮겨 온 콜백 주소를 진행 중인 흐름에 건넨다. */
    async callback(commodoreId: string, pluginIds: readonly string[], pluginId: string, server: string, callbackUrl: string): Promise<CommodorePluginAuthView> {
      const target = find(pluginIds, pluginId, server);
      const flow = flows.get(target.name);
      if (!flow) throw new CommodoreStoreError("invalid_request");
      let parsed: URL;
      try { parsed = new URL(callbackUrl); } catch { throw new CommodoreStoreError("invalid_request"); }
      if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !parsed.searchParams.has("state")) throw new CommodoreStoreError("invalid_request");
      try { await flow.broker.control.submitCallbackUrl(target.name, parsed.href); }
      catch { endFlow(target.name, flow, "callback"); return await status(commodoreId, pluginIds, true); }
      // 건넨 주소로 자식이 토큰을 바꿔 저장했다. 그 자식은 이 경로에서 토큰 없이 다시 붙는 일이 있어(CLI 2.1.312 실측) 완료로
      // 치고 접는다 — 새 자식이 저장된 토큰으로 읽는다. 그래도 붙지 않으면 그 주소가 받아들여지지 않은 것이다.
      completeFlow(target.name, flow);
      const connected = (next: CommodorePluginAuthView) => next.plugins.find((plugin) => plugin.pluginId === pluginId)?.servers.find((row) => row.server === server)?.state === "connected";
      let next = await status(commodoreId, pluginIds, true);
      if (!connected(next)) {
        await new Promise((resolve) => setTimeout(resolve, CALLBACK_SETTLE_MS));
        next = await status(commodoreId, pluginIds, true);
      }
      if (!connected(next) && next.checked) { fail(target.name, "callback"); next = await status(commodoreId, pluginIds); }
      return next;
    },
    /** 키가 바뀌었다 — 확인한 상태를 버린다. */
    invalidate,
    async dispose() {
      disposed = true;
      for (const flow of flows.values()) if (flow.timer) clearTimeout(flow.timer);
      flows.clear();
      for (const broker of [...live]) close(broker);
      await Promise.allSettled([...opening.values()]);
      for (const broker of [...live]) close(broker);
    },
  };
}
export type CommodorePluginAuth = ReturnType<typeof createCommodorePluginAuth>;
