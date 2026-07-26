export type GlanceHudMessageKey =
  | "canvas.glance.maximize"
  | "canvas.glance.restore"
  | "canvas.glance.minimize"
  | "canvas.glance.defer"
  | "canvas.glance.setAside";

export interface GlanceHudKeyHint {
  readonly key: "↑" | "↓" | "→";
  readonly messageKey: GlanceHudMessageKey;
}

export interface GlanceHudModel {
  readonly index: string;
  readonly hints: readonly [GlanceHudKeyHint, GlanceHudKeyHint];
}

export function resolveGlanceHudModel(input: {
  readonly mode: "map" | "formation" | "triage";
  readonly index: number;
  readonly total?: number;
  readonly maximized?: boolean;
}): GlanceHudModel {
  if (input.mode === "triage") {
    return {
      index: `${input.index}/${input.total ?? 0}`,
      hints: [
        { key: "→", messageKey: "canvas.glance.defer" },
        { key: "↓", messageKey: "canvas.glance.setAside" },
      ],
    };
  }
  return {
    index: String(input.index).padStart(2, "0"),
    hints: [
      {
        key: "↑",
        messageKey: input.maximized ? "canvas.glance.restore" : "canvas.glance.maximize",
      },
      { key: "↓", messageKey: "canvas.glance.minimize" },
    ],
  };
}
