import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserToolSpecs } from "../core/host/browser/tools.js";
import { createBrowserScreenshotStore } from "../core/host/browser/screenshot-store.js";

/**
 * 스크린샷이 에이전트에게 닿는 계약. 도구 결과에는 부르는 CLI 쪽 토큰 상한이 걸려 있고, 넘기면 그쪽이 결과를
 * 통째로 흘려보내 **모델은 이미지를 아예 보지 못한다** — 화면을 못 본 채 봤다고 믿고 이어가는 실패라 여기서
 * 막는다. 큰 장은 Console 호스트(에이전트가 도는 그 기계)의 파일로 내려가고, 그 파일은 사람이 본 페이지의
 * 사본이므로 소유자만 읽을 수 있어야 하며 브라우저를 거둘 때 함께 사라져야 한다.
 */

const OPERATION = "operation-screenshot";
const BUDGET_CHARS = 64_000;
/** base64 는 3 바이트를 4 자로 적는다 — 예산 밖·안을 확실히 가르는 두 크기. */
const OVERSIZED = Buffer.alloc(Math.ceil((BUDGET_CHARS + 4_000) * 3 / 4), 0x7f);
const WITHIN_BUDGET = Buffer.alloc(8_000, 0x7f);

function screenshotTool(bytes: Buffer, screenshots?: ReturnType<typeof createBrowserScreenshotStore>) {
  const service = {
    agentCall: (_id: string, _signal: AbortSignal, run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal),
    screenshot: () => Promise.resolve({ data: bytes.toString("base64"), mimeType: "image/jpeg", width: 1404, height: 1177 }),
  };
  const specs = createBrowserToolSpecs({ service: service as never, screenshots });
  const computer = specs.find((spec) => spec.id === "computer")!;
  return () => computer.execute({ action: "screenshot" }, { sessionLabel: OPERATION } as never) as Promise<{ content: { type: string; text?: string; mimeType?: string }[] }>;
}

function store() {
  return createBrowserScreenshotStore({ dataDir: mkdtempSync(path.join(tmpdir(), "browser-screenshot-")) });
}

describe("operation browser screenshots", () => {
  it("hands over an oversized screenshot as a file the agent can read, and takes it back with the browser", async () => {
    const screenshots = store();
    try {
      const { content } = await screenshotTool(OVERSIZED, screenshots)();

      // 인라인 이미지가 아니라 경로다 — 상한을 넘긴 장이 조용히 사라지지 않는다.
      expect(content.some((block) => block.type === "image")).toBe(false);
      const filePath = /Read the image file to see it: (.+)$/.exec(content[0]?.text ?? "")?.[1];
      expect(filePath).toBeTruthy();
      // 좌표 계는 그대로 따라간다 — 다음 클릭이 이 픽셀을 쓴다.
      expect(content[0]?.text).toContain("1404x1177 CSS px");

      // 화질을 깎아 내려보내지 않는다 — 파일은 캡처 그대로다.
      expect((await readFile(filePath!)).equals(OVERSIZED)).toBe(true);
      expect(statSync(filePath!).mode & 0o777).toBe(0o600);

      screenshots.release(OPERATION);
      await expect(readFile(filePath!)).rejects.toThrow();
    } finally {
      screenshots.cleanup();
    }
  });

  it("returns a screenshot within budget inline", async () => {
    const screenshots = store();
    try {
      const { content } = await screenshotTool(WITHIN_BUDGET, screenshots)();
      expect(content[0]?.type).toBe("image");
      expect(content[0]?.mimeType).toBe("image/jpeg");
    } finally {
      screenshots.cleanup();
    }
  });
});
