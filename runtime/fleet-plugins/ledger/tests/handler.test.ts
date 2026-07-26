import type { IncomingMessage, ServerResponse } from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { handleSummary } from "../server/handler.js";
import type { LedgerService } from "../server/service.js";

function harness(url: string) {
  const writes: Array<{ status: number; payload: unknown }> = [];
  const getSummary = vi.fn();
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: (id: string) => id === "known" ? "/absolute/theater" : null },
      operations: { list: () => [] },
      http: { writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }) },
    },
  } as unknown as FleetPluginServerContext;
  const req = { method: "GET", url, headers: { host: "localhost" } } as IncomingMessage;
  const res = {} as ServerResponse;
  const service = { getSummary } as unknown as LedgerService;
  return { writes, getSummary, ctx, req, res, service };
}

describe("handleSummary", () => {
  it("rejects prototype property names as invalid windows", async () => {
    const test = harness("/plugins/ledger/summary?window=toString");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 400, payload: { error: "invalid_window" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });

  it("validates a theater without passing its path to the service", async () => {
    const test = harness("/plugins/ledger/summary?theaterId=known&window=month&refresh=1");
    test.getSummary.mockResolvedValue({ schemaVersion: 1 });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.getSummary).toHaveBeenCalledWith(expect.objectContaining({
      theaterId: "known",
      window: "month",
      refresh: true,
    }));
    expect(test.getSummary.mock.calls[0]?.[0]).not.toHaveProperty("theaterPath");
    expect(test.writes[0]?.status).toBe(200);
  });

  it("keeps returning 404 for an unknown theater", async () => {
    const test = harness("/plugins/ledger/summary?theaterId=missing&window=week");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 404, payload: { error: "theater_not_found" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty theaterId", async () => {
    const test = harness("/plugins/ledger/summary?theaterId=&window=week");
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.writes).toEqual([{ status: 400, payload: { error: "invalid_theater_id" } }]);
    expect(test.getSummary).not.toHaveBeenCalled();
  });

  it("defaults the window to week when omitted", async () => {
    const test = harness("/plugins/ledger/summary");
    test.getSummary.mockResolvedValue({ schemaVersion: 1 });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.getSummary).toHaveBeenCalledWith(expect.objectContaining({ window: "week" }));
  });

  it.each([
    ["1", true],
    ["true", false],
    ["01", false],
    ["", false],
  ])("treats refresh=%s as %s", async (value, expected) => {
    const test = harness(`/plugins/ledger/summary?refresh=${value}`);
    test.getSummary.mockResolvedValue({ schemaVersion: 1 });
    await handleSummary(test.req, test.res, test.ctx, test.service);
    expect(test.getSummary).toHaveBeenCalledWith(expect.objectContaining({ refresh: expected }));
  });
});
