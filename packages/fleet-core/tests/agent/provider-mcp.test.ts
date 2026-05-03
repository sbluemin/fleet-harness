import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveNextToolCall,
  setOnToolCallArrived,
  startMcpServer,
  stopMcpServer,
} from "../../src/admiral/_shared/mcp.js";
import {
  clearAllTools,
  registerToolsForSession,
  removeToolsForSession,
} from "../../src/infra/tool-registry/tool-snapshot.js";

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
      } as any,
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
    expect(String(body.error.message)).toContain("tool call router가 정리");

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
      } as any,
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

  it("배치 요청에 tools/call이 섞여 있어도 헤더를 즉시 반환한다", async () => {
    const token = "test-token-batch-header";
    const callback = vi.fn(() => "call-2");
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      } as any,
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
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          },
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
    expect(body).toHaveLength(2);
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

  it("장시간 tools/call 대기 중 공백 keepalive 후 최종 JSON을 정상 파싱한다", async () => {
    vi.useFakeTimers();

    const token = "test-token-keepalive";
    const callback = vi.fn(() => "call-3");
    const url = await startMcpServer();

    registerToolsForSession(token, [
      {
        name: "custom-tool",
        description: "custom",
        parameters: { type: "object", properties: {} },
      } as any,
    ]);
    setOnToolCallArrived(token, callback);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "custom-tool", arguments: {} },
      }),
    });

    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();

    const firstChunkPromise = reader!.read();
    await vi.advanceTimersByTimeAsync(60_000);

    const firstChunk = await firstChunkPromise;
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toBe(" ");

    resolveNextToolCall(token, "call-3", {
      content: [{ type: "text", text: "slow-ok" }],
      isError: false,
    });

    const chunks = [" "];
    while (true) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      chunks.push(new TextDecoder().decode(chunk.value));
    }

    const body = JSON.parse(chunks.join(""));
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "slow-ok" }],
        isError: false,
      },
    });

    removeToolsForSession(token);
    setOnToolCallArrived(token, null);
  });
});
