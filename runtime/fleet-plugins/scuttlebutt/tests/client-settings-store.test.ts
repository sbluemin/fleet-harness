import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import {
  connectScuttlebuttSettings,
  getScuttlebuttSettings,
  writeAideStayPut,
  writeScuttlebuttSettings,
} from "../client/settings-store.js";

const idleStay = { enabled: false, nx: null, ny: null };
const idleStayPut = { tori: idleStay, bori: idleStay, dori: idleStay };

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
      stayPut: idleStayPut,
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
      stayPut: idleStayPut,
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
      stayPut: idleStayPut,
    });
    await writeScuttlebuttSettings({ bori: false });
    expect(getScuttlebuttSettings().bori).toBe(false);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      tori: false,
      bori: false,
      dori: false,
      departureBell: false,
      stayPut: idleStayPut,
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

  it("reads a boolean stay-put flag as enabled without a saved spot", async () => {
    const disconnect = connectScuttlebuttSettings(capability({ stayPut: { tori: true } }));
    await settleRead();

    expect(getScuttlebuttSettings().stayPut).toEqual({
      tori: { enabled: true, nx: null, ny: null },
      bori: idleStay,
      dori: idleStay,
    });
    disconnect();
  });

  it("reads a stay-put spot and clamps fractions onto the unit interval", async () => {
    const disconnect = connectScuttlebuttSettings(capability({
      stayPut: {
        bori: { enabled: true, nx: 0.25, ny: 1.4 },
        dori: { enabled: true, nx: "0.3", ny: 0.4 },
      },
    }));
    await settleRead();

    expect(getScuttlebuttSettings().stayPut).toEqual({
      tori: idleStay,
      bori: { enabled: true, nx: 0.25, ny: 1 },
      dori: { enabled: true, nx: null, ny: null },
    });
    disconnect();
  });

  it("writes one aide's stay-put without touching the roster switches", async () => {
    const settings = capability({ tori: true, bori: true });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    await writeAideStayPut("bori", { enabled: true, nx: 0.4, ny: 0.7 });
    expect(getScuttlebuttSettings()).toEqual({
      tori: true,
      bori: true,
      dori: false,
      departureBell: true,
      stayPut: {
        tori: idleStay,
        bori: { enabled: true, nx: 0.4, ny: 0.7 },
        dori: idleStay,
      },
    });
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      tori: true,
      bori: true,
      dori: false,
      departureBell: true,
      stayPut: {
        tori: idleStay,
        bori: { enabled: true, nx: 0.4, ny: 0.7 },
        dori: idleStay,
      },
    });
    disconnect();
  });

  it("keeps stay-put when a roster switch is written", async () => {
    const settings = capability({
      tori: true,
      stayPut: { tori: { enabled: true, nx: 0.2, ny: 0.3 } },
    });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    await writeScuttlebuttSettings({ bori: true });
    expect(getScuttlebuttSettings().stayPut.tori).toEqual({ enabled: true, nx: 0.2, ny: 0.3 });
    expect(getScuttlebuttSettings().bori).toBe(true);
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
