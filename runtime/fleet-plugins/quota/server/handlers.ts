import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService } from "@dotobokuri/core-ai-gateway";

import {
  isProviderId,
  PROVIDER_ORDER_DEFAULT,
  sanitizeFoldedProviders,
  sanitizeProviderOrder,
  type ProviderId,
} from "../provider-order.js";

export type SettingsSerializer = <T>(operation: () => Promise<T>) => Promise<T>;
export { PROVIDER_ORDER_DEFAULT, sanitizeFoldedProviders, sanitizeProviderOrder };
export type { ProviderId as OrderableProviderId };

interface StoredSettings {
  readonly claudeConnected?: unknown;
  readonly cursorConnected?: unknown;
  readonly providerOrder?: unknown;
  readonly foldedProviders?: unknown;
}

async function readStoredSettings(ctx: FleetPluginServerContext): Promise<StoredSettings> {
  const stored = await ctx.host.storage.readJson("quota", "settings");
  return stored !== null && typeof stored === "object" && !Array.isArray(stored)
    ? stored as StoredSettings
    : {};
}

// 이 화이트리스트는 저장 경로가 늘 때마다 함께 늘어야 한다. 한 키라도 빠지면 다른
// 경로의 저장이 그 설정을 조용히 지운다 — 카드를 한 번 끌어다 놓는 순간 접힘이 사라진다.
function retainedSettings(settings: StoredSettings): Record<string, unknown> {
  return {
    ...(typeof settings.claudeConnected === "boolean" ? { claudeConnected: settings.claudeConnected } : {}),
    ...(typeof settings.cursorConnected === "boolean" ? { cursorConnected: settings.cursorConnected } : {}),
    ...(Array.isArray(settings.providerOrder) ? { providerOrder: sanitizeProviderOrder(settings.providerOrder) } : {}),
    ...(Array.isArray(settings.foldedProviders) ? { foldedProviders: sanitizeFoldedProviders(settings.foldedProviders) } : {}),
  };
}

/** summary 계열 응답이 코어 DTO에 얹어 보내는 플러그인 소유 설정. */
async function panelSettings(ctx: FleetPluginServerContext): Promise<{
  readonly providerOrder: ProviderId[];
  readonly foldedProviders: ProviderId[];
}> {
  const stored = await readStoredSettings(ctx);
  return {
    providerOrder: sanitizeProviderOrder(stored.providerOrder),
    foldedProviders: sanitizeFoldedProviders(stored.foldedProviders),
  };
}

export async function handleSummary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaService,
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
  const summary = await service.getSummary({ force: url.searchParams.get("force") === "1" });
  ctx.host.http.writeJson(res, 200, { ...summary, ...(await panelSettings(ctx)) });
}

export async function handleConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaService,
  serializeSettings: SettingsSerializer,
): Promise<void> {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  if (mediaType !== "application/json") {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  let body: { readonly provider?: unknown; readonly connected?: unknown } | null;
  try {
    body = await ctx.host.http.readJsonBody(req);
  } catch {
    body = null;
  }
  if (
    !body
    || Object.keys(body).length !== 2
    || (body.provider !== "claude" && body.provider !== "cursor")
    || typeof body.connected !== "boolean"
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_connect_request" });
    return;
  }
  await serializeSettings(async () => {
    const next = {
      ...retainedSettings(await readStoredSettings(ctx)),
      ...(body.provider === "claude"
        ? { claudeConnected: body.connected }
        : { cursorConnected: body.connected }),
    };
    await ctx.host.storage.writeJson("quota", "settings", next);
  });
  const summary = await service.getSummary({ forceProvider: body.provider });
  ctx.host.http.writeJson(res, 200, { ...summary, ...(await panelSettings(ctx)) });
}

export async function handleOrder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  serializeSettings: SettingsSerializer,
): Promise<void> {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  if (mediaType !== "application/json") {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  let body: { readonly order?: unknown } | null;
  try {
    body = await ctx.host.http.readJsonBody(req);
  } catch {
    body = null;
  }
  // 클라이언트는 항상 현재 공급자 id의 완전한 순열을 보낸다. 그보다 느슨한 입력은
  // 버그의 증거이므로 관용하지 않는다 — 미래 호환의 관용은 읽기 쪽 sanitize가 담당한다.
  const order = body?.order;
  if (
    !body
    || Object.keys(body).length !== 1
    || !Array.isArray(order)
    || order.length !== PROVIDER_ORDER_DEFAULT.length
    || !order.every(isProviderId)
    || new Set(order).size !== order.length
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_order_request" });
    return;
  }
  const providerOrder = order as ProviderId[];
  await serializeSettings(async () => {
    const next = {
      ...retainedSettings(await readStoredSettings(ctx)),
      providerOrder,
    };
    await ctx.host.storage.writeJson("quota", "settings", next);
  });
  ctx.host.http.writeJson(res, 200, { providerOrder });
}

export async function handleFold(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  serializeSettings: SettingsSerializer,
): Promise<void> {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  if (mediaType !== "application/json") {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  let body: { readonly folded?: unknown } | null;
  try {
    body = await ctx.host.http.readJsonBody(req);
  } catch {
    body = null;
  }
  // 순서와 달리 접힘은 부분집합이다 — 완전한 순열을 요구하면 "아무것도 접지 않음"을
  // 보낼 길이 없다. 대신 알려진 id만, 중복 없이, 전체 수를 넘지 않게 받는다.
  const folded = body?.folded;
  if (
    !body
    || Object.keys(body).length !== 1
    || !Array.isArray(folded)
    || folded.length > PROVIDER_ORDER_DEFAULT.length
    || !folded.every(isProviderId)
    || new Set(folded).size !== folded.length
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_fold_request" });
    return;
  }
  const foldedProviders = sanitizeFoldedProviders(folded);
  await serializeSettings(async () => {
    const next = {
      ...retainedSettings(await readStoredSettings(ctx)),
      foldedProviders,
    };
    await ctx.host.storage.writeJson("quota", "settings", next);
  });
  ctx.host.http.writeJson(res, 200, { foldedProviders });
}
