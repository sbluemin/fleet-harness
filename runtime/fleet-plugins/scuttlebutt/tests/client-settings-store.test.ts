import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import {
  connectScuttlebuttSettings,
  getScuttlebuttSettings,
  writeScuttlebuttSettings,
} from "../client/settings-store.js";

describe("Scuttlebutt settings store", () => {
  it("defaults missing admiral switches to enabled", async () => {
    const disconnect = connectScuttlebuttSettings(capability({ enabled: false }));
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      enabled: false,
      tori: true,
      bori: true,
      dori: true,
    });
    disconnect();
  });

  it("applies individual admiral switches", async () => {
    const settings = capability({ enabled: true, tori: false, bori: true, dori: false });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      enabled: true,
      tori: false,
      bori: true,
      dori: false,
    });
    await writeScuttlebuttSettings({ bori: false });
    expect(getScuttlebuttSettings().bori).toBe(false);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      enabled: true,
      tori: false,
      bori: false,
      dori: false,
    });
    disconnect();
  });
});

function capability(value: Record<string, unknown>): ClientSettingsCapability & {
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
