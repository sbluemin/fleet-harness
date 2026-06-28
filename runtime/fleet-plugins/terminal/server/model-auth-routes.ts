import type http from "node:http";

import type { CliType } from "@dotobokuri/core-unified-agent";
import {
  CLI_TO_AUTH_PROVIDER_ID,
  type AuthService,
  type AuthValidationFailureResult,
  validateAuthKeyForCli,
} from "@dotobokuri/fleet-infra/auth";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { buildModelAuthState, type TerminalModelAuthProviderState } from "./model-auth-state.js";

type AuthKeyValidation =
  | { readonly providerId: string; readonly status: "success" }
  | AuthValidationFailureResult;

interface TerminalModelAuthRouteDeps {
  readonly authService: Pick<AuthService, "setApiKey" | "deleteApiKey" | "listProviderIds">;
  readonly validateApiKey: (cli: CliType, apiKey: string) => Promise<AuthKeyValidation>;
}

interface SignInBody {
  readonly apiKey?: unknown;
}

// 사용자 키 거부(400)와 외부 provider 검증 자체 장애(502)를 HTTP 상태로 구분한다.
const UPSTREAM_FAILURE_STATUSES: ReadonlySet<string> = new Set(["timeout", "network", "server"]);

export function registerTerminalModelAuthRoutes(
  ctx: FleetPluginServerContext,
  deps: Pick<TerminalModelAuthRouteDeps, "authService">,
): void {
  registerRouter(ctx, "model-auth", createTerminalModelAuthRouter(ctx, {
    ...deps,
    validateApiKey: (cli, apiKey) => validateAuthKeyForCli(cli, apiKey),
  }));
}

export function createTerminalModelAuthRouter(
  ctx: FleetPluginServerContext,
  deps: TerminalModelAuthRouteDeps,
): (context: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }) => Promise<boolean> {
  return async function handleTerminalModelAuthRoute({ req, res, pathname }): Promise<boolean> {
    const path = pathname.slice(`${ctx.basePath}/model-auth`.length) || "/";
    if (path === "/state") {
      if (req.method !== "GET") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      // 상류 host 게이트로 loopback이 보장된다. 플러그인 라우터에서 validateHost를 중복 호출하지 않는다.
      ctx.host.http.writeJson(res, 200, await buildModelAuthState(deps.authService));
      return true;
    }
    const cli = parseProviderPath(path);
    if (!cli) return false;
    const provider = await findProvider(deps, cli);
    if (!provider) {
      ctx.host.http.writeJson(res, 404, { error: "provider_not_found" });
      return true;
    }
    if (req.method === "PUT") {
      await signInProvider(ctx, req, res, deps, provider);
      return true;
    }
    if (req.method === "DELETE") {
      await signOutProvider(ctx, req, res, deps, provider);
      return true;
    }
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  };
}

async function signInProvider(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TerminalModelAuthRouteDeps,
  provider: TerminalModelAuthProviderState,
): Promise<void> {
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isJsonRequest(req)) {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  const body = await ctx.host.http.readJsonBody<SignInBody>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_json" });
    return;
  }
  // 계약: apiKey 단일 키만 허용한다(providerId·detail 등 민감 필드 혼입을 거부).
  if (Object.keys(body).length !== 1 || typeof body.apiKey !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_api_key" });
    return;
  }
  const apiKey = body.apiKey.trim();
  if (apiKey.length === 0) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_api_key" });
    return;
  }
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli as CliType];
  if (!providerId) {
    ctx.host.http.writeJson(res, 500, { error: "provider_unavailable" });
    return;
  }
  // 검증은 서버에서만 수행한다. 키는 외부 provider 검증과 로컬 저장에만 쓰이고 브라우저로 되돌려보내지 않는다.
  const validation = await deps.validateApiKey(provider.cli as CliType, apiKey);
  if (validation.status !== "success") {
    const status = UPSTREAM_FAILURE_STATUSES.has(validation.status) ? 502 : 400;
    // 실패 메시지는 displayName만 사용한다. providerId와 upstream detail은 브라우저로 내보내지 않는다(Token Boundary).
    ctx.host.http.writeJson(res, status, {
      error: formatSignInFailureMessage(provider.displayName, validation.status),
      status: validation.status,
    });
    return;
  }
  await deps.authService.setApiKey(providerId, apiKey);
  await writeMutationState(ctx, res, deps);
}

async function signOutProvider(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TerminalModelAuthRouteDeps,
  provider: TerminalModelAuthProviderState,
): Promise<void> {
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli as CliType];
  if (!providerId) {
    ctx.host.http.writeJson(res, 500, { error: "provider_unavailable" });
    return;
  }
  // 현재 store에서 삭제한다. legacy auth 마이그레이션이 제거되어 legacy 키 부활 우려가 없다.
  await deps.authService.deleteApiKey(providerId);
  await writeMutationState(ctx, res, deps);
}

async function writeMutationState(
  ctx: FleetPluginServerContext,
  res: http.ServerResponse,
  deps: TerminalModelAuthRouteDeps,
): Promise<void> {
  ctx.host.http.writeJson(res, 200, { state: await buildModelAuthState(deps.authService) });
}

async function findProvider(
  deps: TerminalModelAuthRouteDeps,
  cli: string,
): Promise<TerminalModelAuthProviderState | null> {
  return (await buildModelAuthState(deps.authService)).providers.find((provider) => provider.cli === cli) ?? null;
}

function parseProviderPath(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "providers") return null;
  return safeDecodeURIComponent(parts[1] ?? "");
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

// displayName만 쓰는 브라우저-안전 실패 문구. providerId(저장 키)와 upstream detail은 의도적으로 배제한다.
function formatSignInFailureMessage(displayName: string, status: string): string {
  switch (status) {
    case "unauthorized":
      return `${displayName} rejected the API key. Check the key and try again.`;
    case "forbidden":
      return `The API key is not allowed for ${displayName}. Check its permissions.`;
    case "timeout":
      return `Validating the ${displayName} API key timed out. Check your connection and try again.`;
    case "network":
      return `Could not reach ${displayName} to validate the API key. Check your connection and try again.`;
    case "server":
      return `${displayName} returned an error while validating the API key. Try again later.`;
    default:
      return `Could not validate the ${displayName} API key. Check the key and try again.`;
  }
}
