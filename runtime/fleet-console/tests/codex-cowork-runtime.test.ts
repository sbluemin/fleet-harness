import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCoworkMcpRuntime } from "../core/host/codex/cowork/runtime.js";
import { CoworkStore } from "../core/host/codex/cowork/store.js";

describe("Cowork MCP runtime", () => {
  it("defaults to the seven-tool, host-file-denied connection", async () => {
    const store = new CoworkStore(await mkdtemp(join(tmpdir(), "cowork-"))); const session = await store.create("workspace", "entry", "draft");
    const runtime = createCoworkMcpRuntime(store, "workspace", session.id);
    expect(runtime.allowedToolIds).toHaveLength(7);
    expect(runtime.connection).toEqual({ strictMcp: true, yoloMode: false, autoApprove: false, hostFileAccess: "deny" });
  });
});
