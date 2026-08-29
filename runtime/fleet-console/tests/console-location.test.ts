// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applySearchParams, bindConsoleNavigate } from "../core/client/src/console-location.js";

let release: (() => void) | null = null;

beforeEach(() => {
  // 콘솔은 basename "/console" 위에 산다 — pathname은 그것을 이미 품고 있다.
  window.history.replaceState(null, "", "/console/operations");
});

afterEach(() => {
  release?.();
  release = null;
  window.history.replaceState(null, "", "/");
});

describe("writing query parameters", () => {
  // pathname을 그대로 라우터에 넘기면 basename이 한 번 더 붙어 /console/console/...이 되고,
  // 콘솔은 없는 경로로 떨어져 빈 껍데기를 그린다. 라우터에는 쿼리만 건네야 한다.
  it("hands the router only the query, never the basename-bearing path", () => {
    const navigate = vi.fn();
    release = bindConsoleNavigate(navigate);

    applySearchParams({ codex: "tide-model" }, false);

    expect(navigate).toHaveBeenCalledWith({ search: "?codex=tide-model" }, { replace: false });
    const [to] = navigate.mock.calls[0] as [{ search: string }];
    expect(JSON.stringify(to)).not.toContain("/console");
  });

  it("carries the replace intent through", () => {
    const navigate = vi.fn();
    release = bindConsoleNavigate(navigate);

    applySearchParams({ codex: "tide-model" }, true);

    expect(navigate).toHaveBeenCalledWith({ search: "?codex=tide-model" }, { replace: true });
  });

  it("clears a parameter down to an empty search", () => {
    window.history.replaceState(null, "", "/console/operations?codex=tide-model");
    const navigate = vi.fn();
    release = bindConsoleNavigate(navigate);

    applySearchParams({ codex: null }, true);

    expect(navigate).toHaveBeenCalledWith({ search: "" }, { replace: true });
  });

  // 부팅 구간에는 라우터가 없다 — 그때는 basename을 붙일 주체도 없으므로 절대 경로가 맞다.
  it("writes the full path itself while no router is bound", () => {
    applySearchParams({ codex: "tide-model" }, true);

    expect(window.location.pathname).toBe("/console/operations");
    expect(window.location.search).toBe("?codex=tide-model");
  });

  it("stays silent when nothing actually changes", () => {
    window.history.replaceState(null, "", "/console/operations?codex=tide-model");
    const navigate = vi.fn();
    release = bindConsoleNavigate(navigate);

    applySearchParams({ codex: "tide-model" }, false);

    expect(navigate).not.toHaveBeenCalled();
  });
});
