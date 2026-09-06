import { describe, expect, it } from "vitest";
import { CoworkStore } from "../src/cowork/index.js";

describe("CoworkStore", () => {

  it("rejects stale draft-port writes without changing the revision", async () => {
    const store = new CoworkStore();
    const session = await store.create("workspace", "entry", "before");
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    const port = store.draftPort("workspace", session.id);

    await port.write({ body: "current", expectedRevision: 0 });
    await expect(port.write({ body: "stale", expectedRevision: 0 })).rejects.toThrow("wiki draft revision conflict");
    expect(await port.read()).toEqual({ body: "current", revision: 1 });
  });

  it("serializes overlapping same-revision writes so exactly one wins", async () => {
    const store = new CoworkStore();
    const session = await store.create("workspace", "entry", "before");
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    const port = store.draftPort("workspace", session.id);

    const [first, second] = await Promise.allSettled([
      port.write({ body: "first", expectedRevision: 0 }),
      port.write({ body: "second", expectedRevision: 0 }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(await port.read()).toEqual({ body: "first", revision: 1 });
  });
});
