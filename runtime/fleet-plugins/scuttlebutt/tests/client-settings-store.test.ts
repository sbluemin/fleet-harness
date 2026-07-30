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
      departureBell: true,
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
      departureBell: true,
    });
    disconnect();
  });

  it("applies individual admiral switches", async () => {
    const settings = capability({
      tori: false,
      bori: true,
      dori: false,
      departureBell: false,
    });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    expect(getScuttlebuttSettings()).toEqual({
      tori: false,
      bori: true,
      dori: false,
      departureBell: false,
    });
    await writeScuttlebuttSettings({ bori: false });
    expect(getScuttlebuttSettings().bori).toBe(false);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      tori: false,
      bori: false,
      dori: false,
      departureBell: false,
    });
    disconnect();
  });

  it("parses the departure bell switch and defaults it on", async () => {
    const stored = connectScuttlebuttSettings(capability({ departureBell: false }));
    await settleRead();
    expect(getScuttlebuttSettings().departureBell).toBe(false);
    stored();

    const unset = connectScuttlebuttSettings(capability({ departureBell: "false" }));
    await settleRead();
    expect(getScuttlebuttSettings().departureBell).toBe(true);
    unset();
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
