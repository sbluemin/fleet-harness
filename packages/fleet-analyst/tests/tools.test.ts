import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalystTools } from "../src/tools.js";

describe("AnalystTools", () => {
  it("bounds reads and keeps artifacts in memory", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl"); await writeFile(file, '{"type":"assistant","message":{"content":"one"}}\n');
    const events: string[] = []; const tools = new AnalystTools({ capturePath: file, cwd: process.cwd(), onEvent: event => events.push(event.type) }); await tools.refresh();
    const byId = new Map(tools.specs().map(spec => [spec.id, spec]));
    expect(byId.get("session_outline")).toMatchObject({
      description: expect.stringContaining("Call this first"),
      whenToUse: expect.arrayContaining([expect.stringContaining("beginning")]),
    });
    expect(byId.get("live_tail")).toMatchObject({
      description: expect.stringContaining("Required before answering any question about current work"),
      whenNotToUse: expect.any(Array),
    });
    expect(await byId.get("session_read")!.execute({ ref: "e1", radius: 999 }, {} as never)).toMatchObject({ events: [{ ref: "e1" }] });
    expect(await byId.get("publish_artifact")!.execute({ title: "A", html: "<p>x</p>" }, {} as never)).toMatchObject({ artifact: { title: "A" } });
    await expect(byId.get("publish_artifact")!.execute({ title: "A", html: "x".repeat(50 * 1024 + 1) }, {} as never)).rejects.toThrow("50 KiB"); expect(events).toEqual(["artifact"]);
  });

  it("redacts transcript credentials, paths, MCP URLs, and session identifiers from event tools", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    const secrets = [
      "top-secret-bearer",
      "sk-proj-AbCdEfGhIjKlMnOp",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "/Users/alice/workspace/private/file.ts",
      "/home/alice/project/config.json",
      "C:\\Users\\alice\\project\\secret.txt",
      "http://127.0.0.1:8123/mcp?session=private",
      "123e4567-e89b-42d3-a456-426614174000",
    ];
    await writeFile(file, `${JSON.stringify({
      type: "assistant",
      message: { content: `Authorization: Bearer ${secrets[0]} ${secrets.slice(1).join(" ")}` },
    })}\n`);
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd() });
    await tools.refresh();
    const byId = new Map(tools.specs().map(spec => [spec.id, spec]));

    const responses = [
      await byId.get("session_events")!.execute({}, {} as never),
      await byId.get("session_read")!.execute({ ref: "e1", radius: 0 }, {} as never),
    ];
    const exposed = JSON.stringify(responses);
    for (const secret of secrets) expect(exposed).not.toContain(secret);
    expect(exposed).toContain("[REDACTED]");
    expect(exposed).toContain("[MCP_URL]");
    expect(exposed).toContain("[SESSION_ID]");
    expect(exposed).toContain("…/private/file.ts");
    expect(exposed).toContain("…/project/config.json");
    expect(exposed).toContain("…/project/secret.txt");
  });

  it("does not rewrite publish_artifact input", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, "");
    const emitted: unknown[] = [];
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd(), onEvent: event => emitted.push(event) });
    const publish = tools.specs().find(spec => spec.id === "publish_artifact")!;
    const html = "<p>Bearer deliberately-authored-value</p>";

    await publish.execute({ title: "Raw agent artifact", html }, {} as never);

    expect(emitted).toEqual([expect.objectContaining({ type: "artifact", artifact: expect.objectContaining({ html }) })]);
  });
});
