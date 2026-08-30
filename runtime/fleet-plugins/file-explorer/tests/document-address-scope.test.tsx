// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneContext } from "@fleet-console/sdk/pane";

import { fileExplorerDocumentPane } from "../client/rail-panel.js";
import { getFileExplorerSnapshot } from "../client/view-store.js";

/**
 * 주소는 자기 Theater 안에서만 뜻이 있다.
 *
 * 문서 열은 `keepAlive`라 Theater를 갈아타도 인스턴스가 살아남고, 그 인스턴스가 들고 있는
 * `params.path`는 **떠나온 Theater의 경로**다. 그것을 새 Theater에서 그대로 세우면 있지도 않은
 * 문서를 열고, 그 Theater의 저장된 세션까지 그 경로로 덮어쓴다.
 */

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function paneCtx(theaterId: string, params: Record<string, string>): PaneContext {
  return {
    paneId: "file-explorer-document",
    instanceId: "pane-1",
    params,
    role: "detail",
    mount: "rail",
    width: 420,
    visible: true,
    focused: false,
    theaterId,
    api: {} as PaneContext["api"],
    lifecycle: {} as PaneContext["lifecycle"],
    preferences: {} as PaneContext["preferences"],
    panes: { open: vi.fn(), close: vi.fn(), replaceParams: vi.fn(), isOpen: () => true },
    signal: new AbortController().signal,
    language: "en",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  // 문서를 세우면 본문이 곧바로 읽기를 건다 — 빈 응답을 주면 뷰어가 내용 없는 코드 문서를
  // 그리다 터진다. 이 테스트의 관심은 주소의 범위이므로 읽기는 최소한으로 성립시킨다.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    relativePath: "src/index.ts",
    content: "export const demo = 1;\n",
    lang: "typescript",
    binary: false,
    truncated: false,
    sizeBytes: 24,
    mtimeMs: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  container = document.createElement("div");
  document.body.replaceChildren(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("문서 주소의 Theater 범위", () => {
  it("떠나온 Theater의 경로를 새 Theater에 세우지 않는다", () => {
    // 이전 Theater에서 읽던 문서를 들고 살아남은 인스턴스가 새 Theater에 마운트된다.
    act(() => {
      root.render(fileExplorerDocumentPane.render(paneCtx("theater-b", { path: "src/only-in-a.ts", theaterId: "theater-a" })));
    });

    expect(getFileExplorerSnapshot("theater-b").activePath).toBeNull();
    expect(getFileExplorerSnapshot("theater-b").openDocs).toEqual([]);
    // 그 Theater의 저장된 세션도 건드리지 않는다.
    expect(window.localStorage.getItem("fleet-console.fileExplorer.session.theater-b")).toBeNull();
  });

  it("자기 Theater의 주소는 그대로 세운다", () => {
    act(() => {
      root.render(fileExplorerDocumentPane.render(paneCtx("theater-a", { path: "src/index.ts", theaterId: "theater-a" })));
    });

    expect(getFileExplorerSnapshot("theater-a").activePath).toBe("src/index.ts");
  });
});
