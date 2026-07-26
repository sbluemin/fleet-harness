import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import {
  connectScuttlebuttSettings,
  getScuttlebuttSettings,
  writeScuttlebuttSettings,
} from "../client/settings-store.js";

describe("Scuttlebutt settings store", () => {
  // 실험 기능이라 켠 적 없는 항목은 전부 꺼진 상태로 읽는다.
  it("leaves every unset switch off", async () => {
    const disconnect = connectScuttlebuttSettings(capability({ tori: true }));
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      tori: true,
      bori: false,
      dori: false,
    });
    disconnect();
  });

  it("starts with nothing enabled when no settings were ever stored", async () => {
    const disconnect = connectScuttlebuttSettings(capability(null));
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      tori: false,
      bori: false,
      dori: false,
    });
    disconnect();
  });

  it("applies individual admiral switches", async () => {
    const settings = capability({ tori: false, bori: true, dori: false });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      tori: false,
      bori: true,
      dori: false,
    });
    await writeScuttlebuttSettings({ bori: false });
    expect(getScuttlebuttSettings().bori).toBe(false);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      tori: false,
      bori: false,
      dori: false,
    });
    disconnect();
  });
});

function capability(value: Record<string, unknown> | null): ClientSettingsCapability & {
  readonly write: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ClientSettingsCapability & { readonly write: ReturnType<typeof vi.fn> };
}

async function settleRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
