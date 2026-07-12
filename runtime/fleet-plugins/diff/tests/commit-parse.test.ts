import { describe, expect, it } from "vitest";

import { parseCommitMeta } from "../server/commit.js";
import { parseDiffFileList } from "../server/diff.js";

describe("commit inspector server parsers", () => {
  it("parses NUL-delimited metadata, multiline body, and parents", () => {
    expect(parseCommitMeta(["Ada", "ada@example.test", "1720000000", "subject", "aaa bbb", "body line 1\nbody line 2\n"].join("\0"))).toEqual({
      authorName: "Ada", authorEmail: "ada@example.test", authorAt: 1720000000, subject: "subject", body: "body line 1\nbody line 2",
      parents: [{ full: "aaa", short: "aaa" }, { full: "bbb", short: "bbb" }],
    });
  });

  it("preserves rename oldPath and numstat counts", () => {
    expect(parseDiffFileList("R100\told.ts\tnew.ts\n", "3\t2\told.ts => new.ts\n")).toEqual([{ path: "new.ts", oldPath: "old.ts", status: "R", additions: 3, deletions: 2 }]);
    expect(parseDiffFileList("R100\told.ts\tnew.ts\n", "3\t2\told.ts\tnew.ts\n")[0]?.path).toBe("new.ts");
  });
});
