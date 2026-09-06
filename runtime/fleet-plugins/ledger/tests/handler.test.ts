import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { handleSummary } from "../server/handler.js";
import type { LedgerService } from "../server/service.js";

function harness(url: string, method = "GET", authorized = true) {
  const writes: Array<{ status: number; payload: unknown }> = [];
  const getSummary = vi.fn();
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => authorized },
      http: { writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }) },
    },
  } as unknown as FleetPluginServerContext;
  const req = { method, url, headers: { host: "localhost" } } as IncomingMessage;
  const res = {} as ServerResponse;
  const service = { getSummary } as unknown as LedgerService;
  return { writes, getSummary, ctx, req, res, service };
}

describe("handleSummary", () => {
  it("rejects non-GET methods before calling the service", async () => {
    const test = harness("/plugins/ledger/summary", "POST");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 405, payload: { error: "method_not_allowed" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });

  it("requires terminal authorization", async () => {
    const test = harness("/plugins/ledger/summary", "GET", false);
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });
});
