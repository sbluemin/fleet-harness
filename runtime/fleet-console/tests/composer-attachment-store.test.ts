import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposerAttachments } from "../sdk/composer/attachment-store.js";

/**
 * 업로드 토큰이 만료된 뒤의 전송 거절.
 * 서버는 어느 장이 없어졌는지 말하지 않고 attachment_not_found만 돌려준다.
 * 스토어가 그 칩을 걷지 않으면 같은 토큰으로 다시 보내 전송이 또 실패하고, 초안 문면은 스토어 밖에 있으므로 남아야 한다.
 */

describe("composer attachment expiry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops an expired upload token without discarding it and leaves the draft text alone", async () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:pending", revokeObjectURL: revoke });
    const discarded: string[] = [];
    let finish!: (id: string) => void;
    const store = createComposerAttachments({
      upload: () => new Promise((resolve) => { finish = (id) => resolve({ id }); }),
      discard: async (id) => { discarded.push(id); },
    });
    const draftText = "keep this instruction";
    store.add([new File([new Uint8Array([1])], "shot.png", { type: "image/png" })]);
    finish("token-1");
    await Promise.resolve();
    expect(store.ids()).toEqual(["token-1"]);
    expect(store.noteSendFailure(new Error("attachment_not_found"), ["token-1"])).toBe("expired");
    expect(store.read().items).toEqual([]);
    expect(store.read().notice).toEqual({ kind: "expired" });
    expect(discarded).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("blob:pending");
    expect(draftText).toBe("keep this instruction");
    expect(store.noteSendFailure(new Error("attachment_budget_exceeded"), [])).toBe("other");
  });
});