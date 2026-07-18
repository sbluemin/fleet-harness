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
    expect(await byId.get("session_read")!.execute({ ref: "e1", radius: 999 }, {} as never)).toMatchObject({ events: [{ ref: "e1" }] });
    expect(await byId.get("publish_artifact")!.execute({ title: "A", html: "<p>x</p>" }, {} as never)).toMatchObject({ artifact: { title: "A" } });
    await expect(byId.get("publish_artifact")!.execute({ title: "A", html: "x".repeat(50 * 1024 + 1) }, {} as never)).rejects.toThrow("50 KiB"); expect(events).toEqual(["artifact"]);
  });
});
