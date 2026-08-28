import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import {
  connectScuttlebuttSettings,
  getScuttlebuttSettings,
  writeAideSize,
  writeAideStayPut,
  writeScuttlebuttSettings,
} from "../client/settings-store.js";

const idleStay = { enabled: false, nx: null, ny: null };
const idleStayPut = { tori: idleStay, bori: idleStay, dori: idleStay };
const defaultSizes = { tori: 84, bori: 84, dori: 84 };

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
      sizes: defaultSizes,
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
      sizes: defaultSizes,
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
      sizes: defaultSizes,
    });
    await writeScuttlebuttSettings({ bori: false });
    expect(getScuttlebuttSettings().bori).toBe(false);
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", {
      tori: false,
      bori: false,
      dori: false,
      departureBell: false,
      stayPut: idleStayPut,
      sizes: defaultSizes,
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
      sizes: defaultSizes,
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
      sizes: defaultSizes,
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

  it("returns every stored size to the contract range on read", async () => {
    // 손으로 고친 settings.json, 범위를 넓혔다 좁힌 판본, 다른 기기에서 온 값이 모두 여기로 온다.
    const disconnect = connectScuttlebuttSettings(capability({
      sizes: { tori: 9_000, bori: 4, dori: "84" },
    }));
    await settleRead();

    expect(getScuttlebuttSettings().sizes).toEqual({ tori: 112, bori: 48, dori: 84 });
    disconnect();
  });

  it("falls back to the standard size when sizes is missing or malformed", async () => {
    const disconnect = connectScuttlebuttSettings(capability({ tori: true, sizes: "large" }));
    await settleRead();

    expect(getScuttlebuttSettings().sizes).toEqual({ tori: 84, bori: 84, dori: 84 });
    disconnect();
  });

  it("writes one aide's size without dropping the roster, bell, or stay-put", async () => {
    const settings = capability({ tori: true, bori: true, departureBell: false });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    await writeAideSize("bori", 64);

    expect(getScuttlebuttSettings().sizes).toEqual({ tori: 84, bori: 64, dori: 84 });
    expect(settings.write).toHaveBeenCalledWith("scuttlebutt", expect.objectContaining({
      tori: true,
      bori: true,
      departureBell: false,
      stayPut: idleStayPut,
      sizes: { tori: 84, bori: 64, dori: 84 },
    }));
    disconnect();
  });

  it("clamps a size handed in from outside the contract before storing it", async () => {
    const settings = capability({ tori: true });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    await writeAideSize("tori", 5_000);
    expect(getScuttlebuttSettings().sizes.tori).toBe(112);
    disconnect();
  });

  // 스테퍼를 연달아 누르면 겹치는 쓰기가 생긴다. 직렬화하지 않으면 앞선 쓰기의 롤백이
  // 이미 반영된 뒤 값까지 되돌린다.
  it("serializes overlapping writes so a failure only rolls back its own turn", async () => {
    const settings = capability({ tori: true });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    settings.write = vi.fn()
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValue(undefined);

    const failing = writeAideSize("tori", 48);
    const following = writeAideSize("tori", 64);
    await expect(failing).rejects.toThrow("first write failed");
    await following;

    expect(getScuttlebuttSettings().sizes.tori).toBe(64);
    disconnect();
  });

  // 큐에 서기 전에 나머지 칸을 읽으면, 앞선 쓰기가 바꾼 다른 부관의 값을 옛 것으로 되돌린다.
  it("does not let a queued size write clobber another aide's committed size", async () => {
    const settings = capability({ tori: true, bori: true, dori: true });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    settings.write = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);

    // 첫 쓰기가 아직 I/O에 매달려 있는 동안 두 번째 부관을 조절한다.
    const first = writeAideSize("bori", 64);
    const second = writeAideSize("dori", 112);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await first;
    await second;

    expect(getScuttlebuttSettings().sizes).toEqual({ tori: 84, bori: 64, dori: 112 });
    expect(settings.write).toHaveBeenLastCalledWith("scuttlebutt", expect.objectContaining({
      sizes: { tori: 84, bori: 64, dori: 112 },
    }));
    disconnect();
  });

  it("keeps a queued stay-put write from reverting a size committed before it", async () => {
    const settings = capability({ tori: true });
    const disconnect = connectScuttlebuttSettings(settings);
    await settleRead();

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    settings.write = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);

    const sizeWrite = writeAideSize("tori", 48);
    const stayWrite = writeAideStayPut("tori", { enabled: true, nx: 0.5, ny: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await sizeWrite;
    await stayWrite;

    expect(getScuttlebuttSettings().sizes.tori).toBe(48);
    expect(getScuttlebuttSettings().stayPut.tori).toEqual({ enabled: true, nx: 0.5, ny: 0.5 });
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
