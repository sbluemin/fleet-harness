// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({ setCodexReaderExpandedForSession: vi.fn() }));

import { bindCodexHost } from "../client/host.js";
import { closeCodexReader, expandCodexReader, openCodexReader } from "../client/reader-store.js";
import { useCodexSplitExtraWidth } from "../client/use-codex-split-extra-width.js";

let container: HTMLDivElement;
let root: Root;
let observed: number | null | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): null {
  observed = useCodexSplitExtraWidth();
  return null;
}

function askedWidth(): number | null | undefined {
  act(() => { root.render(<Probe />); });
  return observed;
}

beforeEach(() => {
  observed = undefined;
  bindCodexHost({
    consoleState: { getTheaters: () => [], getActiveTheaterId: () => "t", setActiveTheater: vi.fn(), subscribe: () => () => undefined },
    navigation: { setSearchParams: vi.fn(), getSearchParam: () => null, subscribe: () => () => undefined },
    surfaces: { open: vi.fn(() => "codex#1"), close: vi.fn(), closeSurface: vi.fn(), isOpen: () => false },
    rail: { open: vi.fn() },
    consoleEvents: { subscribe: () => () => undefined },
  } as never);
  closeCodexReader();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the width the split reader asks the rail for", () => {
  // 축소 리더는 카탈로그 열(248px) 옆에 문서 열을 세운다. 예전에는 코어가 Codex를
  // 알아보고 360px을 더해 줬다. 그 자리가 사라진 뒤로 기본 420px 안에서 문서가
  // 172px로 눌려 읽을 수 없었다.
  it("asks for a document column while reading in the rail", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });

    expect(askedWidth()).toBe(360);
  });

  it("asks for nothing while the document is expanded onto the canvas", () => {
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();

    expect(askedWidth()).toBeNull();
  });

  it("asks for nothing when no document is open", () => {
    expect(askedWidth()).toBeNull();
  });
});
