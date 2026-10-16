import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService, QuotaSummaryDto } from "@fleet-console/ai-gateway";

import { isProviderId, type LoginProvider } from "../provider-order.js";

export { LOGIN_PROVIDERS, type LoginProvider } from "../provider-order.js";

export type SettingsSerializer = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Gateway quota 라우트를 읽는 창구. `stale`이면 만료된 캐시라도 먼저 받고, 그렇게 받은 응답은
 * `revalidating`으로 갱신이 뒤에서 돌고 있음을 알린다 — 공유 DTO가 아니라 이 응답에만 있다.
 */
export interface QuotaSummarySource {
  getSummary(options?: NonNullable<Parameters<QuotaService["getSummary"]>[0]> & { readonly stale?: boolean }):
    Promise<GatewayQuotaSummary>;
}

export type GatewayQuotaSummary = QuotaSummaryDto & { readonly revalidating?: boolean };

interface StoredSettings {
  readonly claudeConnected?: unknown;
}

async function readStoredSettings(ctx: FleetPluginServerContext): Promise<StoredSettings> {
  const stored = await ctx.host.storage.readJson("quota", "settings");
  return stored !== null && typeof stored === "object" && !Array.isArray(stored)
    ? stored as StoredSettings
    : {};
}

// 저장 문서에 남길 키의 화이트리스트. 카드 순서·접힘이 없어진 뒤 남은 옛 키(providerOrder·foldedProviders)와
// Cursor가 Console 로그인으로 바뀐 뒤의 cursorConnected는 다음 쓰기에서 함께 걷힌다.
// claudeConnected는 Gateway(ai-gateway host start.ts)도 직접 읽는다.
function retainedSettings(settings: StoredSettings): Record<string, unknown> {
  return typeof settings.claudeConnected === "boolean" ? { claudeConnected: settings.claudeConnected } : {};
}

function rejectUnlessJsonPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): boolean {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return true;
  }
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  if (mediaType !== "application/json") {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return true;
  }
  return false;
}

export async function handleSummary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaSummarySource,
): Promise<void> {
  if (req.method !== "GET") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const force = url.searchParams.get("force") === "1";
  // 한 공급자만 강제로 다시 읽는다(로그인 직후). 알 수 없는 id는 무시해 평소 읽기로 둔다.
  const requested = url.searchParams.get("forceProvider");
  const forceProvider = !force && isProviderId(requested) ? requested : undefined;
  const stale = !force && forceProvider === undefined && url.searchParams.get("stale") === "1";
  const summary = await service.getSummary({
    force,
    ...(forceProvider !== undefined ? { forceProvider } : {}),
    ...(stale ? { stale } : {}),
  });
  ctx.host.http.writeJson(res, 200, summary);
}

export async function handleConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaSummarySource,
  serializeSettings: SettingsSerializer,
): Promise<void> {
  if (rejectUnlessJsonPost(req, res, ctx)) return;
  let body: { readonly provider?: unknown; readonly connected?: unknown } | null;
  try {
    body = await ctx.host.http.readJsonBody(req);
  } catch {
    body = null;
  }
  if (
    !body
    || Object.keys(body).length !== 2
    || body.provider !== "claude"
    || typeof body.connected !== "boolean"
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_connect_request" });
    return;
  }
  await serializeSettings(async () => {
    const next = {
      ...retainedSettings(await readStoredSettings(ctx)),
      claudeConnected: body.connected,
    };
    await ctx.host.storage.writeJson("quota", "settings", next);
  });
  const summary = await service.getSummary({ forceProvider: body.provider });
  ctx.host.http.writeJson(res, 200, summary);
}

export type LoginAction = "start" | "status" | "cancel" | "logout";

/**
 * Console이 소유하는 로그인 라우트(`/api/v1/ai-gateway/oauth/<provider>/*`)로 가는 창구.
 * 플러그인은 자격·device code·폴링을 갖지 않고 Gateway의 응답(상태 코드와 공개 DTO)을 그대로 옮긴다.
 */
export interface LoginGateway {
  call(
    provider: LoginProvider,
    action: LoginAction,
    request: { readonly loginId?: string; readonly body?: Record<string, unknown> },
  ): Promise<{ readonly status: number; readonly payload: unknown }>;
}

const LOGIN_ID_MAX = 128;

function isLoginId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LOGIN_ID_MAX;
}

/**
 * quota 패널의 로그인 카드가 부르는 라우트. status만 GET이고 나머지는 JSON POST다.
 * 로그아웃은 Gateway가 기록한 미로그인 상태가 담긴 요약을 함께 돌려줘 카드가 곧바로 바뀐다.
 */
export async function handleProviderLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  provider: LoginProvider,
  action: LoginAction,
  gateway: LoginGateway,
  service: QuotaSummarySource,
): Promise<void> {
  let request: { readonly loginId?: string; readonly body?: Record<string, unknown> };
  if (action === "status") {
    if (req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const loginId = new URL(req.url ?? "/", "http://localhost").searchParams.get("loginId");
    if (!isLoginId(loginId)) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_login_id" });
      return;
    }
    request = { loginId };
  } else {
    if (rejectUnlessJsonPost(req, res, ctx)) return;
    let body: Record<string, unknown> | null;
    try {
      body = await ctx.host.http.readJsonBody(req);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_login_request" });
      return;
    }
    const fields = Object.keys(body);
    if (action === "cancel") {
      if (fields.length !== 1 || !isLoginId(body.loginId)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_login_id" });
        return;
      }
      request = { body: { loginId: body.loginId } };
    } else {
      if (fields.length !== 0) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_login_request" });
        return;
      }
      request = { body: {} };
    }
  }
  let result: { readonly status: number; readonly payload: unknown };
  try {
    result = await gateway.call(provider, action, request);
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "login_unavailable" });
    return;
  }
  if (action === "logout" && result.status === 200) {
    ctx.host.http.writeJson(res, 200, await service.getSummary());
    return;
  }
  ctx.host.http.writeJson(res, result.status, result.payload);
}
