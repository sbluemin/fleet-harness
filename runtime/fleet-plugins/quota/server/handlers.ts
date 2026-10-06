import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { QuotaService, QuotaSummaryDto } from "@fleet-console/ai-gateway";

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
  readonly cursorConnected?: unknown;
}

async function readStoredSettings(ctx: FleetPluginServerContext): Promise<StoredSettings> {
  const stored = await ctx.host.storage.readJson("quota", "settings");
  return stored !== null && typeof stored === "object" && !Array.isArray(stored)
    ? stored as StoredSettings
    : {};
}

// 저장 문서에 남길 키의 화이트리스트. 카드 순서·접힘이 없어진 뒤 남은 옛 키(providerOrder·foldedProviders)는
// 다음 쓰기에서 함께 걷힌다. claudeConnected·cursorConnected는 Gateway(ai-gateway host start.ts)도 직접 읽는다.
function retainedSettings(settings: StoredSettings): Record<string, unknown> {
  return {
    ...(typeof settings.claudeConnected === "boolean" ? { claudeConnected: settings.claudeConnected } : {}),
    ...(typeof settings.cursorConnected === "boolean" ? { cursorConnected: settings.cursorConnected } : {}),
  };
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
  const stale = !force && url.searchParams.get("stale") === "1";
  const summary = await service.getSummary({ force, ...(stale ? { stale } : {}) });
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
  ctx.host.http.writeJson(res, 200, summary);
}
