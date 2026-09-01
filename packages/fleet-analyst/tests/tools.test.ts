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
    // 모델에 도달하는 것은 description과 parameters뿐이다. 앞선 MCP 라우터도 그 둘만 발행했으므로
    // whenToUse 같은 산문은 이 spec에 실리지 않는다 — 모델을 움직이려면 description에 넣어야 한다.
    expect(byId.get("session_outline")).toMatchObject({
      description: expect.not.stringContaining("Call this first"),
    });
    expect(byId.get("session_outline")).not.toHaveProperty("promptSnippet");
    expect(byId.get("live_tail")).toMatchObject({
      description: expect.stringContaining("Required before answering any question about current work"),
    });
    expect(byId.get("publish_artifact")).toMatchObject({
      description: expect.stringContaining("--fleet-canvas (page ground), --fleet-card (raised card), --fleet-inset (sunken code and wells), --fleet-ink, --fleet-muted, --fleet-faint, --fleet-hairline, --fleet-hairline-strong, --fleet-accent"),
    });
    expect(byId.get("publish_artifact")?.description).toContain("var(--fleet-card, #1b2129)");
    // v2 계약: 도구 표면도 시스템 프롬프트와 같은 토큰·컴포넌트 어휘를 말해야 한다(#973 교훈의 거울상).
    expect(byId.get("publish_artifact")?.description).toContain("fleet-timeline");
    expect(byId.get("publish_artifact")?.description).not.toContain("var(--fleet-surface");
    expect(await byId.get("session_read")!.execute({ ref: "e1", radius: 999 })).toMatchObject({ events: [{ ref: "e1" }] });
    expect(await byId.get("publish_artifact")!.execute({ title: "A", html: "<p>x</p>" })).toMatchObject({ artifact: { title: "A" } });
    await expect(byId.get("publish_artifact")!.execute({ title: "A", html: "x".repeat(50 * 1024 + 1) })).rejects.toThrow("50 KiB"); expect(events).toEqual(["artifact"]);
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
      "/workspace/repo/src/private.ts",
      "/mnt/data/private.jsonl",
      "/srv/team files/private report.md",
      "openai-api-secret-value",
      "aws-access-secret-value",
      "http://127.0.0.1:8123/mcp?session=private",
      "123e4567-e89b-42d3-a456-426614174000",
    ];
    await writeFile(file, `${JSON.stringify({
      type: "assistant",
      message: { content: `Authorization: Bearer ${secrets[0]} ${secrets.slice(1, 10).join(" ")} "${secrets[10]}" OPENAI_API_KEY=${secrets[11]} "AWS_SECRET_ACCESS_KEY": "${secrets[12]}" ${secrets.slice(13).join(" ")}` },
    })}\n`);
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd() });
    await tools.refresh();
    const byId = new Map(tools.specs().map(spec => [spec.id, spec]));

    const responses = [
      await byId.get("session_events")!.execute({}),
      await byId.get("session_read")!.execute({ ref: "e1", radius: 0 }),
      await byId.get("live_tail")!.execute({}),
    ];
    const exposed = JSON.stringify(responses);
    for (const secret of secrets) expect(exposed).not.toContain(secret);
    expect(exposed).toContain("[REDACTED]");
    expect(exposed).toContain("[MCP_URL]");
    expect(exposed).toContain("[SESSION_ID]");
    expect(exposed).toContain("…/private/file.ts");
    expect(exposed).toContain("…/project/config.json");
    expect(exposed).toContain("…/project/secret.txt");
    expect(exposed).toContain("…/src/private.ts");
    expect(exposed).toContain("…/data/private.jsonl");
    expect(exposed).toContain("…/team files/private report.md");
  });

  it("does not rewrite publish_artifact input", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, "");
    const emitted: unknown[] = [];
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd(), onEvent: event => emitted.push(event) });
    const publish = tools.specs().find(spec => spec.id === "publish_artifact")!;
    const html = "<p>Bearer deliberately-authored-value</p>";

    await publish.execute({ title: "Raw agent artifact", html });

    expect(emitted).toEqual([expect.objectContaining({ type: "artifact", artifact: expect.objectContaining({ html }) })]);
  });

  it("enforces the exact publish_artifact parameter contract", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, "");
    const emitted: unknown[] = [];
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd(), onEvent: event => emitted.push(event) });
    const publish = tools.specs().find(spec => spec.id === "publish_artifact")!;

    // 스키마는 이제 zod raw shape다. 모양은 zod가 보증하고, 알 수 없는 키 거부는 아래 핸들러가
    // 계속 소유한다 — 스키마만으로는 'content' 같은 오용을 사용자에게 설명해 주지 못한다.
    expect(Object.keys(publish.parameters)).toEqual(["title", "html"]);
    expect(publish.parameters.title.isOptional()).toBe(false);
    expect(publish.parameters.html.isOptional()).toBe(false);
    await expect(publish.execute({ title: "Wrong parameter", content: "<p>Hidden</p>" })).rejects.toThrow("'html' parameter");
    await expect(publish.execute({ title: "Extra parameter", html: "<p>Visible</p>", content: "duplicate" })).rejects.toThrow("expected only 'title' and 'html'");
    await expect(publish.execute({ title: "Empty document", html: "" })).rejects.toThrow("non-empty 'html' parameter");
    await expect(publish.execute({ title: "Whitespace document", html: " \n\t " })).rejects.toThrow("non-empty 'html' parameter");
    expect(emitted).toEqual([]);
  });

  it("keeps only the 20 newest in-memory artifacts", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, "");
    const tools = new AnalystTools({ capturePath: file, cwd: process.cwd() });
    const publish = tools.specs().find(spec => spec.id === "publish_artifact")!;

    for (let index = 0; index < 21; index += 1) {
      await publish.execute({ title: `Artifact ${index}`, html: `<p>${index}</p>` });
    }

    const artifacts = (tools as unknown as { artifacts: { title: string }[] }).artifacts;
    expect(artifacts).toHaveLength(20);
    expect(artifacts[0]?.title).toBe("Artifact 20");
    expect(artifacts.at(-1)?.title).toBe("Artifact 1");
  });
});
