import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractMarkdownLinkTargets, getBacklinks } from "../src/backlinks.js";
import { resolveWorkspaceMemoryPaths } from "../src/paths.js";

const FRONTMATTER = {
  created: "2026-05-04T00:00:00.000Z",
  updated: "2026-05-04T00:00:00.000Z",
  version: 1,
};

describe("backlinks", () => {
  it("extracts markdown link targets", () => {
    expect(extractMarkdownLinkTargets("See [Alpha](alpha.md) and [Beta](nested/beta.md#part).")).toEqual([
      "alpha.md",
      "nested/beta.md#part",
    ]);
  });

  it("counts relative wiki backlinks", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-web-"));
    const paths = resolveWorkspaceMemoryPaths(cwd);
    await mkdir(paths.wikiDir, { recursive: true });
    await writeEntry(paths.wikiDir, "alpha", "Alpha", "Alpha body");
    await writeEntry(paths.wikiDir, "beta", "Beta", "See [Alpha](alpha.md) and [Again](./alpha.md).");

    await expect(getBacklinks("alpha", paths)).resolves.toEqual([
      { id: "beta", title: "Beta", occurrences: 2 },
    ]);
  });
});

async function writeEntry(wikiDir: string, id: string, title: string, body: string): Promise<void> {
  await writeFile(
    path.join(wikiDir, `${id}.md`),
    [
      "---",
      `id: "${id}"`,
      `title: "${title}"`,
      "tags: []",
      `created: "${FRONTMATTER.created}"`,
      `updated: "${FRONTMATTER.updated}"`,
      `version: ${FRONTMATTER.version}`,
      "---",
      body,
    ].join("\n"),
    "utf8",
  );
}
