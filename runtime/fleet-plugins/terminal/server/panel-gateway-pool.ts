import { spawn, type ChildProcess } from "node:child_process";

/**
 * Upper bound on how many panel gateway processes one Console keeps alive.
 *
 * Each one is a real Node process with its own heap, its own undici dispatcher, and its own
 * listening socket, so this ceiling is memory and file descriptors rather than bookkeeping. Past
 * it a launch falls back to the Console's shared gateway and keeps working; the setting buys
 * isolation, and running out of isolation must never mean running out of gateway.
 */
export const MAX_PANEL_GATEWAYS = 8;

/** How long a child may take to report its port before the launch gives up and shares instead. */
export const PANEL_GATEWAY_START_TIMEOUT_MS = 15_000;

export interface PanelGatewayPool {
  /**
   * The base URL this operation's child must dial, or `null` when it shares the Console gateway —
   * the setting is off, the launch carries no operation identity, the pool is full, or the child
   * failed to start.
   *
   * The answer is decided once per operation and then repeated. Both surfaces of one Operation ask
   * separately, the terminal launch and the Chat Mode session, and a setting change between those
   * two calls must not put them on different gateways.
   */
  readonly claim: (operationId: string | undefined) => Promise<string | null>;
  readonly release: (operationId: string) => void;
  /** Live panel gateway count. Test and diagnostic surface only. */
  readonly size: () => number;
  readonly dispose: () => void;
}

export interface CreatePanelGatewayPoolDeps {
  /** Whether a newly launched panel gets its own gateway process. Read per launch, never cached. */
  readonly enabled: () => boolean;
  /** Console CLI entry the child re-enters through, plus how to run it. */
  readonly command: () => PanelGatewayCommand;
  /** Environment the child inherits. Its Fleet data root decides which settings it reads. */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnChild?: typeof spawn;
  readonly startTimeoutMs?: number;
  readonly maxGateways?: number;
  /** Reports a child that died on its own, so a host can surface it. */
  readonly onExit?: (operationId: string, code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface PanelGatewayCommand {
  readonly execPath: string;
  readonly args: readonly string[];
}

interface PanelGatewayEntry {
  readonly child: ChildProcess;
  readonly baseUrl: string;
}

/** Line a ready child writes. Kept in sync with the host module the child runs. */
const READY_PREFIX = "fleet-panel-gateway-ready ";

/**
 * Roots the parent hands the child, kept in sync with the same host module.
 *
 * The child must never derive these. `getFleetDataDir()` reads only `FLEET_DATA_DIR`, while a
 * Console's effective root can come from `FLEET_CONSOLE_DATA_DIR` or an embedded `dataDir` that
 * the child does not inherit — left alone it falls back to the real `~/.fleet` and both reads the
 * wrong settings and writes into a root the caller believed it had isolated away from.
 */
export const PANEL_GATEWAY_DATA_DIR_ENV = "FLEET_DATA_DIR";
export const PANEL_GATEWAY_LOG_DIR_ENV = "FLEET_PANEL_GATEWAY_LOG_DIR";

export function createPanelGatewayPool(deps: CreatePanelGatewayPoolDeps): PanelGatewayPool {
  const maxGateways = deps.maxGateways ?? MAX_PANEL_GATEWAYS;
  const startTimeoutMs = deps.startTimeoutMs ?? PANEL_GATEWAY_START_TIMEOUT_MS;
  const spawnChild = deps.spawnChild ?? spawn;
  const live = new Map<string, PanelGatewayEntry>();
  const shared = new Set<string>();
  const starting = new Map<string, Promise<string | null>>();
  /**
   * 기동 중에 회수된 Operation. 그 순간에는 죽일 자식이 아직 없으므로, 준비를 마친 뒤에
   * 여기서 잡아 내려야 한다. 놓치면 이미 사라진 패널의 프로세스가 Console이 끝날 때까지
   * 남아 여덟 자리 중 하나를 계속 차지한다.
   */
  const releasedWhileStarting = new Set<string>();
  let disposed = false;

  const decideShared = (operationId: string): null => {
    shared.add(operationId);
    return null;
  };

  const start = async (operationId: string): Promise<string | null> => {
    const command = deps.command();
    const child = spawnChild(command.execPath, [...command.args], {
      env: deps.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const baseUrl = await waitForReady(child, startTimeoutMs);
    if (releasedWhileStarting.delete(operationId)) {
      // 기동 중에 패널이 사라졌다. 공용으로 기록하지도 않는다 — 그 Operation은 더 이상 없고,
      // 같은 id가 다시 나타난다면 그때의 설정으로 새로 판단해야 한다.
      kill(child);
      return null;
    }
    if (baseUrl === null || disposed) {
      kill(child);
      return decideShared(operationId);
    }
    live.set(operationId, { child, baseUrl });
    child.once("exit", (code, signal) => {
      const entry = live.get(operationId);
      if (!entry || entry.child !== child) return;
      live.delete(operationId);
      // 죽은 자식의 결정을 공용으로 덮지 않는다. 이미 그 URL로 뜬 자식이 살아 있을 수 있고,
      // 다음 표면은 새 자식을 받아야 한다 — 여기서 공용으로 굳히면 그 Operation은 영영 공용이 된다.
      deps.onExit?.(operationId, code, signal);
    });
    return baseUrl;
  };

  return {
    claim: async (operationId) => {
      if (disposed || !operationId) return null;
      const existing = live.get(operationId);
      if (existing) return existing.baseUrl;
      if (shared.has(operationId)) return null;
      const inFlight = starting.get(operationId);
      if (inFlight) return inFlight;
      let enabled: boolean;
      try {
        enabled = deps.enabled();
      } catch {
        // 설정 판독 실패는 런치를 실패시키지 않는다. 공용 게이트웨이가 언제나 이 패널을 서빙할 수
        // 있으므로 그쪽으로 떨어진다. 다만 결정으로 기록하지는 않는다 — 답을 못 준 것뿐이다.
        return null;
      }
      if (!enabled) return decideShared(operationId);
      if (live.size + starting.size >= maxGateways) return decideShared(operationId);
      const flight = start(operationId).finally(() => { starting.delete(operationId); });
      starting.set(operationId, flight);
      return flight;
    },
    release: (operationId) => {
      shared.delete(operationId);
      if (starting.has(operationId)) releasedWhileStarting.add(operationId);
      const entry = live.get(operationId);
      if (!entry) return;
      live.delete(operationId);
      kill(entry.child);
    },
    size: () => live.size,
    dispose: () => {
      disposed = true;
      for (const entry of live.values()) kill(entry.child);
      live.clear();
      shared.clear();
      releasedWhileStarting.clear();
    },
  };
}

/**
 * Resolves once the child says which port it took, or to `null` on any way of failing to.
 *
 * The child's readiness is its stdout line rather than a port we picked, because picking one here
 * would mean racing every other listener on the machine for it. Its stderr is drained and dropped:
 * an unread pipe fills and blocks the child, and a gateway that stalls because nobody read its
 * warnings would be a far worse failure than the warnings themselves.
 */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = "";
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => { finish(null); }, timeoutMs);
    timer.unref?.();
    const onData = (chunk: Buffer | string): void => {
      buffered += String(chunk);
      const at = buffered.indexOf(READY_PREFIX);
      if (at < 0) {
        // 준비 줄은 첫 줄에 온다. 그래도 버퍼가 무한히 자라지 않게 최근 조각만 유지한다.
        if (buffered.length > 4096) buffered = buffered.slice(-1024);
        return;
      }
      const rest = buffered.slice(at + READY_PREFIX.length);
      const end = rest.search(/[\r\n]/u);
      if (end < 0) return;
      // 자식이 마운트까지 포함한 완성된 URL을 준다. 여기서 조립하지 않는 이유가 있다 —
      // 조립하던 시절 마운트 경로가 빠져 모든 모델 요청이 404였고, 마운트를 테스트 쪽에서
      // 덧붙이는 바람에 그 결함이 green 아래 숨었다.
      finish(asLoopbackUrl(rest.slice(0, end).trim()));
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.resume();
    child.once("error", () => { finish(null); });
    child.once("exit", () => { finish(null); });
  });
}

/**
 * 자식이 보고한 문자열을 신뢰하기 전에 형태를 확인한다. 루프백 http URL이 아니면 이 패널은
 * 공용 게이트웨이로 떨어진다 — 잘못된 URL을 자식 env에 구우면 그 패널의 모든 턴이 죽는다.
 */
function asLoopbackUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1") return null;
  if (!url.port) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

function kill(child: ChildProcess): void {
  try {
    // stdin을 닫는 것이 정상 종료 신호다(자식은 EOF에서 스스로 내려간다). SIGTERM은 그 뒤를 받친다.
    child.stdin?.end();
    child.kill("SIGTERM");
  } catch {
    // 이미 죽은 자식에게 보내는 신호는 무시한다 — 회수의 목적은 이미 달성됐다.
  }
}
