import { describe, expect, it } from "vitest";

import { createWikiDraftToolSpecs, type WikiDraftPort, type WikiDraftSnapshot } from "../src/tools/draft.js";

class MemoryDraftPort implements WikiDraftPort {
  #snapshot: WikiDraftSnapshot;

  constructor(body: string, revision = 0) {
    this.#snapshot = { body, revision };
  }

  async read(): Promise<WikiDraftSnapshot> {
    return this.#snapshot;
  }

  async write({ body, expectedRevision }: { body: string; expectedRevision?: number }): Promise<WikiDraftSnapshot> {
    if (expectedRevision !== undefined && expectedRevision !== this.#snapshot.revision) {
      throw new Error(`[test] revision conflict: expected ${expectedRevision}, current ${this.#snapshot.revision}`);
    }
    this.#snapshot = { body, revision: this.#snapshot.revision + 1 };
    return this.#snapshot;
  }
}

describe("Cowork Wiki draft tools", () => {
  it("is closure-scoped to one injected draft port and exposes only the three private IDs", async () => {
    const first = createWikiDraftToolSpecs({ draft: new MemoryDraftPort("first") });
    const second = createWikiDraftToolSpecs({ draft: new MemoryDraftPort("second") });

    expect(first.map((spec) => spec.id)).toEqual(["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write"]);
    await first[2]!.execute({ body: "changed" }, { cwd: "/ignored" });

    await expect(readBody(first)).resolves.toBe("changed");
    await expect(readBody(second)).resolves.toBe("second");
  });

  it("uses revision CAS for exact edits and monotonic revisions for writes", async () => {
    const specs = createWikiDraftToolSpecs({ draft: new MemoryDraftPort("one two one", 4) });
    const edit = specs[1]!;
    const write = specs[2]!;

    await expect(edit.execute({ find: "one", replace: "ONE", expected_occurrences: 2, expected_revision: 4 }, { cwd: "/ignored" }))
      .resolves.toMatchObject({ isError: false });
    await expect(readBody(specs)).resolves.toBe("ONE two ONE");
    await expect(edit.execute({ find: "ONE", replace: "one", expected_revision: 4 }, { cwd: "/ignored" }))
      .rejects.toThrow(/revision conflict/);
    await expect(write.execute({ body: "whole", expected_revision: 5 }, { cwd: "/ignored" }))
      .resolves.toMatchObject({ isError: false });
    await expect(readPayload(specs)).resolves.toMatchObject({ body: "whole", revision: 6 });
  });

  it("rejects occurrence mismatches and schemas expose no host-selection fields", async () => {
    const specs = createWikiDraftToolSpecs({ draft: new MemoryDraftPort("repeat repeat") });
    const edit = specs[1]!;

    await expect(edit.execute({ find: "repeat", replace: "changed" }, { cwd: "/ignored" }))
      .rejects.toThrow(/occurrence mismatch: expected 1, found 2/);
    await expect(edit.execute({ find: "missing", replace: "changed", expected_occurrences: 1 }, { cwd: "/ignored" }))
      .rejects.toThrow(/occurrence mismatch: expected 1, found 0/);

    for (const spec of specs) {
      const properties = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      for (const forbidden of ["path", "entry_id", "entryId", "workspace_id", "workspaceId", "session_id", "sessionId"]) {
        expect(properties).not.toHaveProperty(forbidden);
      }
    }
    await expect(specs[0]!.execute({ session_id: "forbidden" }, { cwd: "/ignored" })).rejects.toThrow(/does not accept session_id/);
  });
});

async function readPayload(specs: ReturnType<typeof createWikiDraftToolSpecs>): Promise<Record<string, unknown>> {
  const result = await specs[0]!.execute({}, { cwd: "/ignored" });
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function readBody(specs: ReturnType<typeof createWikiDraftToolSpecs>): Promise<string> {
  return (await readPayload(specs)).body as string;
}
