// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({
  prepareReaderSessionScroll: vi.fn(),
  stepReaderHistoryTo: vi.fn(() => false),
  setCodexReaderExpandedForSession: vi.fn(),
}));

import { bindCodexHost } from "../client/host.js";
import { closeCodexReader, getReaderState } from "../client/reader-store.js";
import { useCodexReaderUrlSync } from "../client/use-codex-reader-url.js";

const rail = { open: vi.fn() };
const navigation = { setSearchParams: vi.fn(), getSearchParam: vi.fn(() => null), subscribe: vi.fn(() => () => undefined) };

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Mounted(): null {
  useCodexReaderUrlSync();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  bindCodexHost({
    consoleState: {
      getTheaters: () => [{ id: "theater-a", label: "A" }],
      getActiveTheaterId: () => "theater-a",
      setActiveTheater: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigation,
    surfaces: { open: vi.fn(() => "codex#1"), close: vi.fn(), closeSurface: vi.fn(), isOpen: vi.fn(() => false) },
    rail,
  } as never);
  closeCodexReader();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/console/operations");
});

describe("opening Codex from a shared link", () => {
  // 링크는 리더 상태만 세우면 되는 것이 아니다 — Codex 패널이 서 있지 않으면 워크스페이스를
  // 아무도 해석하지 않아, 축소 링크는 빈 화면이고 확대 링크는 null workspace로 기다린다.
  it("raises the Codex rail panel so the workspace gets resolved", () => {
    window.history.replaceState({}, "", "/console/operations?codex=tide-model&codexTheater=theater-a");

    act(() => { root.render(<Mounted />); });

    expect(rail.open).toHaveBeenCalledWith("codex");
    expect(getReaderState().codexReader).toEqual({ kind: "entry", entryId: "tide-model" });
  });

  it("leaves the rail alone when the address names no document", () => {
    window.history.replaceState({}, "", "/console/operations");

    act(() => { root.render(<Mounted />); });

    expect(rail.open).not.toHaveBeenCalled();
  });
});
