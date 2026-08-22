import { describe, expect, it, vi } from "vitest";

import { describeBootFailure, showBootFailureAndExit } from "../src/boot-dialogs.js";

describe("desktop boot failure notice", () => {
  it("names the managed runtime mismatch and what to install", () => {
    const notice = describeBootFailure(new Error("managed_node_engine_unsupported"), "/logs");
    expect(notice.title).toContain("could not start");
    expect(notice.message).toContain("managed Node runtime");
    expect(notice.detail).toContain("latest Fleet Console Desktop release");
    expect(notice.detail).toContain("/logs");
    // 기계 코드는 문장 자리를 차지하지 않는다.
    expect(notice.message).not.toContain("managed_node_engine_unsupported");
  });

  it("still gives an unknown failure a next step and keeps the cause for support", () => {
    const notice = describeBootFailure(new Error("something_new"), null);
    expect(notice.detail).toContain("Try opening it again");
    expect(notice.detail).toContain("something_new");
    expect(notice.detail).not.toContain("Diagnostic log");
  });

  it("shows the notice before exiting, and exits even when the dialog cannot open", () => {
    const order: string[] = [];
    showBootFailureAndExit(new Error("managed_node_engine_unsupported"), {
      showErrorBox: () => { order.push("dialog"); },
      exit: () => { order.push("exit"); },
    });
    // 예전에는 stderr 한 줄만 남기고 종료해, Finder로 연 사용자에게는 창이 그냥 뜨지 않았다.
    expect(order).toEqual(["dialog", "exit"]);

    const exit = vi.fn();
    showBootFailureAndExit(new Error("boom"), {
      showErrorBox: () => { throw new Error("no display"); },
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
