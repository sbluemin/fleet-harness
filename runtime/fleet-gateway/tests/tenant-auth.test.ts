import { describe, expect, it } from "vitest";

import { createGatewayTenantStore } from "../src/tenant-store.js";

describe("gateway tenant auth", () => {
  it("creates isolated token classes", () => {
    const store = createGatewayTenantStore({
      randomId: () => `id-${Math.random()}`,
      randomToken: () => `token-${Math.random()}`,
    });

    const registered = store.registerTenant({
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    }, "http://127.0.0.1:1/mcp");

    expect(store.lookupToken(registered.controlToken)?.kind).toBe("control");
    expect(store.lookupToken(registered.sessionToken)?.kind).toBe("session");
    expect(store.lookupToken(registered.observerToken)?.kind).toBe("observer");
    expect(store.lookupToken("missing")).toBeNull();
  });
});
