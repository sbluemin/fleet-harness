import { describe, expect, it } from "vitest";

import {
  HOST_TERMINAL_UPGRADE_PATH,
  hostEventsUrl,
  hostSocketUrl,
  hostTransportPath,
  isHostByteRequest,
  isHostJsonRequest,
  isHostPresence,
  isHostPresenceRequest,
  isHostTerminalUpgradePath,
  isHostTransportErrorBody,
  parseHostSocketQuery,
  parseHostStreamQuery,
} from "@fleet-console/protocol/remote/host-transport";

const hostKey = "6f1c9a20-1111-4222-8333-444455556666";

describe("host transport wire contract", () => {
  it("requires expectedEpoch on presence and json bodies and rejects a ticket", () => {
    expect(isHostPresenceRequest({ intent: "observe", expectedEpoch: 3 })).toBe(true);
    expect(isHostPresenceRequest({ intent: "activate", epoch: 3 })).toBe(false);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      expectedEpoch: 3,
      method: "POST",
      path: "/api/v1/agent/sessions/op/message",
      json: null,
    })).toBe(true);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      expectedEpoch: 3,
      method: "POST",
      path: "/api/v1/agent/ticket",
      ticket: "secret",
    })).toBe(false);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      epoch: 3,
      method: "GET",
      path: "/api/v1/theaters",
    })).toBe(false);
  });

  it("keeps byte requests free of a caller content type", () => {
    expect(isHostByteRequest({ requestId: "req-1234", expectedEpoch: 2, path: "/api/v1/browser/global/favicon?tab=a" })).toBe(true);
    expect(isHostByteRequest({ requestId: "req-1234", expectedEpoch: 2, path: "/api/v1/browser/global/favicon", contentType: "image/png" })).toBe(false);
  });

  it("builds a socket url without ticket, role, or upgrade path and rejects those queries", () => {
    const url = hostSocketUrl(hostKey, { epoch: 4, channel: "chat", operationId: "op-1" });
    expect(url).toBe(`/api/v1/hosts/${hostKey}/socket?epoch=4&channel=chat&operationId=op-1`);
    expect(url).not.toContain(HOST_TERMINAL_UPGRADE_PATH);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws")).toBe(true);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws?ticket=1")).toBe(false);
    const accepted = new URL(url ?? "http://invalid", "http://127.0.0.1");
    expect(parseHostSocketQuery(accepted.searchParams)?.channel).toBe("chat");
    const tainted = new URLSearchParams("epoch=4&channel=terminal&operationId=op-1&ticket=secret&role=viewer&path=/api/v1/terminal/ws");
    expect(parseHostSocketQuery(tainted)).toBeNull();
  });

  it("requires epoch on event and resource queries and ignores local", () => {
    expect(hostEventsUrl(hostKey, { path: "/api/v1/operations/events", epoch: 1 })).toContain("epoch=1");
    expect(parseHostStreamQuery(new URLSearchParams("path=/api/v1/operations/events"))).toBeNull();
    expect(hostTransportPath("presence", "local")).toBeNull();
    expect(isHostPresence({
      hostKey, epoch: 1, mode: "off", access: null, connection: "blocked", capability: "unsupported",
    })).toBe(true);
    expect(isHostPresence({
      hostKey, epoch: 1, mode: "controller", access: "full", connection: "ready", capability: "unsupported",
    })).toBe(false);
    expect(isHostTransportErrorBody({ error: "stale_epoch", epoch: 9 })).toBe(true);
    expect(isHostTransportErrorBody({ error: "read_only", epoch: 9 })).toBe(false);
  });
});
