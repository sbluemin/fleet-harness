import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createStaticConsoleHandler } from "../core/host/static-console.js";

type CapturedResponse = { status: number; headers: Record<string, string> };

async function serve(pathname: string): Promise<CapturedResponse> {
  const root = await mkdtemp(join(tmpdir(), "static-console-font-cors-"));
  const clientRoot = join(root, "dist", "client");
  await mkdir(join(clientRoot, "assets"), { recursive: true });
  await writeFile(join(clientRoot, "index.html"), "<!doctype html><html data-theme=\"instrument\"><body></body></html>");
  await writeFile(join(clientRoot, "assets", "manrope-latin.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  await writeFile(join(clientRoot, "assets", "index.js"), "export {}");
  const handler = createStaticConsoleHandler(root);
  const captured: CapturedResponse = { status: 0, headers: {} };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      captured.status = status;
      captured.headers = headers;
    },
    end: () => undefined,
  };
  const handled = handler({ method: "GET" } as never, res as never, pathname);
  expect(handled).toBe(true);
  return captured;
}

describe("static console font CORS", () => {
  it("opens CORS only on woff2 font assets for the sandboxed artifact document", async () => {
    // 분석가 아티팩트 문서는 응답 헤더 sandbox로 opaque origin에서 렌더되고, @font-face
    // fetch는 CORS 모드로 Origin: null을 싣는다 — 서체 자산만 ACAO를 연다.
    const font = await serve("/console/assets/manrope-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["Content-Type"]).toBe("font/woff2");
    expect(font.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("keeps every non-font asset closed to cross-origin reads", async () => {
    const script = await serve("/console/assets/index.js");
    expect(script.status).toBe(200);
    expect(script.headers).not.toHaveProperty("Access-Control-Allow-Origin");

    const page = await serve("/console/");
    expect(page.status).toBe(200);
    expect(page.headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });
});
