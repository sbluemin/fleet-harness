import { DESKTOP_HOST_FRAME_MAX_CHARS, DESKTOP_HOST_RELAY_ID_HEADER, DESKTOP_HOST_TRANSPORT_EVENT, DESKTOP_HOST_TRANSPORT_EVENTS_PATH, DESKTOP_HOST_TRANSPORT_PATH, DESKTOP_HOST_TRANSPORT_RELAY_PATH, DESKTOP_HOST_UPLOAD_CHUNK_CHARS, DESKTOP_HOST_UPLOAD_SLOTS, isDesktopHostSnapshot, type DesktopHostCommand, type DesktopHostRelay } from "@fleet-console/protocol/desktop";
import { ACCESS_PAIR_PATH, normalizeFingerprint } from "@fleet-console/protocol/remote";
import { HOST_RESOURCE_MAX_BYTES, HOST_UPLOAD_MAX_BYTES } from "@fleet-console/protocol/remote/host-transport";

import type { CookieOrder } from "./cookie-order.js";
import { createDesktopEventStream } from "./desktop-event-stream.js";
import { openPinnedWebSocket, type PinnedSocket } from "./host-socket.js";

export interface HostPartitionCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  /** 초 단위 epoch. 없으면 session 쿠키다 — 서버가 만료를 준 쿠키에서 이 값을 버리면 영속 쿠키가 session 쿠키가 된다. */
  readonly expirationDate?: number;
  readonly sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface HostPartition {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  readCookies(url: string): Promise<readonly HostPartitionCookie[]>;
  writeCookie(cookie: HostPartitionCookie & { readonly url: string }): Promise<void>;
  /** 그 origin의 쿠키 이름 하나만 지운다. 파티션 전체를 비우지 않는다. */
  removeCookie?(url: string, name: string): Promise<void>;
  pin(hostname: string, fingerprint: string): void;
  /**
   * 이 호스트 전용 파티션의 신뢰 대상을 버린다: 인증서 핀과 쿠키·세션 저장소까지. 핀만 지우면 같은 Session의 옛 자격이
   * 새 신뢰 대상에 그대로 전송된다. 끝난 뒤에 돌아와야 하므로 비동기일 수 있다.
   */
  clear(): void | Promise<void>;
}

/**
 * 읽어 온 Electron Cookie를 그대로 `set`에 되넘기지 않는다. 객체에는 `domain`·`hostOnly`가 있어, 그대로 되넘기면 호스트 한정
 * 쿠키가 하위 도메인에도 유효한 domain 쿠키로 승격된다. 원격 Console이 발행하는 쿠키는 호스트 한정이 계약이므로, 허용한 속성만
 * 명시해 옮긴다. 만료와 SameSite는 서버가 정한 값이라 그대로 보존한다.
 */
function cookieDetails(cookie: HostPartitionCookie, url: string): HostPartitionCookie & { readonly url: string } {
  return {
    name: cookie.name,
    value: cookie.value,
    url,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? true,
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
  };
}

interface ParsedSetCookie {
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "no_restriction" | "lax" | "strict";
  /** 서버가 준 Max-Age(우선) 또는 Expires에서만 도출한다. 둘 다 없으면 session 쿠키다. 자체 TTL은 더하지 않는다. */
  readonly expirationDate?: number;
  /** Max-Age ≤ 0 이거나 이미 지난 Expires — 서버가 이 쿠키를 지우라고 한 것이다. */
  readonly expired: boolean;
}

/** 원격 Console이 발행하는 형식(Max-Age·SameSite·Path·Secure·HttpOnly)과 Expires까지 읽는다. 그 밖의 속성은 무시한다. */
function parseSetCookie(line: string, nowSeconds: number): ParsedSetCookie {
  const [first = "", ...attributes] = line.split(";").map((part) => part.trim());
  const equals = first.indexOf("=");
  let maxAge: number | undefined;
  let expires: number | undefined;
  let sameSite: ParsedSetCookie["sameSite"];
  let secure = false;
  let httpOnly = false;
  let path = "/";
  for (const attribute of attributes) {
    const split = attribute.indexOf("=");
    const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const raw = split < 0 ? "" : attribute.slice(split + 1).trim();
    if (key === "max-age" && /^-?\d+$/u.test(raw)) maxAge = Number(raw);
    else if (key === "expires") { const time = Date.parse(raw); if (Number.isFinite(time)) expires = Math.floor(time / 1000); }
    else if (key === "samesite") { const lowered = raw.toLowerCase(); sameSite = lowered === "strict" ? "strict" : lowered === "lax" ? "lax" : lowered === "none" ? "no_restriction" : undefined; }
    else if (key === "secure") secure = true;
    else if (key === "httponly") httpOnly = true;
    else if (key === "path" && raw.startsWith("/")) path = raw;
  }
  let expirationDate: number | undefined;
  let expired = false;
  if (maxAge !== undefined) {
    if (maxAge <= 0) expired = true;
    else expirationDate = nowSeconds + maxAge;
  } else if (expires !== undefined) {
    if (expires <= nowSeconds) expired = true;
    else expirationDate = expires;
  }
  return {
    value: equals < 0 ? "" : first.slice(equals + 1),
    path, secure, httpOnly, expired,
    ...(sameSite !== undefined ? { sameSite } : {}),
    ...(expirationDate !== undefined ? { expirationDate } : {}),
  };
}

export interface HostTransportExecutorDeps {
  readonly confirmIdentity: (hostname: string, port: number, fingerprint: string) => Promise<void>;
  readonly openPartition: (hostKey: string) => HostPartition;
  readonly readWindowCookies: (url: string) => Promise<readonly HostPartitionCookie[]>;
  readonly writeWindowCookie: (cookie: HostPartitionCookie & { readonly url: string }) => Promise<void>;
  readonly removeWindowCookie?: (url: string, name: string) => Promise<void>;
  /** 없으면 pair를 구현하지 않는 셸이다. join으로 대체하지 않고 unsupported를 돌려준다. */
  readonly localOrigin?: () => string | null;
  readonly localFetch?: typeof fetch;
  readonly deviceName?: string | null;
  readonly openSocket?: typeof openPinnedWebSocket;
  /** main이 하나만 만들어 legacy join과 나눠 쓴다. 따로 만들면 직렬화가 갈라지므로 기본값을 두지 않는다. */
  readonly cookieOrder: CookieOrder;
}

const SESSION_RESPONSE = "/api/v1/sessions";
const TICKET_PATH = "/api/v1/agent/ticket";
const TERMINAL_SOCKET_PATH = "/api/v1/terminal/ws";
const FRAME_CHARS = 32 * 1024;
const RELAY_ATTEMPTS = 3;
/** 대상 교체 때 옛 origin의 쿠키 순서를 기다리는 시간. 순서 밖 명령(일반 HTTP·스트림)만 기다린다. */
const REPLACE_ORDER_WAIT_MS = 8_000;
const RELAY_BACKOFF_MS = [200, 400];

interface HostJob {
  readonly hostKey: string;
  readonly epoch: number;
  abort(): void;
  send?(payload: { readonly text?: string; readonly dataBase64?: string }): void;
}

export function createHostTransportExecutor(deps: HostTransportExecutorDeps): {
  execute(command: DesktopHostCommand, signal?: AbortSignal): Promise<DesktopHostRelay>;
  run(command: DesktopHostCommand, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void>;
  releaseConsole(): void;
} {
  const partitions = new Map<string, { readonly origin: string; readonly fingerprint: string; readonly partition: HostPartition }>();
  const epochs = new Map<string, number>();
  const jobs = new Map<number, HostJob>();
  const uploads = new Map<number, UploadAssembly>();
  // origin+port 하나의 쿠키 변경만 직렬화한다. 명령은 시작 순서로 번호를 받고, 그 번호보다 늦은 확정 뒤에는 쓰지 않는다.
  const pairingTurns = new Map<string, Promise<void>>();
  // 번호는 명령 객체에 묶인 lease가 들고, 가장 바깥 호출이 끝나면 함께 사라진다. 완료된 명령의 id를 맵에 남기지 않는다.
  const leases = new WeakMap<DesktopHostCommand, { readonly claim: number; pins: number }>();
  const committedClaims = new Map<string, number>();
  let nextClaim = 1;
  // 콘솔 수명이 바뀌면 이 값 아래의 번호는 죽은 수명의 것이다. 카운터를 되감지 않으므로 새 명령이 옛 번호와 겹치지 않는다.
  let claimFloor = 1;
  // 쿠키를 싣는 요청(pair, observe·activate)은 main이 주입한 순서(cookieOrder)를 지난다. legacy join과 같은 순서를 공유한다.
  // 이 순서는 releaseConsole로 비우지 않는다. 취소 요청과 실제 fetch 종료는 다르므로, 옛 수명의 fetch가 settle된 뒤에야 풀린다.
  const order = deps.cookieOrder;
  /**
   * 호스트별로 가장 늦게 시작해 지문 확인을 통과한 대상(시작 번호·origin·지문). 늦게 돌아온 옛 확인이 새로 확정된 대상의 쿠키·핀·파티션을
   * 되돌리지 못하게 하는 호스트 수명의 작은 상태다. 쿠키 확정 번호(committedClaims)는 쿠키를 쓴 뒤에야 오르므로 이 경합을 대신하지 못한다.
   * hostKey당 하나라 호스트 수만큼만 자라며 releaseConsole이 비운다. 자격이나 URL은 담지 않는다.
   */
  const confirmedTargets = new Map<string, { claim: number; origin: string; fingerprint: string }>();
  // 새 콘솔 프로세스는 같은 출처라도 명령 번호와 epoch를 1부터 다시 쓴다. 이 실행기가 앞 세션의 값을 남기면 새 명령이 걸리거나 stale_epoch가 된다.
  const releaseConsole = (): void => {
    epochs.clear();
    uploads.clear();
    committedClaims.clear();
    confirmedTargets.clear();
    claimFloor = nextClaim;
    for (const [id, job] of jobs) {
      jobs.delete(id);
      job.abort();
    }
  };

  const admitEpoch = (command: DesktopHostCommand): boolean => {
    const current = epochs.get(command.hostKey);
    if (current !== undefined && command.epoch < current) return false;
    if (current !== undefined && command.epoch > current) {
      for (const [id, job] of jobs) if (job.hostKey === command.hostKey && job.epoch < command.epoch) { jobs.delete(id); job.abort(); }
    }
    epochs.set(command.hostKey, command.epoch);
    return true;
  };

  const originOf = (command: DesktopHostCommand): string => {
    const host = command.target.hostname.includes(":") ? `[${command.target.hostname}]` : command.target.hostname;
    return new URL(`https://${host}:${command.target.port}`).origin;
  };

  const isLaneCommand = (command: DesktopHostCommand): boolean => command.op === "pair"
    || (command.op === "presence" && (command.params.intent === "observe" || command.params.intent === "activate"));

  const portOfOrigin = (origin: string): number => {
    const parsed = new URL(origin);
    return parsed.port === "" ? 443 : Number(parsed.port);
  };

  /**
   * 같은 hostKey가 다른 지문(또는 origin)을 가리키게 되면 옛 신뢰 대상의 자격을 버린다: 이 호스트 전용 파티션의 핀·쿠키·세션 저장소와
   * 옛 origin+포트의 창 jar 페어링·세션 쿠키만. 다른 host·포트의 쿠키는 건드리지 않는다.
   *
   * 옛 origin의 순서를 쥔 채로 한다 — 그 origin에서 진행 중인 쿠키 요청이 끝난 뒤에야 비우므로 늦은 응답이 지운 자격을 되살리지 못한다.
   * 순서 보유자는 새 origin의 순서를 이미 쥐고 있다. 다른 origin이면 기다리지 않고(tryHold) 얻어 두 순서를 겹쳐 기다리지 않는다.
   * 순서 밖 명령은 아무것도 쥐지 않았으므로 제한 시간과 취소 신호 안에서 기다린다. 얻지 못하면 false이고 파티션 기록을 남겨 다음에 다시 시도한다.
   */
  const replaceTarget = async (
    command: DesktopHostCommand,
    existing: { readonly origin: string; readonly fingerprint: string; readonly partition: HostPartition },
    origin: string,
    fingerprint: string,
    signal: AbortSignal | undefined,
    laneOwner: boolean,
  ): Promise<boolean> => {
    const oldOrigin = existing.origin;
    const oldPort = portOfOrigin(oldOrigin);
    let release: (() => void) | null;
    if (laneOwner && oldOrigin === origin) release = () => undefined;
    else if (laneOwner) release = order.tryHold(oldOrigin);
    else {
      const wait = AbortSignal.timeout(REPLACE_ORDER_WAIT_MS);
      release = await order.hold(oldOrigin, signal ? AbortSignal.any([signal, wait]) : wait);
    }
    if (release === null) return false;
    try {
      // 순서를 기다리는 사이 이 명령이 취소됐거나 더 늦게 시작한 명령이 다른 대상을 확정했을 수 있다. 파괴는 그 뒤 현재성을 다시 보고 한다.
      if (!targetCurrent(command, origin, fingerprint, signal)) return false;
      let cleared = false;
      await withPairing(oldOrigin, oldPort, async () => {
        // 줄 서 있던 다른 쿠키 작업을 기다리는 동안에도 같은 일이 생길 수 있다.
        if (!targetCurrent(command, origin, fingerprint, signal)) return;
        await existing.partition.clear();
        for (const kind of ["pairing", "session"] as const) await deps.removeWindowCookie?.(oldOrigin, cookieName(kind, oldPort));
        cleared = true;
      });
      if (!cleared || !targetCurrent(command, origin, fingerprint, signal)) return false;
      partitions.delete(command.hostKey);
      return true;
    } finally {
      release();
    }
  };

  /** 이 명령의 대상이 아직 호스트의 현재 대상인가. 취소됐거나, 죽은 콘솔 수명이거나, 더 늦게 시작한 명령이 다른 대상을 확정했으면 아니다. */
  const targetCurrent = (command: DesktopHostCommand, origin: string, fingerprint: string, signal: AbortSignal | undefined): boolean => {
    if (signal?.aborted) return false;
    const claim = claimFor(command);
    if (claim < claimFloor) return false;
    const known = confirmedTargets.get(command.hostKey);
    return known === undefined || (known.origin === origin && known.fingerprint === fingerprint) || known.claim <= claim;
  };

  /** 현재가 아니면 보낼 응답. 취소·옛 수명은 도달 실패, 더 새 대상이 확정된 경우는 stale이다. */
  const notCurrent = (command: DesktopHostCommand, origin: string, fingerprint: string, signal: AbortSignal | undefined): DesktopHostRelay | null => {
    if (targetCurrent(command, origin, fingerprint, signal)) return null;
    if (signal?.aborted || claimFor(command) < claimFloor) return { id: command.id, error: "remote_host_unavailable", end: true };
    return { id: command.id, error: "stale_epoch" };
  };

  const partitionFor = async (command: DesktopHostCommand, signal?: AbortSignal, laneOwner = false): Promise<{ origin: string; partition: HostPartition } | DesktopHostRelay> => {
    try {
      await deps.confirmIdentity(command.target.hostname, command.target.port, command.target.fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { id: command.id, error: message === "remote_link_fingerprint_mismatch" ? "remote_host_fingerprint_mismatch" : "remote_host_unreachable" };
    }
    const host = command.target.hostname.includes(":") ? `[${command.target.hostname}]` : command.target.hostname;
    const origin = new URL(`https://${host}:${command.target.port}`).origin;
    const fingerprint = normalizeFingerprint(command.target.fingerprint);
    // 확인을 기다리는 사이 취소됐거나 더 늦게 시작한 명령이 같은 호스트의 다른 대상을 이미 확정했을 수 있다. 그 경우 파괴적 동작·핀·파티션
    // 기록을 전혀 하지 않는다. 현재면 이 대상을 확정 대상으로 올린다(더 늦은 시작 번호만 덮어쓴다).
    const gone = notCurrent(command, origin, fingerprint, signal);
    if (gone) return gone;
    const known = confirmedTargets.get(command.hostKey);
    const claim = claimFor(command);
    if (!known || claim >= known.claim) confirmedTargets.set(command.hostKey, { claim, origin, fingerprint });
    const existing = partitions.get(command.hostKey);
    // 새로 등록된 지문의 확인이 위에서 끝난 뒤에만 도달한다(불일치는 위에서 종료되어 쿠키를 건드리지 않는다). 대상 교체이므로
    // 옛 대상의 자격이 새 대상에 전송되지 않게 먼저 폐기하고, 폐기하지 못하면 아무것도 보내지 않는다.
    if (existing && (existing.origin !== origin || existing.fingerprint !== fingerprint)) {
      if (!await replaceTarget(command, existing, origin, fingerprint, signal, laneOwner)) return notCurrent(command, origin, fingerprint, signal) ?? { id: command.id, error: "remote_host_unavailable", end: true };
    }
    // 교체를 기다리는 동안에도 같은 일이 생길 수 있다. 핀과 파티션 기록은 옛 지문으로 되돌려선 안 된다.
    const late = notCurrent(command, origin, fingerprint, signal);
    if (late) return late;
    const partition = partitions.get(command.hostKey)?.partition ?? deps.openPartition(command.hostKey);
    partition.pin(command.target.hostname, fingerprint);
    partitions.set(command.hostKey, { origin, fingerprint, partition });
    await copyPairingCookie(command, origin, partition, signal, laneOwner);
    return { origin, partition };
  };

  const withPairing = <T,>(origin: string, port: number, work: () => Promise<T>): Promise<T> => {
    const key = `${origin}\n${port}`;
    const previous = pairingTurns.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    pairingTurns.set(key, run.then(() => undefined, () => undefined));
    return run;
  };

  const claimKey = (origin: string, port: number): string => `${origin}\n${port}`;

  /** 시작 순서. 응답이 먼저 도착해도 나중에 시작한 명령이 더 큰 번호를 가진다. */
  const enter = (command: DesktopHostCommand): (() => void) => {
    let lease = leases.get(command);
    if (!lease) {
      lease = { claim: nextClaim, pins: 0 };
      nextClaim += 1;
      leases.set(command, lease);
    }
    const held = lease;
    held.pins += 1;
    return () => {
      held.pins -= 1;
      if (held.pins === 0 && leases.get(command) === held) leases.delete(command);
    };
  };

  /** 들어온 적 없는 명령은 0이다. 어떤 floor보다 낮으므로 쿠키를 건드리지 못한다. */
  const claimFor = (command: DesktopHostCommand): number => leases.get(command)?.claim ?? 0;

  const claimLive = (origin: string, port: number, claim: number, signal?: AbortSignal): boolean => {
    if (signal?.aborted) return false;
    if (claim < claimFloor) return false;
    return claim >= (committedClaims.get(claimKey(origin, port)) ?? 0);
  };

  const publishClaim = (origin: string, port: number, claim: number): void => {
    if (claim < claimFloor) return;
    const key = claimKey(origin, port);
    const current = committedClaims.get(key) ?? 0;
    if (claim > current) committedClaims.set(key, claim);
  };

  const cookieName = (kind: "pairing" | "session", port: number): string => `fleet_console_${kind}_${port}`;

  const cookieValue = (cookies: readonly HostPartitionCookie[], name: string): string | null => {
    const found = cookies.find((cookie) => cookie.name === name && cookie.value.length > 0);
    return found?.value ?? null;
  };

  const readPartitionCookies = async (partition: HostPartition, origin: string, port: number): Promise<{ pairing: string | null; session: string | null }> => ({
    pairing: cookieValue(await partition.readCookies(origin), cookieName("pairing", port)),
    session: cookieValue(await partition.readCookies(origin), cookieName("session", port)),
  });

  const readWindowCookies = async (origin: string, port: number): Promise<{ pairing: string | null; session: string | null }> => ({
    pairing: cookieValue(await deps.readWindowCookies(origin), cookieName("pairing", port)),
    session: cookieValue(await deps.readWindowCookies(origin), cookieName("session", port)),
  });

  const copyPairingCookie = async (command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal, laneOwner = false): Promise<void> => {
    const port = command.target.port;
    const claim = claimFor(command);
    // 순서 보유자는 이미 권한이 있다. 순서 밖 명령은 지금 얻을 수 있을 때만 권한을 쥐고 읽기부터 쓰기 settle까지 한다.
    // 바쁘면(join이든 inline 보유자든) 건너뛴다: 쿠키를 쥔 쪽의 jar가 더 새롭다. 잠금 순서는 항상 order → withPairing이다.
    const release = laneOwner ? (): void => undefined : order.tryHold(origin);
    if (release === null) return;
    try {
      await withPairing(origin, port, async () => {
        if (!claimLive(origin, port, claim, signal)) return;
        const name = cookieName("pairing", port);
        const pairing = (await deps.readWindowCookies(origin)).find((cookie) => cookie.name === name && cookie.value.length > 0);
        if (!pairing || !claimLive(origin, port, claim, signal)) return;
        await partition.writeCookie(cookieDetails(pairing, origin));
      });
    } finally {
      release();
    }
  };

  /**
   * 응답이 실제로 페어링 쿠키를 갱신한 경로(pair, observe·activate)의 보유자만 부른다. 원격이 Set-Cookie를 발행하는 곳이
   * 그 응답들뿐이라 일반 HTTP·bytes·release 뒤에는 갱신할 것이 없다 — 거기서 파티션 값을 창에 다시 복사하면, 사이에 join이
   * 창 jar를 새 값으로 바꿨을 때 옛 값으로 되돌리게 된다. 보유자는 순서권을 이미 쥐고 있다.
   */
  const rememberPairing = async (command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal): Promise<void> => {
    const port = command.target.port;
    const claim = claimFor(command);
    await withPairing(origin, port, async () => {
      if (!claimLive(origin, port, claim, signal)) return;
      const name = cookieName("pairing", port);
      const renewed = (await partition.readCookies(origin)).find((cookie) => cookie.name === name && cookie.value.length > 0);
      if (!renewed || !claimLive(origin, port, claim, signal)) return;
      await deps.writeWindowCookie({ ...cookieDetails(renewed, origin), path: "/", secure: true, httpOnly: true });
      publishClaim(origin, port, claim);
    });
  };

  /**
   * 이 명령이 보냈던 값과 아직 같은 쿠키만 지운다. 그 사이 같은 origin·포트에 기록된 새 값은 남긴다.
   * 취소된 명령의 응답은 어느 값도 지우지 않는다.
   */
  const readPresentedCookies = async (partition: HostPartition, origin: string, port: number): Promise<{
    readonly partition: { readonly pairing: string | null; readonly session: string | null };
    readonly window: { readonly pairing: string | null; readonly session: string | null };
  }> => ({
    partition: await readPartitionCookies(partition, origin, port),
    window: await readWindowCookies(origin, port),
  });

  const forgetPresentedCookies = async (
    command: DesktopHostCommand,
    origin: string,
    port: number,
    partition: HostPartition,
    presented: Awaited<ReturnType<typeof readPresentedCookies>>,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const claim = claimFor(command);
    await withPairing(origin, port, async () => {
      if (!claimLive(origin, port, claim, signal)) return;
      const current = await readPresentedCookies(partition, origin, port);
      if (!claimLive(origin, port, claim, signal)) return;
      for (const kind of ["pairing", "session"] as const) {
        const name = cookieName(kind, port);
        if (!claimLive(origin, port, claim, signal)) return;
        if (presented.partition[kind] && current.partition[kind] === presented.partition[kind]) await partition.removeCookie?.(origin, name);
        if (!claimLive(origin, port, claim, signal)) return;
        if (presented.window[kind] && current.window[kind] === presented.window[kind]) await deps.removeWindowCookie?.(origin, name);
      }
    });
  };

  const executeLeased = async (command: DesktopHostCommand, signal?: AbortSignal): Promise<DesktopHostRelay> => {
    // abort는 epoch 거절보다 먼저다. 늦게 도착한 취소가 stale로 버려지면 원격 전송이 끝까지 남는다.
    if (command.op === "abort") {
      const uploadId = command.params.uploadId;
      if (typeof uploadId === "number") uploads.delete(uploadId);
      const target = command.params.commandId;
      if (typeof target === "number") { const job = jobs.get(target); jobs.delete(target); job?.abort(); }
      return { id: command.id, end: true };
    }
    if (signal?.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (!admitEpoch(command)) return { id: command.id, error: "stale_epoch" };
    if (command.op === "pair" && Object.keys(command.params).length > 0) return { id: command.id, error: "route_denied" };
    if (command.op === "pair" && (!deps.localOrigin || !deps.localFetch)) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    if (command.op === "ws-send" || command.op === "ws-close") return forwardSocket(command);
    let staged: Buffer | undefined;
    if (command.op === "http" && command.params.upload !== undefined) {
      const outcome = acceptUploadChunk(command);
      if (outcome.kind !== "body") return outcome.relay;
      staged = outcome.body;
    }
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
    jobs.set(command.id, { hostKey: command.hostKey, epoch: command.epoch, abort: stop });
    let releaseCookieLane: (() => void) | null = null;
    try {
      if (isLaneCommand(command)) {
        const claim = claimFor(command);
        releaseCookieLane = await order.hold(originOf(command), controller.signal, () => claim >= claimFloor);
        if (releaseCookieLane === null) return { id: command.id, error: "remote_host_unavailable", end: true };
      }
      const opened = await partitionFor(command, controller.signal, releaseCookieLane !== null);
      if (controller.signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
      if (!("partition" in opened)) return opened;
      if (command.op === "presence") return await performPresence(command, opened.origin, opened.partition, controller.signal);
      if (command.op === "pair") return await performPair(command, opened.origin, opened.partition, controller.signal);
      if (command.op === "http" || command.op === "bytes") return await performHttp(command, opened.origin, opened.partition, controller.signal, staged);
      return { id: command.id, error: "remote_host_unavailable" };
    } finally {
      releaseCookieLane?.();
      if (jobs.get(command.id)?.abort === stop) jobs.delete(command.id);
      signal?.removeEventListener("abort", stop);
    }
  };

  const execute = async (command: DesktopHostCommand, signal?: AbortSignal): Promise<DesktopHostRelay> => {
    const leave = enter(command);
    try {
      return await executeLeased(command, signal);
    } finally {
      leave();
    }
  };

  const runLeased = async (command: DesktopHostCommand, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) { await emit({ id: command.id, error: "remote_host_unavailable", end: true }); return; }
    if (!admitEpoch(command)) { await emit({ id: command.id, error: "stale_epoch", end: true }); return; }
    const opened = await partitionFor(command, signal);
    if (!("partition" in opened)) { await emit(opened); return; }
    if (command.op === "sse") { await streamEvents(command, opened.origin, opened.partition, emit, signal); return; }
    if (command.op === "ws-open") { await streamSocket(command, opened.origin, opened.partition, emit, signal); return; }
    await emit(await execute(command, signal));
  };

  const run = async (command: DesktopHostCommand, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> => {
    const leave = enter(command);
    try {
      await runLeased(command, emit, signal);
    } finally {
      leave();
    }
  };

  return { execute, run, releaseConsole };

  function forwardSocket(command: DesktopHostCommand): DesktopHostRelay {
    const socketId = command.params.socketId;
    const job = typeof socketId === "number" ? jobs.get(socketId) : undefined;
    if (!job || job.epoch !== command.epoch || job.hostKey !== command.hostKey) return { id: command.id, error: "remote_host_unavailable" };
    if (command.op === "ws-close") { jobs.delete(socketId as number); job.abort(); return { id: command.id, end: true }; }
    const text = typeof command.params.text === "string" ? command.params.text : undefined;
    const dataBase64 = typeof command.params.dataBase64 === "string" ? command.params.dataBase64 : undefined;
    if ((text?.length ?? 0) > FRAME_CHARS * 4 || (dataBase64?.length ?? 0) > FRAME_CHARS * 8) return { id: command.id, error: "remote_host_unavailable" };
    job.send?.({ ...(text !== undefined ? { text } : {}), ...(dataBase64 !== undefined ? { dataBase64 } : {}) });
    return { id: command.id, end: true };
  }

  async function performPresence(command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal): Promise<DesktopHostRelay> {
    const intent = command.params.intent;
    if (intent !== "observe" && intent !== "activate" && intent !== "release") return { id: command.id, error: "invalid_host_request" };
    const presented = await withPairing(origin, command.target.port, () => readPresentedCookies(partition, origin, command.target.port));
    let response: Response;
    try {
      response = await partition.fetch(`${origin}${SESSION_RESPONSE}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ intent }), signal,
      });
    } catch {
      return { id: command.id, error: "remote_host_unavailable" };
    }
    // release의 401은 세션만 끝난 것이다. observe·activate의 401은 그때 보낸 쿠키 값만 걷는다.
    if (response.status === 401 && (intent === "observe" || intent === "activate") && (presented.partition.pairing || presented.window.pairing)) {
      await forgetPresentedCookies(command, origin, command.target.port, partition, presented, signal);
      return { id: command.id, error: "remote_host_not_paired" };
    }
    // release의 응답은 쿠키를 갱신하지 않는다. observe·activate만 보유자 안에서 갱신을 확정한다.
    if (intent !== "release" && claimLive(origin, command.target.port, claimFor(command), signal)) await rememberPairing(command, origin, partition, signal);
    if (response.status === 404 || response.status === 405) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401) return { id: command.id, error: "remote_host_not_paired" };
    if (response.status === 403) return { id: command.id, error: "observer_only" };
    if (!response.ok || !isSessionCapability(body)) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    return { id: command.id, capability: "supported", mode: body.mode, access: body.access };
  }

  async function performPair(command: DesktopHostCommand, origin: string, partition: HostPartition, signal: AbortSignal): Promise<DesktopHostRelay> {
    const port = command.target.port;
    if (signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    const presented = await withPairing(origin, port, () => readPresentedCookies(partition, origin, port));
    // 쿠키가 있어도 능력 표식 없는 401은 옛 서버다. 그 응답만으로 자격을 보내거나 쿠키를 지우지 않는다.
    const probe = await postPair(origin, partition, "{}", signal);
    if (!probe || signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (probe.status === 204) {
      if (!claimLive(origin, port, claimFor(command), signal) || responseSetsSession(probe, port)) return { id: command.id, error: "remote_host_unavailable" };
      const still = await withPairing(origin, port, () => readPartitionCookies(partition, origin, port));
      if (!still.pairing || !claimLive(origin, port, claimFor(command), signal)) return { id: command.id, error: "remote_host_unavailable" };
      await rememberPairing(command, origin, partition, signal);
      return { id: command.id, capability: "supported", mode: "off", access: null };
    }
    const marker = await readPairMarker(probe);
    if (!claimLive(origin, port, claimFor(command), signal)) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (marker === "revoked") {
      await forgetPresentedCookies(command, origin, port, partition, presented, signal);
    } else if (marker !== "probe") {
      if (probe.status === 404 || probe.status === 405 || probe.status === 401) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
      return { id: command.id, error: "remote_host_unavailable" };
    }
    if (signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    const handoff = await takeHandoff(origin, signal);
    if (handoff.kind !== "ready") return { id: command.id, error: handoff.error, ...(handoff.error === "remote_host_unavailable" ? { end: true as const } : {}) };
    if (handoff.token === null) return { id: command.id, error: "remote_link_required" };
    if (!samePairTarget(handoff, command, origin)) return { id: command.id, error: "stale_epoch" };
    if (signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    const device = sanitizeDeviceName(deps.deviceName);
    const submitted = await postPair(origin, partition, JSON.stringify(device === null ? { token: handoff.token } : { token: handoff.token, device }), signal);
    // handoff는 이미 소진됐다. 다시 꺼낼 수 없으므로 재시도가 아니라 링크를 다시 넣어야 한다.
    if (!submitted) return { id: command.id, error: "remote_link_required" };
    if (!claimLive(origin, port, claimFor(command), signal)) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (submitted.status === 401) return { id: command.id, error: "remote_link_required" };
    if (submitted.status === 409) {
      let code = "remote_host_unavailable";
      try {
        const body = await submitted.json() as { readonly error?: unknown };
        if (body.error === "paired_device_limit") code = "paired_device_limit";
      } catch { /* 본문을 읽지 못하면 성공으로 보지 않는다. */ }
      return { id: command.id, error: code };
    }
    if (submitted.status === 404 || submitted.status === 405) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    if (submitted.status !== 204) return { id: command.id, error: "remote_host_unavailable" };
    if (!claimLive(origin, port, claimFor(command), signal)) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (await storePairingCookie(submitted, command, origin, partition, signal) !== "paired") return { id: command.id, error: "remote_host_unavailable" };
    if (!claimLive(origin, port, claimFor(command), signal)) return { id: command.id, error: "remote_host_unavailable", end: true };
    await rememberPairing(command, origin, partition, signal);
    return { id: command.id, capability: "supported", mode: "off", access: null };
  }

  function responseSetsSession(response: Response, port: number): boolean {
    const name = cookieName("session", port);
    const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    return lines.some((line) => line.startsWith(`${name}=`) && !line.startsWith(`${name}=;`));
  }

  async function postPair(origin: string, partition: HostPartition, body: string, signal: AbortSignal): Promise<Response | null> {
    try {
      return await partition.fetch(`${origin}${ACCESS_PAIR_PATH}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", Origin: origin }, body, signal,
      });
    } catch {
      return null;
    }
  }

  async function readPairMarker(response: Response): Promise<"probe" | "revoked" | "absent"> {
    try {
      const body = await response.json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body) || body.capability !== "pair" || Object.keys(body).length !== 2) return "absent";
      if (response.status === 400 && body.error === "invalid_join") return "probe";
      if (response.status === 401 && body.error === "unauthorized") return "revoked";
      return "absent";
    } catch {
      return "absent";
    }
  }

  async function takeHandoff(origin: string, signal: AbortSignal): Promise<{ kind: "ready"; token: string | null; origin: string; hostname: string; port: number; fingerprint: string } | { kind: "error"; error: "remote_host_unknown" | "remote_host_unavailable" }> {
    const home = deps.localOrigin?.() ?? null;
    if (!home || !deps.localFetch || signal.aborted) return { kind: "error", error: "remote_host_unavailable" };
    let response: Response;
    try {
      response = await deps.localFetch(`${home}/api/v1/desktop/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: home },
        body: JSON.stringify({ origin }),
        signal,
      });
    } catch {
      return { kind: "error", error: "remote_host_unavailable" };
    }
    if (response.status === 404) return { kind: "error", error: "remote_host_unknown" };
    if (!response.ok) return { kind: "error", error: "remote_host_unavailable" };
    let body: Record<string, unknown> | null = null;
    try { body = await response.json() as Record<string, unknown>; } catch { body = null; }
    if (!body || (body.token !== null && typeof body.token !== "string")) return { kind: "error", error: "remote_host_unavailable" };
    return {
      kind: "ready",
      token: typeof body.token === "string" ? body.token : null,
      origin: typeof body.origin === "string" ? body.origin : "",
      hostname: typeof body.hostname === "string" ? body.hostname : "",
      port: typeof body.port === "number" ? body.port : 0,
      fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "",
    };
  }

  function samePairTarget(handoff: { readonly origin: string; readonly hostname: string; readonly port: number; readonly fingerprint: string }, command: DesktopHostCommand, origin: string): boolean {
    return handoff.origin === origin
      && handoff.hostname === command.target.hostname
      && handoff.port === command.target.port
      && normalizeFingerprint(handoff.fingerprint) === normalizeFingerprint(command.target.fingerprint);
  }

  async function storePairingCookie(response: Response, command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal): Promise<"paired" | "rejected"> {
    const port = command.target.port;
    const claim = claimFor(command);
    // 네이티브 session.fetch는 이 함수가 쓰기 전에 Set-Cookie를 partition jar에 넣을 수 있다. 확정은 여기서만 한다.
    return withPairing(origin, port, async () => {
      if (!claimLive(origin, port, claim, signal)) return "rejected" as const;
      const pairingName = cookieName("pairing", port);
      const sessionName = cookieName("session", port);
      const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (lines.some((line) => line.startsWith(`${sessionName}=`) && !line.startsWith(`${sessionName}=;`))) return "rejected" as const;
      const header = lines.find((line) => line.startsWith(`${pairingName}=`));
      if (header) {
        const parsed = parseSetCookie(header, Math.floor(Date.now() / 1000));
        // 서버가 지우라고 한 값(Max-Age ≤ 0)이나 빈 값은 확정하지 않는다.
        if (parsed.value.length === 0 || parsed.expired || !claimLive(origin, port, claim, signal)) return "rejected" as const;
        const current = (await partition.readCookies(origin)).find((cookie) => cookie.name === pairingName && cookie.value.length > 0);
        if (!claimLive(origin, port, claim, signal)) return "rejected" as const;
        // 네이티브 fetch가 이미 같은 값을 서버 속성 그대로 적용했다면 건드리지 않는다: 같은 값이라는 이유만으로 명시 set을 하면
        // 만료·SameSite가 사라져 영속 쿠키가 session 쿠키로 바뀐다. 값이 다르거나 서버가 준 속성이 반영돼 있지 않으면(미적용·옛 쿠키)
        // 서버가 발행한 속성 그대로 쓴다.
        const applied = current !== undefined
          && current.value === parsed.value
          && (parsed.expirationDate === undefined || typeof current.expirationDate === "number")
          && (parsed.sameSite === undefined || current.sameSite === parsed.sameSite);
        if (!applied) {
          await partition.writeCookie({
            name: pairingName, value: parsed.value, url: origin, path: parsed.path, secure: parsed.secure, httpOnly: parsed.httpOnly,
            ...(parsed.expirationDate !== undefined ? { expirationDate: parsed.expirationDate } : {}),
            ...(parsed.sameSite !== undefined ? { sameSite: parsed.sameSite } : {}),
          });
          if (!claimLive(origin, port, claim, signal)) return "rejected" as const;
        }
      }
      const cookies = await partition.readCookies(origin);
      if (!claimLive(origin, port, claim, signal)) return "rejected" as const;
      if (cookies.some((cookie) => cookie.name === sessionName && cookie.value.length > 0)) return "rejected" as const;
      if (!cookies.some((cookie) => cookie.name === pairingName && cookie.value.length > 0)) return "rejected" as const;
      publishClaim(origin, port, claim);
      return "paired" as const;
    });
  }

  function sanitizeDeviceName(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 48);
    return cleaned.length > 0 ? cleaned : null;
  }

  function acceptUploadChunk(command: DesktopHostCommand): { kind: "body"; body: Buffer } | { kind: "relay"; relay: DesktopHostRelay } {
    const upload = readUpload(command.params.upload);
    const raw = command.params.dataBase64;
    if (!upload || typeof raw !== "string" || raw.length === 0 || raw.length > DESKTOP_HOST_UPLOAD_CHUNK_CHARS || raw.length % 4 !== 0) {
      return { kind: "relay", relay: { id: command.id, error: "route_denied" } };
    }
    const piece = Buffer.from(raw, "base64");
    if (piece.length === 0) return { kind: "relay", relay: { id: command.id, error: "route_denied" } };
    let assembly = uploads.get(upload.id);
    if (!assembly) {
      if (uploads.size >= DESKTOP_HOST_UPLOAD_SLOTS || upload.index !== 0) {
        return { kind: "relay", relay: { id: command.id, error: "remote_host_unavailable" } };
      }
      assembly = { count: upload.count, totalBytes: upload.totalBytes, next: 0, bytes: 0, parts: [] };
      uploads.set(upload.id, assembly);
    }
    if (upload.count !== assembly.count || upload.totalBytes !== assembly.totalBytes || upload.index > assembly.next) {
      uploads.delete(upload.id);
      return { kind: "relay", relay: { id: command.id, error: "remote_host_unavailable" } };
    }
    if (upload.index < assembly.next) return { kind: "relay", relay: { id: command.id, uploadAck: upload.index } };
    if (assembly.bytes + piece.length > assembly.totalBytes) {
      uploads.delete(upload.id);
      return { kind: "relay", relay: { id: command.id, error: "route_denied" } };
    }
    assembly.parts.push(piece);
    assembly.bytes += piece.length;
    assembly.next += 1;
    if (assembly.next < assembly.count) return { kind: "relay", relay: { id: command.id, uploadAck: upload.index } };
    if (assembly.bytes !== assembly.totalBytes) {
      uploads.delete(upload.id);
      return { kind: "relay", relay: { id: command.id, error: "route_denied" } };
    }
    const body = Buffer.concat(assembly.parts, assembly.bytes);
    uploads.delete(upload.id);
    return { kind: "body", body };
  }

  async function performHttp(command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal, staged?: Buffer): Promise<DesktopHostRelay> {
    const path = safePath(command.params.path);
    const method = command.params.method === "GET" || command.params.method === "HEAD" || command.params.method === "POST" || command.params.method === "DELETE" ? command.params.method : null;
    if (!path || !method) return { id: command.id, error: "route_denied" };
    const hasJson = Object.prototype.hasOwnProperty.call(command.params, "json");
    const raw = typeof command.params.dataBase64 === "string" ? command.params.dataBase64 : null;
    if ((raw !== null || staged !== undefined) && hasJson) return { id: command.id, error: "route_denied" };
    let body: string | Buffer | undefined;
    let contentType: string | undefined;
    if (staged !== undefined) {
      body = staged;
      contentType = "application/octet-stream";
    } else if (hasJson) {
      body = JSON.stringify(command.params.json);
      contentType = "application/json";
    } else if (raw !== null) {
      if (raw.length > DESKTOP_HOST_UPLOAD_CHUNK_CHARS) return { id: command.id, error: "route_denied" };
      const bytes = Buffer.from(raw, "base64");
      if (bytes.length === 0 || bytes.length > HOST_UPLOAD_MAX_BYTES) return { id: command.id, error: "route_denied" };
      body = bytes;
      // 브라우저가 말한 MIME은 전달하지 않는다. 원격이 머리 바이트로 판정한다.
      contentType = "application/octet-stream";
    }
    let response: Response;
    try {
      response = await partition.fetch(`${origin}${path}`, {
        method, redirect: "error", signal,
        headers: { Origin: origin, ...(contentType ? { "content-type": contentType } : {}) },
        body,
      });
    } catch {
      return { id: command.id, error: "remote_host_unavailable" };
    }
    // 일반 HTTP·bytes 응답은 쿠키를 발행하지 않는다(Console 전체에서 Set-Cookie는 join·host-session·pair뿐). 창 jar를 다시 복사하지 않는다.
    if (response.status === 204 || response.status === 205 || response.status === 304) return { id: command.id, status: response.status, contentType: null };
    const type = response.headers.get("content-type") ?? "";
    if (command.op === "bytes") {
      const bytes = Buffer.from(await response.arrayBuffer());
      // 제품이 저장한 이미지(최대 10MiB)를 그대로 미리 보여 준다. 그보다 큰 응답은 자원 통로로 넘기지 않는다.
      if (bytes.length > HOST_RESOURCE_MAX_BYTES) return { id: command.id, error: "remote_host_unavailable" };
      return { id: command.id, status: response.status, contentType: safeByteType(type), dataBase64: bytes.toString("base64") };
    }
    if (!type.includes("json")) return { id: command.id, status: response.status, contentType: null };
    try { return { id: command.id, status: response.status, contentType: "application/json", json: await response.json() }; }
    catch { return { id: command.id, status: response.status, contentType: null }; }
  }

  async function streamEvents(command: DesktopHostCommand, origin: string, partition: HostPartition, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const path = safePath(command.params.path);
    if (!path) { await emit({ id: command.id, error: "route_denied", end: true }); return; }
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    jobs.set(command.id, { hostKey: command.hostKey, epoch: command.epoch, abort: stop });
    try {
      const response = await partition.fetch(`${origin}${path}`, {
        method: "GET", redirect: "error", headers: { Accept: "text/event-stream", Origin: origin }, signal: controller.signal,
      });
      if (!response.ok || !response.body) { await emit({ id: command.id, error: "remote_host_unavailable", status: response.status, end: true }); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        while (pending.length >= FRAME_CHARS) {
          const slice = pending.slice(0, FRAME_CHARS);
          pending = pending.slice(FRAME_CHARS);
          await emit({ id: command.id, text: slice });
        }
        if (pending.includes("\n\n")) {
          const end = pending.lastIndexOf("\n\n") + 2;
          await emit({ id: command.id, text: pending.slice(0, end) });
          pending = pending.slice(end);
        }
      }
      if (pending.length > 0 && !controller.signal.aborted) await emit({ id: command.id, text: pending });
      await emit({ id: command.id, end: true });
    } catch {
      await emit({ id: command.id, error: controller.signal.aborted ? "remote_host_unavailable" : "remote_host_unreachable", end: true });
    } finally {
      jobs.delete(command.id);
    }
  }

  async function streamSocket(command: DesktopHostCommand, origin: string, partition: HostPartition, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const channel = command.params.channel === "chat" || command.params.terminal === true || command.params.channel === "terminal" ? command.params.channel : null;
    const operationId = typeof command.params.operationId === "string" ? command.params.operationId : null;
    if ((channel !== "chat" && channel !== "terminal") || !operationId) { await emit({ id: command.id, error: "invalid_host_request", end: true }); return; }
    const ticketResponse = await partition.fetch(`${origin}${TICKET_PATH}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify(channel === "chat" ? { operationId, channel: "chat" } : { operationId }),
    });
    let ticket = "";
    try {
      const payload = await ticketResponse.json() as { readonly ticket?: unknown };
      ticket = ticketResponse.ok && typeof payload.ticket === "string" ? payload.ticket : "";
    } catch { ticket = ""; }
    if (!ticket) { await emit({ id: command.id, error: ticketResponse.status === 403 ? "not_controller" : "remote_host_unavailable", end: true }); return; }
    const cookie = (await partition.readCookies(origin)).map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const controller = new AbortController();
    let chain = Promise.resolve();
    // 핀된 원격이 프레임을 쏟아도 릴레이 대기열이 메모리를 먹지 않게 한다. 넘치면 소켓을 닫는다.
    const maxRelayChars = 1024 * 1024;
    let relayChars = 0;
    let socket: PinnedSocket | null = null;
    const stop = () => { controller.abort(); socket?.close(); };
    const enqueue = (relay: DesktopHostRelay): Promise<void> => {
      const size = (relay.text?.length ?? 0) + (relay.dataBase64?.length ?? 0);
      if (size > 0 && relayChars + size > maxRelayChars) { stop(); return chain; }
      relayChars += size;
      chain = chain.then(() => emit(relay)).then(() => { relayChars -= size; }, () => { relayChars -= size; });
      return chain;
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    jobs.set(command.id, {
      hostKey: command.hostKey, epoch: command.epoch,
      abort: stop,
      send: (payload) => {
        if (!socket) return;
        if (payload.text !== undefined) socket.sendText(payload.text);
        else if (payload.dataBase64 !== undefined) socket.sendBytes(Buffer.from(payload.dataBase64, "base64"));
      },
    });
    try {
      socket = await (deps.openSocket ?? openPinnedWebSocket)({
        hostname: command.target.hostname, port: command.target.port, fingerprint: command.target.fingerprint,
        path: `${TERMINAL_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`, cookie, signal: controller.signal,
        onText: (text) => enqueue({ id: command.id, text }),
        onBytes: (bytes) => enqueue({ id: command.id, dataBase64: bytes.toString("base64") }),
      });
      await enqueue({ id: command.id, ready: true });
      await socket.closed;
      await chain; await enqueue({ id: command.id, end: true });
    } catch (error) {
      const code = error instanceof Error && error.message === "remote_host_fingerprint_mismatch" ? "remote_host_fingerprint_mismatch" : "remote_host_unavailable";
      await emit({ id: command.id, error: code, end: true });
    } finally {
      jobs.delete(command.id);
    }
  }
}

function safePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("://") || value.includes("\\")) return null;
  return value;
}

function isSessionCapability(value: unknown): value is { capability: "host-session"; mode: "off" | "observer" | "controller"; access: "full" | "monitoring" | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.capability !== "host-session") return false;
  if (body.mode !== "off" && body.mode !== "observer" && body.mode !== "controller") return false;
  if (body.access !== null && body.access !== "full" && body.access !== "monitoring") return false;
  if (body.mode === "controller" && body.access !== "full") return false;
  if (body.mode === "off" && body.access !== null) return false;
  return true;
}

function safeByteType(value: string): string {
  const [rawType, ...params] = value.split(";").map((part) => part.trim().toLowerCase());
  const type = rawType ?? "";
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") return type;
  // 증거 텍스트는 charset까지 제품이 보낸 그대로다. 그 외 매개변수나 PDF는 닫힌 타입으로 접지 않는다.
  if (type === "text/plain") return params.some((part) => part.replace(/\s+/gu, "") === "charset=utf-8") ? "text/plain; charset=utf-8" : "text/plain";
  return "application/octet-stream";
}

export function createDesktopHostTransport(deps: HostTransportExecutorDeps & { readonly fetch: typeof fetch; readonly log?: (message: string) => void }): { start(origin: string): Promise<void>; stop(): void } {
  let activeOrigin: string | null = null;
  const executor = createHostTransportExecutor({
    ...deps,
    localOrigin: () => activeOrigin,
    localFetch: deps.fetch,
    deviceName: deps.deviceName ?? null,
  });
  const running = new Set<number>();
  const streams = new Map<number, AbortController>();
  const calls = new Map<number, AbortController>();
  // 같은 출처로 콘솔이 다시 떠도 instanceId가 같으면 살아 있는 스트림을 끊지 않는다. 달라질 때만 앞 프로세스의 번호와 epoch를 잊는다.
  let consoleInstance: string | null = null;
  const postRelay = async (relay: DesktopHostRelay, owner: string): Promise<boolean> => {
    const origin = activeOrigin;
    if (!origin || owner !== consoleInstance) return false;
    // 이미 끝난 원격 호출을 다시 실행하지 않는다. 거절된 결과만 몇 번 더 전달한다.
    for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
      if (activeOrigin !== origin || owner !== consoleInstance) return false;
      try {
        const response = await deps.fetch(`${origin}${DESKTOP_HOST_TRANSPORT_RELAY_PATH}`, {
          // 명령 번호를 헤더에도 싣는다. Console은 본문을 읽기 전에 그 번호가 기다리는 자원 호출인지 보고 상한을 고른다.
          method: "POST", headers: { "content-type": "application/json", Origin: origin, [DESKTOP_HOST_RELAY_ID_HEADER]: String(relay.id) }, body: JSON.stringify(relay),
        });
        if (response.ok) return true;
        if (owner === consoleInstance) deps.log?.(`host transport relay rejected status=${response.status}`);
      } catch (error) {
        if (owner === consoleInstance) deps.log?.(`host transport relay failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
      if (attempt + 1 < RELAY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RELAY_BACKOFF_MS[attempt] ?? 400));
    }
    if (owner === consoleInstance) deps.log?.(`host transport relay dropped id=${relay.id}`);
    return false;
  };
  const stream = createDesktopEventStream({
    snapshotPath: DESKTOP_HOST_TRANSPORT_PATH,
    eventsPath: DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
    eventName: DESKTOP_HOST_TRANSPORT_EVENT,
    parseSnapshot: (value) => isDesktopHostSnapshot(value) ? value : null,
    maxFrameChars: DESKTOP_HOST_FRAME_MAX_CHARS,
    normalizeOrigin: (origin) => new URL(origin).origin,
    fetch: deps.fetch,
    apply: (snapshot) => {
      if (snapshot.instanceId !== consoleInstance) {
        const replacing = consoleInstance !== null;
        consoleInstance = snapshot.instanceId;
        if (replacing) {
          running.clear();
          for (const controller of streams.values()) controller.abort();
          for (const controller of calls.values()) controller.abort();
          streams.clear();
          calls.clear();
          executor.releaseConsole();
        }
      }
      const owner = consoleInstance ?? snapshot.instanceId;
      const live = new Set(snapshot.commands.map((command) => command.id));
      for (const [id, controller] of streams) if (!live.has(id)) controller.abort();
      for (const [id, controller] of calls) if (!live.has(id)) controller.abort();
      for (const id of running) if (!live.has(id)) running.delete(id);
      for (const command of snapshot.commands) {
        if (running.has(command.id)) continue;
        running.add(command.id);
        const streaming = command.op === "sse" || command.op === "ws-open";
        const controller = new AbortController();
        (streaming ? streams : calls).set(command.id, controller);
        const deliver = async (relay: DesktopHostRelay): Promise<void> => {
          if (owner !== consoleInstance) return;
          if (streaming && controller.signal.aborted && relay.end !== true && relay.error === undefined) return;
          const accepted = await postRelay(relay, owner);
          if (!accepted && owner === consoleInstance) controller.abort();
        };
        const done = streaming
          ? executor.run(command, deliver, controller.signal)
          : executor.execute(command, controller.signal).then((relay) => deliver(relay));
        void done.catch((error: unknown) => {
          deps.log?.(`host transport failed: ${error instanceof Error ? error.message : "unknown"}`);
          return postRelay({ id: command.id, error: "remote_host_unavailable", end: true }, owner);
        }).finally(() => {
          const map = streaming ? streams : calls;
          if (map.get(command.id) === controller) map.delete(command.id);
        });
      }
    },
  });
  return {
    start(origin) { activeOrigin = new URL(origin).origin; return stream.start(activeOrigin); },
    stop() {
      activeOrigin = null;
      running.clear();
      for (const controller of streams.values()) controller.abort();
      for (const controller of calls.values()) controller.abort();
      streams.clear();
      calls.clear();
      executor.releaseConsole();
      stream.stop();
    },
  };
}

interface UploadAssembly {
  readonly count: number;
  readonly totalBytes: number;
  next: number;
  bytes: number;
  readonly parts: Buffer[];
}

function readUpload(value: unknown): { id: number; index: number; count: number; totalBytes: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 4) return null;
  const { id, index, count, totalBytes } = body;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || index >= count) return null;
  if (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > HOST_UPLOAD_MAX_BYTES) return null;
  return { id, index, count, totalBytes };
}

