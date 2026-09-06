import { appendFile, mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TranscriptIndexer } from "../src/transcript-indexer.js";

const fixtures = new URL("./fixtures/", import.meta.url);

describe("TranscriptIndexer", () => {
  it("indexes Claude user, assistant blocks, tool result, unknown, and ignores malformed input", async () => {
    const file = await copyFixture("claude-session.jsonl");
    const indexer = new TranscriptIndexer(file);
    await indexer.refresh();

    expect(indexer.all.map((event) => [event.kind, event.summary, event.targetPath])).toEqual([
      ["message", "Inspect the change", undefined],
      ["message", "I will inspect the implementation.", undefined],
      ["message", "Need locate the changed file.", undefined],
      ["file", "Read", "src/example.ts"],
      ["tool", "export const value = 1;", undefined],
      ["message", "harmless unknown", undefined],
    ]);
    expect(indexer.outline()).toMatchObject({ eventCount: 6, fileTouchCount: 1, stages: ["user", "assistant"] });
  });

  it("redacts sensitive transcript forms while preserving prose and repository-relative paths", async () => {
    const indexer = new TranscriptIndexer(await copyFixture("redaction-cases.jsonl"));
    await indexer.refresh();

    const exposed = indexer.all.map((event) => event.summary).join("\n");
    for (const secret of [
      "hunter-two", "legacy-pass", "db-pass", "service-secret-value", "access-token-value",
      "cloud-credential-value", "private-key-value", "provider-session-value", "dXNlcjpwYXNzd29yZA==",
      "private-key-material", "eyJhbGciOiJIUzI1NiJ9", "cookie-secret", "set-cookie-secret",
      "ses_providerSecret42", "sess-providerSecret43", "/etc/ssh/sshd_config",
      "/workspace/repo/src/a.ts", "/mnt/data/capture.jsonl", "/srv/team files/report.md",
      "openai-secret-value", "aws-secret-value", "client-secret-value",
    ]) expect(exposed).not.toContain(secret);
    expect(exposed).toContain("packages/fleet-analyst/src/session.ts");
    expect(exposed).toContain("packages/fleet-analyst/src/tools.ts");
    expect(exposed).toContain("./scripts/build.sh");
    expect(exposed).toContain("and/or");
    expect(exposed).toContain("24/7");
    expect(exposed).toContain("TURKEY=bird");
    expect(exposed).toContain("primary_key=id");
    expect(exposed).toContain("https://example.com/a/b");
    expect(exposed).toContain("The session analysis is ordinary prose.");
    expect(exposed).toContain("[REDACTED_PEM_KEY]");
    expect(exposed).toContain("[REDACTED_JWT]");
    expect(exposed).toContain("…/ssh/sshd_config");
    expect(exposed).toContain("…/src/a.ts");
    expect(exposed).toContain("…/data/capture.jsonl");
    expect(exposed).toContain("…/team files/report.md");
  });
});

async function copyFixture(name: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-")), name);
  await writeFile(file, await readFile(new URL(name, fixtures)));
  return file;
}
