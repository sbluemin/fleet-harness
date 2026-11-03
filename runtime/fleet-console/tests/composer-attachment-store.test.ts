import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposerAttachments } from "../features/execution/client/composer-primitives/attachment-store.js";

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

  it("uploads the edited pixels, discards the original id, and can put the original bytes back", async () => {
    const revoke = vi.fn();
    let urls = 0;
    vi.stubGlobal("URL", { createObjectURL: () => `blob:${++urls}`, revokeObjectURL: revoke });
    const original = new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" });
    const edited = new Blob([Uint8Array.from([9, 9])], { type: "image/png" });
    const fetchSpy = vi.fn(() => { throw new Error("csp"); });
    vi.stubGlobal("fetch", fetchSpy);
    const uploaded: Blob[] = [];
    const discarded: string[] = [];
    let seq = 0;
    const store = createComposerAttachments({
      upload: async (file) => { uploaded.push(file); return { id: `id-${++seq}` }; },
      discard: async (id) => { discarded.push(id); },
    });
    store.add([new File([original], "shot.png", { type: "image/png" })]);
    await Promise.resolve();
    await Promise.resolve();
    const key = store.read().items[0]?.key;
    expect(key).toBeTruthy();
    expect(await store.commitEdit(key ?? "", edited)).toBe("ok");
    expect(uploaded[1]).toBe(edited);
    expect(discarded).toEqual(["id-1"]);
    expect(store.ids()).toEqual(["id-2"]);
    expect(store.read().items[0]?.edited).toBe(true);
    expect(store.read().items[0]?.name).toBe("shot.png");
    expect(await store.revertEdit(store.read().items[0]?.key ?? "")).toBe("ok");
    expect(discarded).toEqual(["id-1", "id-2"]);
    expect(store.ids()).toEqual(["id-3"]);
    expect(store.read().items[0]?.edited).toBe(false);
    const handed = store.handoff();
    expect(handed.map((item) => item.id)).toEqual(["id-3"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // 원본은 첨부 때 받은 File이다. blob URL을 다시 읽지 않아도 되돌리기와 발사 초안이 그 바이트를 가진다.
    const bytes = async (blob: Blob | undefined) => {
      if (!blob) throw new Error("missing blob");
      return [...new Uint8Array(await blob.arrayBuffer())];
    };
    expect(await bytes(uploaded[2])).toEqual([1, 2, 3]);
    expect(await bytes(handed[0]?.source)).toEqual([1, 2, 3]);
  });
});
