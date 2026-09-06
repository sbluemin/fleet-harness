import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";

import type { GlobalSettingsState } from "../core/client/src/types.js";

const deferred = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

vi.mock("../core/client/src/global-settings-api.js", () => ({
  fetchGlobalSettingsState: vi.fn(),
  updateGlobalSettings: vi.fn((patch: Record<string, unknown>) => {
    const field = Object.keys(patch)[0] as string;
    return new Promise((resolve, reject) => {
      deferred.set(field, { resolve, reject });
    });
  }),
}));

const BASE: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  seenFeatureTours: [],
  theme: "instrument",
  liquidGlass: true,
  unfocusedPanelFade: 50,
  uiFont: { source: "builtin", id: "manrope", size: 14 },
  language: "auto",
  experiments: DEFAULT_EXPERIMENT_SETTINGS,
};

/**
 * 필드별 잠금으로 두 저장이 겹칠 수 있게 되면서 생긴 경합. 성공한 요청이 공유 error를 지우면
 * 실패한 쪽의 되돌림이 다시 무음이 된다 — 이 PR이 없애려던 바로 그 증상이다.
 */
describe("overlapping global settings saves", () => {
  beforeEach(() => {
    vi.resetModules();
    deferred.clear();
  });

  it("keeps a failed field's error when an unrelated field succeeds afterwards", async () => {
    const store = await import("../core/client/src/global-settings-store.js");
    store.hydrateGlobalSettings(BASE);

    const failing = store.setGlobalSettingsField("theme", "carbon");
    const succeeding = store.setGlobalSettingsField("language", "ko");

    deferred.get("theme")!.reject(new Error("theme write refused"));
    await expect(failing).resolves.toBe(false);
    expect(store.getGlobalSettingsStoreState().error).toBe("theme write refused");

    deferred.get("language")!.resolve({ state: { ...BASE, language: "ko" } });
    await expect(succeeding).resolves.toBe(true);

    // 성공한 language 저장이 theme 실패를 지우면, 되돌아간 theme은 아무 말 없이 사라진다.
    expect(store.getGlobalSettingsStoreState().error).toBe("theme write refused");
    expect(store.getGlobalSettingsStoreState().state?.theme).toBe("instrument");
    expect(store.getGlobalSettingsStoreState().state?.language).toBe("ko");
  });

  it("clears the error once that same field is retried", async () => {
    const store = await import("../core/client/src/global-settings-store.js");
    store.hydrateGlobalSettings(BASE);

    const first = store.setGlobalSettingsField("theme", "carbon");
    deferred.get("theme")!.reject(new Error("theme write refused"));
    await first;
    expect(store.getGlobalSettingsStoreState().error).toBe("theme write refused");

    const retry = store.setGlobalSettingsField("theme", "carbon");
    // 재시도를 시작하는 순간 그 필드의 지난 실패는 더 이상 유효한 사실이 아니다.
    expect(store.getGlobalSettingsStoreState().error).toBeNull();
    deferred.get("theme")!.resolve({ state: { ...BASE, theme: "carbon" } });
    await expect(retry).resolves.toBe(true);
    expect(store.getGlobalSettingsStoreState().error).toBeNull();
  });

  it("drops field failures once an authoritative reload replaces the state", async () => {
    const store = await import("../core/client/src/global-settings-store.js");
    store.hydrateGlobalSettings(BASE);

    const failing = store.setGlobalSettingsField("theme", "carbon");
    deferred.get("theme")!.reject(new Error("theme write refused"));
    await failing;
    expect(store.getGlobalSettingsStoreState().error).toBe("theme write refused");

    // 설정 화면을 떠났다 돌아오면 서버가 권위 있는 상태를 다시 준다. 그 순간 이전 실패는
    // 화면이 말할 사실이 아니게 되므로, 뒤이은 다른 필드의 성공이 그것을 되살리면 안 된다.
    store.hydrateGlobalSettings(BASE);
    expect(store.getGlobalSettingsStoreState().error).toBeNull();

    const succeeding = store.setGlobalSettingsField("language", "ko");
    deferred.get("language")!.resolve({ state: { ...BASE, language: "ko" } });
    await expect(succeeding).resolves.toBe(true);
    expect(store.getGlobalSettingsStoreState().error).toBeNull();
  });

  it("still refuses a second write to the same field while one is in flight", async () => {
    const store = await import("../core/client/src/global-settings-store.js");
    store.hydrateGlobalSettings(BASE);

    const first = store.setGlobalSettingsField("theme", "carbon");
    await expect(store.setGlobalSettingsField("theme", "maritime")).resolves.toBe(false);
    deferred.get("theme")!.resolve({ state: { ...BASE, theme: "carbon" } });
    await expect(first).resolves.toBe(true);
  });
});
