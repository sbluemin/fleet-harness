import { ApiError } from "./api.js";
import type { ApiCatalogEntry } from "./types.js";

interface ApiCatalogResponse {
  readonly version: unknown;
  readonly routes: unknown;
}

export async function fetchApiCatalog(signal?: AbortSignal): Promise<readonly ApiCatalogEntry[]> {
  const response = await fetch("/settings/api-catalog", { signal });
  await assertOk(response);
  return assertApiCatalogResponse(await response.json(), response.status).routes;
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new ApiError(response.status, message);
}

function assertApiCatalogResponse(value: unknown, status: number): { readonly routes: readonly ApiCatalogEntry[] } {
  const payload = value as Partial<ApiCatalogResponse>;
  if (!payload || typeof payload !== "object" || !("version" in payload) || !Array.isArray(payload.routes)) {
    throw new ApiError(status, "Invalid backend API catalog response");
  }
  return { routes: payload.routes.map((route) => assertApiCatalogEntry(route, status)) };
}

function assertApiCatalogEntry(value: unknown, status: number): ApiCatalogEntry {
  const entry = value as Partial<ApiCatalogEntry>;
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.method !== "string" ||
    typeof entry.path !== "string" ||
    typeof entry.summary !== "string" ||
    typeof entry.category !== "string" ||
    typeof entry.gate !== "string"
  ) {
    throw new ApiError(status, "Invalid backend API catalog entry");
  }
  return {
    method: entry.method,
    path: entry.path,
    summary: entry.summary,
    category: entry.category,
    gate: entry.gate,
  };
}
