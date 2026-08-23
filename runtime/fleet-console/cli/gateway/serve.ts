import {
  createAiGatewaySettingsStore,
  createProviderAuthService,
  type AiGatewaySettingsStore,
  type AuthService,
} from "@dotobokuri/core-ai-gateway";
import { getFleetDataDir } from "@dotobokuri/core-infra";

import { collectGatewayModels } from "./report.js";
import { startGatewayHttpServer, type FleetCliGatewayServer } from "./server.js";
import { applyStoredWireLog } from "../runtime/runtime.js";
import { command, dim, optionRow, resolveColorEnabled, section, stripAnsi } from "../styles/tokens.js";

/**
 * 배너가 제안하는 자격증명 값. 라우터는 접두만 보고 값을 읽지 않으므로 실제 Anthropic 키가
 * 아니어도 되고, 그래서 진짜처럼 보이는 문자열을 쓰지 않는다.
 */
const PLACEHOLDER_ANTHROPIC_KEY = "sk-ant-fleet-local";

export interface GatewayServeIo {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
}

export interface GatewayServeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
  readonly createStore?: (dataDir: string) => AiGatewaySettingsStore;
  readonly createAuthService?: () => AuthService;
  readonly startServer?: typeof startGatewayHttpServer;
  /** 서버를 닫을 때까지 기다리는 방법. 기본은 SIGINT/SIGTERM. */
  readonly waitForShutdown?: () => Promise<void>;
}

type ParsedServeArgs =
  | { readonly ok: true; readonly port?: number }
  | { readonly ok: false; readonly message: string };

export function parseGatewayServeArgs(argv: readonly string[]): ParsedServeArgs {
  let port: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const parsed = parsePort(argv[index + 1]);
      if (parsed === undefined) return { ok: false, message: portError(argv[index + 1]) };
      port = parsed;
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--port=")) {
      const parsed = parsePort(arg.slice("--port=".length));
      if (parsed === undefined) return { ok: false, message: portError(arg.slice("--port=".length)) };
      port = parsed;
      continue;
    }
    return { ok: false, message: `Unknown fleet gateway serve option: ${arg}` };
  }
  return port === undefined ? { ok: true } : { ok: true, port };
}

export async function runGatewayServe(
  argv: readonly string[],
  io: GatewayServeIo,
  deps: GatewayServeDeps = {},
): Promise<number> {
  const parsed = parseGatewayServeArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n`);
    return 1;
  }
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const store = (deps.createStore ?? ((dir) => createAiGatewaySettingsStore({ dataDir: dir })))(dataDir);
  applyStoredWireLog(store, dataDir);
  const authService = (deps.createAuthService ?? (() => createProviderAuthService({ dataDir })))();

  let server: FleetCliGatewayServer;
  try {
    server = await (deps.startServer ?? startGatewayHttpServer)({
      store,
      authService,
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
    });
  } catch (error: unknown) {
    io.stderr.write(`${describeListenFailure(error, parsed.port)}\n`);
    return 1;
  }

  io.stdout.write(buildServeBanner({
    baseUrl: `${server.origin()}${server.routePath}`,
    exposed: collectGatewayModels(store.read()).length,
    env: deps.env,
    isTTY: io.stdout.isTTY,
  }));

  await (deps.waitForShutdown ?? waitForSignal)();
  await server.close();
  io.stdout.write("Fleet AI Gateway stopped.\n");
  return 0;
}

export function buildServeBanner(options: {
  readonly baseUrl: string;
  readonly exposed: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}): string {
  const colorEnabled = resolveColorEnabled(options);
  const lines = [
    section("FLEET AI GATEWAY", colorEnabled),
    optionRow("base URL", options.baseUrl, colorEnabled),
    optionRow(
      "models",
      options.exposed === 0
        ? "none exposed — every request is refused until `fleet gateway` selects one"
        : `${options.exposed} exposed`,
      colorEnabled,
    ),
    "",
    `  ${dim("export", colorEnabled)} ${command(`ANTHROPIC_BASE_URL=${options.baseUrl}`, colorEnabled)}`,
    `  ${dim("export", colorEnabled)} ${command(`ANTHROPIC_API_KEY=${PLACEHOLDER_ANTHROPIC_KEY}`, colorEnabled)}`,
    "",
    // 키를 요구하되 검사하지 않는다는 사실을 둘 다 적는다. 하나만 적으면 배너를 그대로 따른
    // 사용자가 401을 만나거나(키 생략), 진짜 Anthropic 자격이 필요하다고 오해한다(키만 요구).
    `  ${dim("The gateway only checks that the key starts with `sk-ant-`; it never reads the", colorEnabled)}`,
    `  ${dim("value, and spends your own subscriptions. Loopback only, and no authentication —", colorEnabled)}`,
    `  ${dim("whatever reaches this port can spend them. Press Ctrl+C to stop.", colorEnabled)}`,
    "",
  ];
  const text = `${lines.join("\n")}\n`;
  return colorEnabled ? text : stripAnsi(text);
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function portError(value: string | undefined): string {
  return `Invalid --port value: ${value ?? "(missing)"}\nExpected an integer between 1 and 65535.`;
}

function describeListenFailure(error: unknown, port: number | undefined): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "EADDRINUSE" && port !== undefined) {
    return `Port ${port} is already in use. Choose another --port, or omit it for an ephemeral port.`;
  }
  if (code === "EACCES" && port !== undefined) {
    return `Port ${port} needs elevated privileges. Choose a port above 1023.`;
  }
  return error instanceof Error ? error.message : String(error);
}
