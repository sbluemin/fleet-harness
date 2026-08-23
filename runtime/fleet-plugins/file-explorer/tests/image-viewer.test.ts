import { describe, expect, it } from "vitest";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "../client/i18n/index.js";
import { getT } from "../client/i18n/index.js";
import { imageScaleLabel, resolveImageScale } from "../client/viewer/image.js";

const t: Translate<FileExplorerMessageKey> = getT("ko");

describe("resolveImageScale", () => {
  const natural = { width: 48, height: 48 };
  const stage = { width: 458, height: 360 };

  it("맞춤은 스테이지에 꽉 차게 — 작은 원본은 확대된다", () => {
    expect(resolveImageScale("fit", natural, stage)).toBeCloseTo(360 / 48, 5);
  });

  it("맞춤은 큰 원본을 스테이지 안으로 줄인다", () => {
    expect(resolveImageScale("fit", { width: 1600, height: 900 }, stage)).toBeCloseTo(458 / 1600, 5);
  });

  it("100%는 항상 원본 크기", () => {
    expect(resolveImageScale("actual", natural, stage)).toBe(1);
    expect(resolveImageScale("actual", { width: 1600, height: 900 }, stage)).toBe(1);
  });

  it("치수를 모르는 동안은 1로 서 있는다 — 0 나눗셈 없음", () => {
    expect(resolveImageScale("fit", { width: 0, height: 0 }, stage)).toBe(1);
    expect(resolveImageScale("fit", natural, { width: 0, height: 0 })).toBe(1);
  });
});

describe("imageScaleLabel", () => {
  it("맞춤으로 배율이 변했을 때만 (맞춤)을 병기한다", () => {
    expect(imageScaleLabel("fit", 7.5, t)).toBe("750% (맞춤)");
    expect(imageScaleLabel("fit", 1, t)).toBe("100%");
    expect(imageScaleLabel("actual", 1, t)).toBe("100%");
  });
});
