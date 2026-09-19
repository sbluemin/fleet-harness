import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserToolSpecs } from "../features/browser/host/tools.js";
import { createBrowserScreenshotStore, resolveBrowserScreenshotNamespaceRoot } from "../features/browser/host/screenshot-store.js";

/**
 * 스크린샷이 에이전트에게 닿는 계약. 캡처는 도구 결과에 실리지 않고 언제나 Console 호스트(에이전트가 도는
 * 그 기계)의 파일로 건네진다 — 결과에 실린 base64 는 이미지가 아니라 텍스트로 값이 매겨져 한 장이 수만
 * 토큰을 먹고, 상한을 넘기면 호출한 CLI 가 결과를 통째로 흘려보내 **모델은 이미지를 아예 보지 못한다**.
 * 그 파일은 사람이 본 페이지의 사본이므로 소유자만 읽을 수 있어야 하며 브라우저를 거둘 때 함께 사라져야 한다.
 */

const OPERATION = "operation-screenshot";
const CAPTURE = Buffer.alloc(8_000, 0x7f);

function screenshotTool(bytes: Buffer, screenshots: ReturnType<typeof createBrowserScreenshotStore>, aborted = false) {
  const service = {
    agentCall: (_id: string, _signal: AbortSignal, run: (signal: AbortSignal) => Promise<unknown>) => {
      const controller = new AbortController();
      // 브라우저를 거두면 진행 중 호출은 이 자리에서 끊긴다 — 회수는 그보다 먼저 지나간다.
      if (aborted) controller.abort();
      return run(controller.signal);
    },
    screenshot: () => Promise.resolve({ data: bytes.toString("base64"), mimeType: "image/jpeg", width: 1404, height: 1177 }),
  };
  const specs = createBrowserToolSpecs({ service: service as never, screenshots });
  const computer = specs.find((spec) => spec.id === "computer")!;
  return () => computer.execute({ action: "screenshot" }, { sessionLabel: OPERATION } as never) as Promise<{ content: { type: string; text?: string }[] }>;
}

function store() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "browser-screenshot-"));
  return { screenshots: createBrowserScreenshotStore({ dataDir }), root: resolveBrowserScreenshotNamespaceRoot(dataDir) };
}

describe("operation browser screenshots", () => {
  it("hands every screenshot over as a file instead of loading the result with the image, and takes it back with the browser", async () => {
    const { screenshots } = store();
    try {
      const { content } = await screenshotTool(CAPTURE, screenshots)();

      // 결과에는 그림이 없다 — 이미지 블록도, 텍스트로 새어 나온 base64 도.
      expect(content.every((block) => block.type === "text")).toBe(true);
      expect(content.map((block) => block.text ?? "").join("\n")).not.toContain(CAPTURE.toString("base64").slice(0, 64));

      const filePath = /Read the image file to see it: (.+)$/.exec(content[0]?.text ?? "")?.[1];
      expect(filePath).toBeTruthy();
      // 좌표 계는 그대로 따라간다 — 다음 클릭이 이 픽셀을 쓴다.
      expect(content[0]?.text).toContain("1404x1177 CSS px");

      // 화질을 깎아 내려보내지 않는다 — 파일은 캡처 그대로다.
      expect((await readFile(filePath!)).equals(CAPTURE)).toBe(true);
      expect(statSync(filePath!).mode & 0o777).toBe(0o600);

      screenshots.release(OPERATION);
      await expect(readFile(filePath!)).rejects.toThrow();
    } finally {
      screenshots.cleanup();
    }
  });

  it("writes nothing when the call was already cut off", async () => {
    const { screenshots, root } = store();
    try {
      // 거둔 뒤에 끝난 캡처가 파일을 쓰면 회수가 지나간 디렉터리를 되살리며 그 페이지가 남는다.
      const { content } = await screenshotTool(CAPTURE, screenshots, true)();
      expect(content[0]?.text).toContain("1404x1177 CSS px");
      expect(existsSync(root)).toBe(false);
    } finally {
      screenshots.cleanup();
    }
  });

  it("leaves a serving console's screenshots alone when a second one starts and gives up", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "browser-screenshot-"));
    const serving = createBrowserScreenshotStore({ dataDir });
    try {
      const filePath = serving.save(OPERATION, CAPTURE, "jpg");

      // 같은 데이터 루트로 두 번째 Console 이 올라온다. 서버는 기동 끝에서야 runtime lock 을 잡으므로
      // 이 프로세스는 아직 자기가 질지 모른 채 만들어지고, 잠금에 실패하면 정리하며 내려간다.
      const losing = createBrowserScreenshotStore({ dataDir });
      losing.cleanup();

      expect(existsSync(filePath)).toBe(true);
    } finally {
      serving.cleanup();
    }
  });
});
