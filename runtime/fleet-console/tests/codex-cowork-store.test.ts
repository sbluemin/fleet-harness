import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoworkStore } from "../core/host/codex/cowork/store.js";

describe("CoworkStore", () => {
  it("persists a monotonic session draft without provider identity", async () => {
    const store = new CoworkStore(await mkdtemp(join(tmpdir(), "cowork-")));
    const session = await store.create("workspace", "entry", "before");
    await store.draftPort("workspace", session.id).write({ body: "after", expectedRevision: 0 });
    expect(await store.draftPort("workspace", session.id).read()).toEqual({ body: "after", revision: 1 });
  });
});
