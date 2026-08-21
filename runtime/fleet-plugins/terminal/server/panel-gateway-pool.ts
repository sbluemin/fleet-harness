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

export function createPanelGatewayPool(deps: CreatePanelGatewayPoolDeps): PanelGatewayPool {
  const maxGateways = deps.maxGateways ?? MAX_PANEL_GATEWAYS;
  const startTimeoutMs = deps.startTimeoutMs ?? PANEL_GATEWAY_START_TIMEOUT_MS;
  const spawnChild = deps.spawnChild ?? spawn;
  const live = new Map<string, PanelGatewayEntry>();
  const shared = new Set<string>();
  const starting = new Map<string, Promise<string | null>>();
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
      const port = Number.parseInt(rest.slice(0, end), 10);
      finish(Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.resume();
    child.once("error", () => { finish(null); });
    child.once("exit", () => { finish(null); });
  });
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
