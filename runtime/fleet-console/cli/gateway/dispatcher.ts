import {
  createAiGatewaySettingsStore,
  createProviderAuthService,
  codexCliSubscriptionPresent,
  defaultCredentialDeps,
  isSubscriptionSignedOutEntry,
  xaiCliSubscriptionPresent,
  CODEX_AUTH_PROVIDER_ID,
  XAI_AUTH_PROVIDER_ID,
  CURSOR_AUTH_PROVIDER_ID,
  type AiGatewaySettingsStore,
  type AuthService,
  type AuthStorageEntry,
  type CredentialResolverDeps,
} from "@fleet-console/ai-gateway";
import { getFleetDataDir } from "@fleet-console/infra";

import { createConsoleDataPaths } from "../../core/host/bootstrap/paths.js";

import { buildGatewayHelpText } from "./help.js";
import { runGatewayInteractive } from "./interactive.js";
import { GATEWAY_SET_KEYS, applyGatewaySetting, isGatewaySetKey } from "./policy.js";
import {
  buildGatewayStatusReport,
  collectGatewayModels,
  renderGatewayModelsJson,
  renderGatewayModelsText,
  renderGatewayStatusJson,
  renderGatewayStatusText,
  type GatewayCredentialReport,
} from "./report.js";
import { dispatchAuthCommand } from "../auth/dispatcher.js";

export type GatewayDispatch =
  | { readonly kind: "help" }
  | { readonly kind: "interactive" }
  | { readonly kind: "models"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "set"; readonly key: string | undefined; readonly value: string | undefined }
  | { readonly kind: "unknown"; readonly command: string };

export interface GatewayCommandIo {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
}

export interface GatewayCommandDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
  readonly createStore?: (dataDir: string) => AiGatewaySettingsStore;
  readonly createAuthService?: () => AuthService;
  readonly dispatchAuthCommand?: typeof dispatchAuthCommand;
  readonly runInteractive?: typeof runGatewayInteractive;
  readonly readSubscriptions?: GatewaySubscriptionReaders;
}

export interface GatewaySubscriptionReaders {
  readonly codex: () => Promise<unknown>;
  readonly cursor: () => Promise<unknown>;
  readonly xai: () => Promise<unknown>;
}

/** `gateway` 뒤의 인자만 받는다. 알 수 없는 명령은 Claude로 흘리지 않고 여기서 끝난다. */
export function classifyGatewayArgv(argv: readonly string[]): GatewayDispatch {
  const command = argv[0];
  if (command === undefined) return { kind: "interactive" };
  if (command === "--help" || command === "-h") return { kind: "help" };
  if (command === "models") return { kind: "models", json: hasJsonFlag(argv.slice(1)) };
  if (command === "status") return { kind: "status", json: hasJsonFlag(argv.slice(1)) };
  if (command === "set") return { kind: "set", key: argv[1], value: argv[2] };
  return { kind: "unknown", command };
}

export async function dispatchGatewayCommand(
  argv: readonly string[],
  io: GatewayCommandIo,
  deps: GatewayCommandDeps = {},
): Promise<number> {
  const dispatch = classifyGatewayArgv(argv);
  const env = deps.env ?? process.env;

  if (dispatch.kind === "help") {
    io.stdout.write(`${buildGatewayHelpText({ env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (dispatch.kind === "unknown") {
    io.stderr.write(`Unknown fleet gateway command: ${dispatch.command}\n`);
    io.stdout.write(`${buildGatewayHelpText({ env, isTTY: io.stdout.isTTY })}\n`);
    return 1;
  }

  const slot = resolveGatewaySlot(deps.dataDir);
  const dataDir = slot.dataDir;
  const store = (deps.createStore ?? ((dir) => createAiGatewaySettingsStore({ dataDir: dir, legacyDirs: slot.legacyDirs })))(dataDir);

  if (dispatch.kind === "interactive") {
    const authService = resolveAuthService(deps);
    return await (deps.runInteractive ?? runGatewayInteractive)(io, {
      store,
      authService,
      dispatchAuthCommand: deps.dispatchAuthCommand ?? dispatchAuthCommand,
    });
  }

  if (dispatch.kind === "models") {
    const models = collectGatewayModels(store.read());
    io.stdout.write(dispatch.json
      ? renderGatewayModelsJson(models)
      : `${renderGatewayModelsText(models, { env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (dispatch.kind === "status") {
    const report = buildGatewayStatusReport({
      settingsPath: store.path,
      settings: store.read(),
      credentials: await collectCredentials(deps),
    });
    io.stdout.write(dispatch.json
      ? renderGatewayStatusJson(report)
      : `${renderGatewayStatusText(report, { env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (!isGatewaySetKey(dispatch.key)) {
    io.stderr.write(
      `Unknown fleet gateway set key: ${dispatch.key ?? "(missing)"}\nKnown keys: ${GATEWAY_SET_KEYS.join(", ")}.\n`,
    );
    return 1;
  }
  const result = applyGatewaySetting(store, dispatch.key, dispatch.value);
  if (!result.ok) {
    io.stderr.write(`${result.message}\n`);
    return 1;
  }
  io.stdout.write(`${result.summary}\n`);
  return 0;
}

async function collectCredentials(deps: GatewayCommandDeps): Promise<readonly GatewayCredentialReport[]> {
  const readers = deps.readSubscriptions ?? {
    // 저장 항목이 있으면 그것만 본다. 없을 때만 CLI 파일을 읽고, 어느 쪽도 갱신하지 않는다.
    codex: () => readSubscriptionPresence(deps, CODEX_AUTH_PROVIDER_ID, codexCliPresent),
    cursor: () => readSubscriptionPresence(deps, CURSOR_AUTH_PROVIDER_ID),
    xai: () => readSubscriptionPresence(deps, XAI_AUTH_PROVIDER_ID, xaiCliPresent),
  };
  return [
    { provider: "codex", source: "subscription", state: await probe(readers.codex) },
    { provider: "xai", source: "subscription", state: await probe(readers.xai) },
    { provider: "cursor", source: "subscription", state: await probe(readers.cursor) },
  ];
}

function credentialDeps(env: NodeJS.ProcessEnv): CredentialResolverDeps {
  return { ...defaultCredentialDeps, env };
}

/** 로그아웃 표식은 없는 상태다. Fleet 항목이 없을 때만 CLI를 읽기 전용으로 확인한다. */
async function readSubscriptionPresence(
  deps: GatewayCommandDeps,
  providerId: string,
  cliPresent?: (env: NodeJS.ProcessEnv) => Promise<boolean>,
): Promise<AuthStorageEntry | { readonly source: "cli" } | null> {
  const entry = await resolveAuthService(deps).getEntry(providerId);
  if (entry !== undefined) return isSubscriptionSignedOutEntry(entry) ? null : entry;
  if (cliPresent === undefined) return null;
  return (await cliPresent(deps.env ?? process.env)) ? { source: "cli" } : null;
}

async function codexCliPresent(env: NodeJS.ProcessEnv): Promise<boolean> {
  return codexCliSubscriptionPresent(credentialDeps(env));
}

async function xaiCliPresent(env: NodeJS.ProcessEnv): Promise<boolean> {
  return xaiCliSubscriptionPresent(credentialDeps(env));
}

async function probe(read: () => Promise<unknown>): Promise<"present" | "absent"> {
  try {
    const value = await read();
    return value === null || value === undefined ? "absent" : "present";
  } catch {
    return "absent";
  }
}

function resolveAuthService(deps: GatewayCommandDeps): AuthService {
  // 자격증명은 게이트웨이 설정과 같은 자리에 산다 — `--data-dir`로 옮긴 실행이 설정만
  // 격리하고 auth.json은 다른 자리에서 읽어 오는 어긋남을 만들지 않는다.
  const slot = resolveGatewaySlot(deps.dataDir);
  return (deps.createAuthService ?? (() => createProviderAuthService(slot)))();
}

/**
 * 이 실행이 쓸 Console 슬롯과 그 옛 자리. Console 서버와 같은 규칙으로 풀어야 `fleet`이
 * Console에서 고른 선별과 로그인을 그대로 읽는다.
 */
function resolveGatewaySlot(explicit: string | undefined): { readonly dataDir: string; readonly legacyDirs: readonly string[] } {
  return { dataDir: explicit ?? createConsoleDataPaths().dir, legacyDirs: [getFleetDataDir()] };
}

function hasJsonFlag(argv: readonly string[]): boolean {
  return argv.includes("--json");
}
