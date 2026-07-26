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
  readonly hints: readonly GlanceHudKeyHint[];
}

export function resolveGlanceHudModel(input: {
  readonly mode: "map" | "formation" | "triage";
  readonly index: number;
  readonly total?: number;
  readonly maximized?: boolean;
  readonly companionOpen?: boolean;
}): GlanceHudModel {
  const index = input.mode === "triage"
    ? `${input.index}/${input.total ?? 0}`
    : String(input.index).padStart(2, "0");
  if (input.companionOpen) return { index, hints: [] };
  if (input.mode === "triage") {
    return {
      index,
      hints: [
        { key: "→", messageKey: "canvas.glance.defer" },
        { key: "↓", messageKey: "canvas.glance.setAside" },
      ],
    };
  }
  return {
    index,
    hints: [
      {
        key: "↑",
        messageKey: input.maximized ? "canvas.glance.restore" : "canvas.glance.maximize",
      },
      { key: "↓", messageKey: "canvas.glance.minimize" },
    ],
  };
}
