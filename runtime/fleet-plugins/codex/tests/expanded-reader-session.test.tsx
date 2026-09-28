// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ExpandedSurfaceContext } from "@fleet-console/sdk/expanded-surface";
import { bindCodexHost } from "../client/host.js";
import { codexReadingSurface } from "../client/reading-surface.js";
import { expandCodexReader, getReaderState, openCodexReader } from "../client/reader-store.js";
import { resolvedCodexWorkspaceIdFor } from "../client/workspace-store.js";

// 명령형 문서 DOM은 실제 앱에서 검증한다. 여기서는 호스트가 복원한 표면을 플러그인
// 본문 요청으로 바꾸는 부팅 경계와, 숨은 카탈로그에 기대지 않는 workspace 해석을 검증한다.
vi.mock("../client/codex-reading-sheet.js", () => ({ CodexReadingSheet: () => null }));
vi.mock("../client/codex-host.js", () => ({
  getCodexReaderDocumentState: () => ({ title: "" }),
  setCodexReaderExpandedForSession: () => undefined,
}));

it("reconstructs a non-entry reader from its restored slot without reopening the rail or losing the host placement", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const open = vi.fn();
  const close = vi.fn();
  const openRail = vi.fn();
  bindCodexHost({
    consoleState: { getActiveTheaterId: () => "theater-a", getTheaters: () => [{ id: "theater-a", label: "A" }], subscribe: () => () => undefined },
    surfaces: { open },
    rail: { open: openRail },
  } as unknown as Parameters<typeof bindCodexHost>[0]);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasWiki: true, id: "abcdef123456" })));
  vi.stubGlobal("fetch", fetcher);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const params = { kind: "drydock", patchId: "pending-patch", theaterId: "theater-a" };
  const ctx = { params, theaterId: "theater-a", close } as unknown as ExpandedSurfaceContext;
  try {
    expect(getReaderState().codexReader).toBeNull();
    await act(async () => { root.render(codexReadingSurface.render(ctx)); });
    expect(getReaderState()).toMatchObject({ codexReader: { kind: "drydock", patchId: "pending-patch" }, codexReaderExpanded: true });
    expect(resolvedCodexWorkspaceIdFor("theater-a")).toBe("abcdef123456");
    expect(open).not.toHaveBeenCalled();
    expect(openRail).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    openCodexReader({ kind: "schema", templateId: "updated-template" });
    expandCodexReader();
    expect(open).toHaveBeenLastCalledWith({ surfaceId: "codex", params: { kind: "schema", templateId: "updated-template", theaterId: "theater-a" } });

    // 과거 스냅샷에는 본문의 주소가 없다. 새 유효 슬롯과 같은 복원 대상으로 보지 않는다.
    await act(async () => { root.render(null); });
    await act(async () => { root.render(codexReadingSurface.render({ ...ctx, params: {} })); });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
  }
});
