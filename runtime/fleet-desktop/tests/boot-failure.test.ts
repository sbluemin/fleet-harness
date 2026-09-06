import { describe, expect, it, vi } from "vitest";

import { describeBootFailure, showBootFailureAndExit } from "../src/boot-dialogs.js";

describe("desktop boot failure notice", () => {

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
