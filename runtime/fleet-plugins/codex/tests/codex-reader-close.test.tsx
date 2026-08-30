// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({ setCodexReaderExpandedForSession: vi.fn() }));

import { bindCodexHost } from "../client/host.js";
import { codexReaderPane, shouldStandReaderColumn } from "../client/codex-reader-pane.js";
import { closeCodexReader, expandCodexReader, getReaderState, openCodexReader } from "../client/reader-store.js";

/**
 * 닫기는 호스트가 소유하지만, "내가 무엇을 읽고 있다"를 함께 들고 있는 플러그인은 그 사실을
 * 되돌릴 기회가 필요하다.
 *
 * 그 기회가 없으면 캡션 ✕는 열만 치우고 `codexReader`는 남는다. 카탈로그 열의 effect는
 * "읽을 것이 있으면 열을 세운다"이므로, 다음 발행(Theater 전환 등)에서 사용자가 닫은 열이
 * 되살아난다.
 */
describe("문서 열을 닫으면 읽던 상태도 함께 닫힌다", () => {
  beforeEach(() => {
    bindCodexHost({
      consoleState: { getTheaters: () => [], getActiveTheaterId: () => "t", setActiveTheater: vi.fn(), subscribe: () => () => undefined },
      navigation: { setSearchParams: vi.fn(), getSearchParam: () => null, subscribe: () => () => undefined },
      surfaces: { open: vi.fn(() => "codex#1"), close: vi.fn(), closeSurface: vi.fn(), isOpen: () => false },
      rail: { open: vi.fn() },
      consoleEvents: { subscribe: () => () => undefined },
    } as never);
    closeCodexReader();
  });

  it("확대로 열이 물러나는 것은 닫힘이 아니다 — 읽던 문서가 그대로 남는다", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();

    // 카탈로그의 규칙은 "읽을 것이 있고 확대가 아닐 때만 열이 선다"이므로, 확대는 곧
    // `panes.close`다. 그 닫힘이 통보까지 실어 나르면 방금 옮겨 간 문서가 그 자리에서 지워진다.
    expect(shouldStandReaderColumn(getReaderState())).toBe(false);
    codexReaderPane.onClose?.({ paneId: "codex-reader", params: {} } as never);

    expect(getReaderState().codexReader).not.toBeNull();
    expect(getReaderState().codexReaderExpanded).toBe(true);
  });

  it("호스트가 이 열을 닫으면 리더 상태가 비고, 카탈로그가 열을 다시 세우지 않는다", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expect(shouldStandReaderColumn(getReaderState())).toBe(true);

    codexReaderPane.onClose?.({ paneId: "codex-reader", params: {} } as never);

    expect(getReaderState().codexReader).toBeNull();
    // 다음 발행에서 열이 되살아나지 않는다는 것이 이 계약의 전부다.
    expect(shouldStandReaderColumn(getReaderState())).toBe(false);
  });
});
