import { describe, expect, it } from "vitest";

import { createGatewayDaemonLifecycle } from "../src/cli.js";

describe("gateway daemon lifecycle", () => {
  it("constructs explicit lifecycle methods", () => {
    const lifecycle = createGatewayDaemonLifecycle({ env: { FLEET_GATEWAY_DIR: "/tmp/fleet-gateway-test" }, serverModulePath: "/tmp/server.mjs" });

    expect(typeof lifecycle.ensureDaemon).toBe("function");
    expect(typeof lifecycle.probe).toBe("function");
    expect(typeof lifecycle.stop).toBe("function");
  });
});
