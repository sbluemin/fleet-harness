// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({
  setCodexReaderExpandedForSession: vi.fn(),
}));

import { setCodexReaderExpandedForSession } from "../client/codex-host.js";
import { bindCodexHost } from "../client/host.js";
import {
  closeCodexReader,
  collapseCodexReader,
  expandCodexReader,
  getReaderState,
  openCodexReader,
  releaseCodexExpansion,
} from "../client/reader-store.js";
import { codexReadingSurface } from "../client/reading-surface.js";

const surfaces = {
  open: vi.fn(() => "codex#1"),
  close: vi.fn(),
  isOpen: vi.fn(() => true),
};

beforeEach(() => {
  vi.clearAllMocks();
  bindCodexHost({
    consoleState: {
      getTheaters: () => [],
      getActiveTheaterId: () => "theater-a",
      setActiveTheater: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigation: { navigate: vi.fn(), applySearchParams: vi.fn() },
    surfaces,
  } as never);
  closeCodexReader();
});

describe("returning from an expanded Codex document", () => {
  // 확대 상태는 Codex와 호스트 양쪽에 있다. 호스트가 슬롯을 닫았는데 Codex가 모르면
  // 패널은 계속 "확대 중"이라 믿어 축소 리더를 그리지 않는다 — 슬롯도 없고 리더도
  // 없는 막다른 골목이 되어, 사용자에게 돌아갈 길이 사라진다.
  it("collapses back to the split reader when the host closes the slot", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    expect(getReaderState().codexReaderExpanded).toBe(true);

    codexReadingSurface.onClose?.({ surfaceId: "codex", instanceId: "codex#1", params: {} });

    expect(getReaderState().codexReaderExpanded).toBe(false);
    // 읽던 문서는 남는다 — 돌아간 자리에 같은 문서가 서 있어야 복귀지, 초기화가 아니다.
    expect(getReaderState().codexReader).toEqual({ kind: "entry", entryId: "tide-model" });
  });

  it("does not ask the host to close again, which would loop close and notice", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    surfaces.close.mockClear();

    codexReadingSurface.onClose?.({ surfaceId: "codex", instanceId: "codex#1", params: {} });

    expect(surfaces.close).not.toHaveBeenCalled();
  });

  it("clears the session flag so a refresh does not revive the closed expansion", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    vi.mocked(setCodexReaderExpandedForSession).mockClear();

    releaseCodexExpansion();

    expect(setCodexReaderExpandedForSession).toHaveBeenCalledWith(false);
  });

  it("stays put when it was never expanded", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });

    releaseCodexExpansion();

    expect(getReaderState().codexReaderExpanded).toBe(false);
    expect(setCodexReaderExpandedForSession).not.toHaveBeenCalled();
  });

  // 사용자가 스스로 접는 길은 호스트에게도 알려야 슬롯이 닫힌다 — 통보를 다는 김에
  // 이 방향이 반대로 끊기지 않았는지 함께 못 박는다.
  it("still closes the host slot when the user collapses from inside", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();

    collapseCodexReader();

    expect(surfaces.close).toHaveBeenCalledWith("codex");
    expect(getReaderState().codexReaderExpanded).toBe(false);
  });
});
