import type http from "node:http";

import {
  KIMI_AUTH_PROVIDER_ID,
  validateAgentCliAuthKey,
} from "@dotobokuri/fleet-admiral";
import type { AuthService, AuthValidationFailureResult } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { buildModelAuthState, type TerminalModelAuthProviderState } from "./model-auth-state.js";

type AuthKeyValidation =
  | { readonly providerId: string; readonly status: "success" }
  | AuthValidationFailureResult;

interface TerminalModelAuthRouteDeps {
  readonly authService: Pick<AuthService, "setApiKey" | "deleteApiKey" | "listProviderIds">;
  readonly validateApiKey: (cli: "claude-kimi", apiKey: string) => Promise<AuthKeyValidation>;
}

interface SignInBody {
  readonly apiKey?: unknown;
}

const UPSTREAM_FAILURE_STATUSES: ReadonlySet<string> = new Set(["timeout", "network", "server"]);

export function registerTerminalModelAuthRoutes(
  ctx: FleetPluginServerContext,
  deps: Pick<TerminalModelAuthRouteDeps, "authService">,
): void {
  registerRouter(ctx, "model-auth", createTerminalModelAuthRouter(ctx, {
    ...deps,
    validateApiKey: validateAgentCliAuthKey,
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
      ctx.host.http.writeJson(res, 200, await buildModelAuthState(deps.authService));
      return true;
    }
    const cli = parseProviderPath(path);
    if (!cli) return false;
    if (cli !== "claude-kimi") {
      ctx.host.http.writeJson(res, 404, { error: "provider_not_found" });
      return true;
    }
    const provider = await findProvider(deps);
    if (!provider) {
      ctx.host.http.writeJson(res, 404, { error: "provider_not_found" });
      return true;
    }
    if (req.method === "PUT") {
      await signInProvider(ctx, req, res, deps, provider);
      return true;
    }
    if (req.method === "DELETE") {
      await signOutProvider(ctx, req, res, deps);
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
  if (Object.keys(body).length !== 1 || typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_api_key" });
    return;
  }
  const apiKey = body.apiKey.trim();
  const validation = await deps.validateApiKey(provider.cli, apiKey);
  if (validation.status !== "success") {
    ctx.host.http.writeJson(res, UPSTREAM_FAILURE_STATUSES.has(validation.status) ? 502 : 400, {
      error: formatSignInFailureMessage(provider.displayName, validation.status),
      status: validation.status,
    });
    return;
  }
  await deps.authService.setApiKey(KIMI_AUTH_PROVIDER_ID, apiKey);
  await writeMutationState(ctx, res, deps);
}

async function signOutProvider(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TerminalModelAuthRouteDeps,
): Promise<void> {
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  await deps.authService.deleteApiKey(KIMI_AUTH_PROVIDER_ID);
  await writeMutationState(ctx, res, deps);
}

async function writeMutationState(
  ctx: FleetPluginServerContext,
  res: http.ServerResponse,
  deps: TerminalModelAuthRouteDeps,
): Promise<void> {
  ctx.host.http.writeJson(res, 200, { state: await buildModelAuthState(deps.authService) });
}

async function findProvider(deps: TerminalModelAuthRouteDeps): Promise<TerminalModelAuthProviderState | null> {
  return (await buildModelAuthState(deps.authService)).providers[0] ?? null;
}

function parseProviderPath(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "providers") return null;
  try {
    return decodeURIComponent(parts[1] ?? "");
  } catch {
    return null;
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function formatSignInFailureMessage(displayName: string, status: string): string {
  if (status === "unauthorized") return `${displayName} rejected the API key. Check the key and try again.`;
  if (status === "forbidden") return `The API key is not allowed for ${displayName}. Check its permissions.`;
  if (status === "timeout") return `Validating the ${displayName} API key timed out.`;
  if (status === "network") return `Could not reach ${displayName} to validate the API key.`;
  if (status === "server") return `${displayName} returned an error while validating the API key.`;
  return `Could not validate the ${displayName} API key.`;
}
