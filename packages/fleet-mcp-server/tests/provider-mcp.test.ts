import http from "node:http";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAllTools,
  getToolsForSession,
  hasPendingToolCall,
  registerToolsForSession,
  removeToolsForSession,
  resolveNextToolCall,
  setOnToolCallArrived,
  startMcpServer,
  stopMcpServer,
} from "../src/index.js";

describe("provider-mcp", () => {
  beforeEach(() => {
    clearAllTools();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await stopMcpServer();
  });

  it("router가 정리된 세션의 늦은 tools/call을 즉시 거부한다", async () => {
    const token = "test-token-router-detached";
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      },
    ]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "custom-tool", arguments: {} },
      }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error.code).toBe(-32000);
    expect(String(body.error.message)).toContain("router");

    removeToolsForSession(token);
    setOnToolCallArrived(token, null);
  });

  it("tools/call은 결과 전에도 헤더를 즉시 반환한다", async () => {
    const token = "test-token-immediate-header";
    const callback = vi.fn(() => "call-1");
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      },
    ]);
    setOnToolCallArrived(token, callback);

    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "custom-tool", arguments: {} },
        }),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("헤더가 즉시 반환되지 않았습니다")), 250);
      }),
    ]);

    expect(response.status).toBe(200);
    expect(callback).toHaveBeenCalledTimes(1);

    resolveNextToolCall(token, "call-1", {
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    const body = await response.json();
    expect(body.result).toEqual({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    removeToolsForSession(token);
    setOnToolCallArrived(token, null);
  });

  it("client disconnect 시 held tools/call pending entry를 정리한다", async () => {
    const token = "test-token-close-cleanup";
    const callback = vi.fn(() => "call-close");
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      },
    ]);
    setOnToolCallArrived(token, callback);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const req = http.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }, (res) => {
        expect(res.statusCode).toBe(200);
        settled = true;
        res.destroy();
        resolve();
      });
      req.on("error", (error) => {
        if (!settled) reject(error);
      });
      req.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "custom-tool", arguments: {} },
      }));
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(hasPendingToolCall(token)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hasPendingToolCall(token)).toBe(false);

    removeToolsForSession(token);
    setOnToolCallArrived(token, null);
  });

  it("배치 요청에 tools/call이 섞여 있어도 헤더를 즉시 반환한다", async () => {
    const token = "test-token-batch-header";
    const callback = vi.fn(() => "call-2");
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      },
    ]);
    setOnToolCallArrived(token, callback);

    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "custom-tool", arguments: {} },
          },
        ]),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("배치 헤더가 즉시 반환되지 않았습니다")), 250);
      }),
    ]);

    expect(response.status).toBe(200);
    expect(callback).toHaveBeenCalledTimes(1);

    resolveNextToolCall(token, "call-2", {
      content: [{ type: "text", text: "batch-ok" }],
      isError: false,
    });

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({
        id: 2,
        result: {
          content: [{ type: "text", text: "batch-ok" }],
          isError: false,
        },
      }),
    ]));

    removeToolsForSession(token);
    setOnToolCallArrived(token, null);
  });

  it("pre-queued result와 token auth, stop/restart를 보존한다", async () => {
    const firstUrl = await startMcpServer();
    const token = "test-token-prequeue";
    const callback = vi.fn(() => "call-pre");

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      },
    ]);
    setOnToolCallArrived(token, callback);

    resolveNextToolCall(token, "call-pre", {
      content: [{ type: "text", text: "pre-ok" }],
      isError: false,
    });

    const unauthorized = await fetch(firstUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(firstUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "custom-tool", arguments: {} },
      }),
    });
    const body = await response.json();
    expect(body.result.content[0].text).toBe("pre-ok");

    await stopMcpServer();
    const secondUrl = await startMcpServer();
    expect(secondUrl).not.toBe(firstUrl);
  });

  it("body size cap 초과 요청은 413으로 거부한다", async () => {
    const url = await startMcpServer();
    const token = "test-token-body-cap";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "x".repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
  });

  it("stopMcpServer는 session tool snapshot을 전역 정리한다", async () => {
    const token = "test-token-stop-clears-snapshot";
    await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "stale-tool",
        description: "stale",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(getToolsForSession(token)).toHaveLength(1);

    await stopMcpServer();

    expect(getToolsForSession(token)).toHaveLength(0);
  });
});
