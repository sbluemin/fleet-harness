import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import {
  handleGetJob,
  handleInstalledFile,
  handleInstall,
  handleList,
  handlePreview,
  handleRemove,
  handleSearch,
  handleUpdate,
} from "../server/handlers.js";

// ─── mock helpers ─────────────────────────────────────────────────────────────

function makeUnauthorizedCtx(): FleetPluginServerContext {
  return {
    host: {
      security: {
        isTerminalAuthorized: () => false,
      },
      http: {
        writeJson: (res: http.ServerResponse, status: number, body: unknown) => {
          (res as unknown as { _status: number; _body: unknown })._status = status;
          (res as unknown as { _body: unknown })._body = body;
        },
        readJsonBody: async () => ({}),
      },
      paths: {
        resolveTheaterPath: () => null,
      },
    },
  } as unknown as FleetPluginServerContext;
}

function makeReq(method: string, url: string): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost" },
  } as unknown as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & { _status?: number; _body?: unknown } {
  return {} as http.ServerResponse & { _status?: number; _body?: unknown };
}

// ─── 401 tests ───────────────────────────────────────────────────────────────

const unauthorizedCtx = makeUnauthorizedCtx();

describe("미인가 요청 401", () => {
  it("handleList → 401", async () => {
    const res = makeRes();
    await handleList(makeReq("GET", "/plugins/skills/list"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleSearch → 401", async () => {
    const res = makeRes();
    await handleSearch(makeReq("GET", "/plugins/skills/search?q=ts"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleInstall → 401", async () => {
    const res = makeRes();
    await handleInstall(makeReq("POST", "/plugins/skills/install"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleUpdate → 401", async () => {
    const res = makeRes();
    await handleUpdate(makeReq("POST", "/plugins/skills/update"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleGetJob → 401", async () => {
    const res = makeRes();
    await handleGetJob(makeReq("GET", "/plugins/skills/jobs?jobId=x"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleRemove → 401", async () => {
    const res = makeRes();
    await handleRemove(makeReq("POST", "/plugins/skills/remove"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handlePreview → 401", async () => {
    const res = makeRes();
    await handlePreview(makeReq("POST", "/plugins/skills/preview"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });

  it("handleInstalledFile → 401", async () => {
    const res = makeRes();
    await handleInstalledFile(makeReq("POST", "/plugins/skills/installed-file"), res, unauthorizedCtx);
    expect(res._status).toBe(401);
  });
});
