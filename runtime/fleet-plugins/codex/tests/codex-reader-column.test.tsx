// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({ setCodexReaderExpandedForSession: vi.fn() }));

import { bindCodexHost } from "../client/host.js";
import { shouldStandReaderColumn } from "../client/codex-reader-pane.js";
import { closeCodexReader, collapseCodexReader, expandCodexReader, getReaderState, openCodexReader } from "../client/reader-store.js";

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

/**
 * 문서가 레일에서 자기 열을 갖는다는 사실.
 *
 * 예전에는 이것이 "카탈로그 옆에 360px을 더 달라"는 요구였다(코어가 Codex를 알아보고
 * 더해 주던 자리를 플러그인이 물려받은 것). 이제 문서는 자기 페인으로 서고 폭은 표면이
 * 진다 — 남는 계약은 **언제 서고 언제 물러나는가**뿐이다.
 */
describe("문서 열이 서는 조건", () => {
  it("레일에서 읽는 동안 문서 열이 선다", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });

    expect(shouldStandReaderColumn(getReaderState())).toBe(true);
  });

  it("캔버스로 확대하면 레일의 열은 물러난다", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();

    // 둘이 함께 서면 같은 문서가 두 자리에서 각자 스크롤을 기억한다.
    expect(shouldStandReaderColumn(getReaderState())).toBe(false);
  });

  it("확대를 접으면 같은 문서가 레일의 열로 돌아온다", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    collapseCodexReader();

    expect(shouldStandReaderColumn(getReaderState())).toBe(true);
  });

  it("읽을 것이 없으면 열도 없다", () => {
    expect(shouldStandReaderColumn(getReaderState())).toBe(false);
  });
});
