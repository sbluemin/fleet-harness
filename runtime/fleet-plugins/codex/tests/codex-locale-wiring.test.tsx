// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localeMocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("../client/codex-host.js", () => ({
  refreshCodexLocale: localeMocks.refresh,
  prepareReaderSessionScroll: vi.fn(),
  stepReaderHistoryTo: vi.fn(() => false),
  setCodexReaderExpandedForSession: vi.fn(),
}));

import { bindCodexHost } from "../client/host.js";
import { plugins } from "../client/index.js";
import { resolveActiveLocale } from "../client/i18n/index.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function descriptor() {
  const codex = plugins.find((plugin) => plugin.id === "codex")!;
  return (codex.persistentComponents ?? [])[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  bindCodexHost({
    consoleState: { getTheaters: () => [], getActiveTheaterId: () => null, setActiveTheater: vi.fn(), subscribe: () => () => undefined },
    navigation: { setSearchParams: vi.fn(), getSearchParam: () => null, subscribe: () => () => undefined },
    surfaces: { open: vi.fn(), close: vi.fn(), closeSurface: vi.fn(), isOpen: () => false },
    rail: { open: vi.fn() },
    consoleEvents: { subscribe: () => () => undefined },
  } as never);
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the console locale reaching Codex", () => {
  // Codex의 명령형 컨트롤러들은 렌더 밖에서 모듈 값을 읽는다. 그 값을 아무도 세우지 않아
  // 한국어 콘솔에서 Codex만 영어로 남아 있었다 — 화면을 통해서만 전해지면 아무 화면도
  // 열려 있지 않을 때 기본값(en)에 갇힌다.
  it("carries the console language into the plugin's own locale", () => {
    act(() => { root.render(<>{descriptor().render({ language: "ko", theme: "instrument" })}</>); });

    expect(resolveActiveLocale()).toBe("ko");
  });

  it("asks already-painted Codex chrome to repaint on a language change", () => {
    act(() => { root.render(<>{descriptor().render({ language: "ko", theme: "instrument" })}</>); });
    localeMocks.refresh.mockClear();

    act(() => { root.render(<>{descriptor().render({ language: "en", theme: "instrument" })}</>); });

    expect(resolveActiveLocale()).toBe("en");
    expect(localeMocks.refresh).toHaveBeenCalled();
  });
});
