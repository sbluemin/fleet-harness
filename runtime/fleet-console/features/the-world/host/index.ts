import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { HttpPort, HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { z } from "zod";

import {
  THE_WORLD_METRICS_PATH,
  type WorldMetricsResponse,
} from "../shared/world-metrics-contract.js";
import {
  createTheaterMetricsScanner,
  type TheaterMetricsScannerOptions,
  type TheaterScanTarget,
} from "./theater-metrics.js";

/**
 * 「더 월드 (The World)」 호스트 피처.
 *
 * `features/commodore/host` 내부를 직접 import하지 않고, 코어가 명시적으로 주입한
 * `listCommodoreTheaters` 포트를 통해 Theater 지표만 집계한다.
 * 브라우저 응답 DTO에는 원시 파일시스템 경로를 절대 싣지 않는다.
 */

export const THE_WORLD_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: THE_WORLD_METRICS_PATH,
    summary: "Read cached file and folder development metrics for Commodore Theaters in The World.",
    category: "The World",
    gate: "origin-write",
    transport: "http",
  },
];

export interface TheWorldFeatureDeps {
  /** 사령관별 배정 Theater 좌표 조회 포트(코어가 commodore ownership에서 주입). */
  readonly listCommodoreTheaters: (commodoreId?: string) => readonly TheaterScanTarget[];
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  readonly scanner?: TheaterMetricsScannerOptions;
}

const metricsQuerySchema = z.object({
  commodoreId: z.string().min(1).max(128).optional(),
  refresh: z.enum(["0", "1"]).optional(),
}).strict();

export function createTheWorldFeature(deps: TheWorldFeatureDeps) {
  const scanner = createTheaterMetricsScanner(deps.scanner);

  const handleMetrics: RouteHandler = async ({ req, res, pathname }) => {
    if (pathname !== THE_WORLD_METRICS_PATH) return false;
    if (req.method !== "GET") {
      deps.http.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!deps.security.isTerminalAuthorized(req)) {
      deps.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }

    const url = new URL(req.url ?? THE_WORLD_METRICS_PATH, "http://localhost");
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = metricsQuerySchema.safeParse(rawParams);
    if (!parsed.success) {
      deps.http.writeJson(res, 400, { error: "invalid_request" });
      return true;
    }

    const targets = deps.listCommodoreTheaters(parsed.data.commodoreId);
    const metrics = await scanner.scanTargets(targets, {
      refresh: parsed.data.refresh === "1",
    });
    const response: WorldMetricsResponse = {
      metrics,
      generatedAt: Date.now(),
    };
    deps.http.writeJson(res, 200, response);
    return true;
  };

  const routes: readonly {
    readonly path: string;
    readonly handler: RouteHandler;
    readonly catalog: readonly ApiCatalogEntry[];
  }[] = [
    {
      path: THE_WORLD_METRICS_PATH,
      handler: handleMetrics,
      catalog: THE_WORLD_API_CATALOG,
    },
  ];

  return {
    routes,
    invalidatePath: scanner.invalidatePath,
    dispose: scanner.dispose,
  };
}

export type TheWorldFeature = ReturnType<typeof createTheWorldFeature>;
