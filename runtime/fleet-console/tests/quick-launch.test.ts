// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { OperationCatalogPlugin, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

import { readQuickLaunchSelection, writeQuickLaunchSelection } from "../core/client/src/quick-launch-preferences.js";
import { findVariantLaunchKind, resolveSelection } from "../core/client/src/quick-launch.js";

const GROUPS: readonly OperationLaunchVariantGroup[] = [
  {
    id: "builtin",
    label: "Claude 내장",
    rows: [
      {
        id: "fable",
        label: "Fable",
        launch: { model: "fable" },
        chips: [
          { id: "fable-low", label: "LOW", launch: { model: "fable", effort: "low" } },
          { id: "fable-max", label: "MAX", launch: { model: "fable", effort: "max" } },
        ],
      },
      {
        id: "opus",
        label: "Opus",
        starred: true,
        launch: { model: "opus" },
        chips: [
          { id: "opus-high", label: "HIGH", launch: { model: "opus", effort: "high" } },
          { id: "opus-xhigh", label: "XHIGH", launch: { model: "opus", effort: "xhigh" } },
        ],
      },
    ],
  },
];

function catalog(kinds: OperationCatalogPlugin["kinds"]): readonly OperationCatalogPlugin[] {
  return [{ id: "terminal", title: "Terminal", kinds }];
}

describe("findVariantLaunchKind", () => {
  it("picks the first enabled kind that declares model/effort variants", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "shell", type: "shell", title: "Shell" },
      { id: "claude-native", type: "agent", title: "Claude (Native)" },
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", variants: GROUPS },
    ]));

    expect(target).toEqual({ pluginId: "terminal", kind: expect.objectContaining({ id: "claude-gateway" }) });
  });

  it("skips a disabled kind so an unavailable CLI is never targeted", () => {
    const target = findVariantLaunchKind(catalog([
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", disabled: true, variants: GROUPS },
    ]));

    expect(target).toBeNull();
  });

  it("returns null when no kind offers variants", () => {
    expect(findVariantLaunchKind(catalog([{ id: "shell", type: "shell", title: "Shell" }]))).toBeNull();
  });
});

describe("resolveSelection", () => {
  it("restores a remembered model and effort", () => {
    expect(resolveSelection(GROUPS, { model: "fable", effort: "max" })).toEqual({
      model: "fable",
      effort: "max",
      modelLabel: "Fable",
      effortLabel: "MAX",
    });
  });

  it("falls back to the starred row when the remembered model is no longer enabled", () => {
    // 설정에서 모델을 끄면 기억은 낡은 값이 된다 — 그대로 보내면 서버가 409 gateway_model_not_enabled로 거절한다.
    expect(resolveSelection(GROUPS, { model: "retired-model", effort: "high" })).toEqual({
      model: "opus",
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("drops a remembered effort the model's ladder no longer exposes", () => {
    expect(resolveSelection(GROUPS, { model: "opus", effort: "low" })).toEqual({
      model: "opus",
      effort: null,
      modelLabel: "Opus",
      effortLabel: null,
    });
  });

  it("uses the starred row when nothing is remembered", () => {
    expect(resolveSelection(GROUPS, { model: null, effort: null })).toMatchObject({ model: "opus", effort: null });
  });

  it("returns an empty selection when the catalog has no rows", () => {
    expect(resolveSelection([], { model: "opus", effort: "high" })).toEqual({
      model: null,
      effort: null,
      modelLabel: null,
      effortLabel: null,
    });
  });
});

describe("quick launch preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the last selection", () => {
    writeQuickLaunchSelection({ theaterId: "t1", model: "opus", effort: "xhigh" });
    expect(readQuickLaunchSelection()).toEqual({ theaterId: "t1", model: "opus", effort: "xhigh" });
  });

  it("reads an empty selection when nothing was stored", () => {
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", "{not json");
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });

  it("drops non-string fields instead of trusting them", () => {
    window.localStorage.setItem("fleet-console.quickLaunch.selection", JSON.stringify({ theaterId: 7, model: "", effort: "high" }));
    expect(readQuickLaunchSelection()).toEqual({ theaterId: null, model: null, effort: "high" });
  });
});
