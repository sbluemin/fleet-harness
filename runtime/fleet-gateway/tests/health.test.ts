import { describe, expect, it } from "vitest";

import { createGatewayHealthClient } from "../src/health.js";

describe("gateway health client", () => {
  it("returns unhealthy when the lock is missing", async () => {
    await expect(createGatewayHealthClient().probe(null)).resolves.toMatchObject({ healthy: false, lock: null });
  });
});
