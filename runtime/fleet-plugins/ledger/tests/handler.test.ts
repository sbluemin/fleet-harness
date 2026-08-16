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

  it.each(["toString", "", "quarter"])("rejects invalid explicit window %s", async (window) => {
    const test = harness(`/plugins/ledger/summary?window=${window}`);
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 400, payload: { error: "invalid_window" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });

  it("defaults to week and passes only window plus refresh", async () => {
    const test = harness("/plugins/ledger/summary?theaterId=ignored");
    test.getSummary.mockResolvedValue({ schemaVersion: 2 });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.getSummary).toHaveBeenCalledWith({ window: "week", refresh: false });
    expect(test.writes).toEqual([{ status: 200, payload: { schemaVersion: 2 } }]);
  });

  it.each([
    ["1", true],
    ["true", false],
    ["01", false],
    ["", false],
  ])("treats refresh=%s as %s", async (value, expected) => {
    const test = harness(`/plugins/ledger/summary?window=month&refresh=${value}`);
    test.getSummary.mockResolvedValue({ schemaVersion: 2 });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.getSummary).toHaveBeenCalledWith({ window: "month", refresh: expected });
  });
});
