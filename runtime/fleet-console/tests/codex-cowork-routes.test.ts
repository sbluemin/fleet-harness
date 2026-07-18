import { describe, expect, it } from "vitest";
import { CoworkService } from "../core/host/codex/cowork/service.js";

describe("Cowork DTO", () => {
  it("does not expose provider identity", () => {
    const service = Object.create(CoworkService.prototype) as CoworkService;
    expect(service.dto({ id: "s", workspaceId: "w", entryId: "e", state: "idle", revision: 0, draft: "x", baseHash: "h", baseVersion: 0, selection: null, annotations: [], createdAt: "now", updatedAt: "now", providerSessionId: "/secret" })).not.toHaveProperty("providerSessionId");
  });
});
