// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ExpandedSurfaceContext } from "../../workspace/shared/expanded-surface.js";
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
  let viewedTheater = "theater-a";
  bindCodexHost({
    consoleState: { getViewedTheaterId: () => viewedTheater, getTheaters: () => [{ id: "theater-a", label: "A" }], subscribe: () => () => undefined },
    surfaces: { open },
    rail: { open: openRail },
  } as unknown as Parameters<typeof bindCodexHost>[0]);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasWiki: true, id: "6f1d0c2e-2b4a-4c1e-9a7d-0e5b3c2a1f00" })));
  vi.stubGlobal("fetch", fetcher);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const params = { kind: "schema", templateId: "initial-template", theaterId: "theater-a" };
  // 위키는 도구를 소유한 사령관의 것이다 — 해석은 Theater 가 아니라 이 사령관 UUID 로 묻는다.
  const commodoreA = "6f1d0c2e-2b4a-4c1e-9a7d-0e5b3c2a1f00";
  const ctx = { params, theaterId: "theater-a", commodoreId: commodoreA, close } as unknown as ExpandedSurfaceContext;
  try {
    expect(getReaderState().codexReader).toBeNull();
    await act(async () => { root.render(codexReadingSurface.render(ctx)); });
    expect(getReaderState()).toMatchObject({ codexReader: { kind: "schema", templateId: "initial-template" }, codexReaderExpanded: true });
    expect(resolvedCodexWorkspaceIdFor(commodoreA)).toBe("6f1d0c2e-2b4a-4c1e-9a7d-0e5b3c2a1f00");
    expect(open).not.toHaveBeenCalled();
    expect(openRail).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    openCodexReader({ kind: "schema", templateId: "updated-template" });
    expandCodexReader();
    expect(open).toHaveBeenLastCalledWith({ surfaceId: "codex", params: { kind: "schema", templateId: "updated-template", theaterId: "theater-a" } });

    // 다른 사령관의 대화로 따라갈 때 같은 도구는 남지만 앞 사령관의 위키 문서를 다시 해석하지 않는다.
    viewedTheater = "theater-b";
    await act(async () => { root.render(codexReadingSurface.render({ ...ctx, theaterId: viewedTheater, commodoreId: "0b9c4d1e-7a2f-4e3b-8c5d-1f2a3b4c5d6e" })); });
    expect(getReaderState()).toMatchObject({ codexReader: null, codexReaderExpanded: true });
    expect(close).not.toHaveBeenCalled();

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
