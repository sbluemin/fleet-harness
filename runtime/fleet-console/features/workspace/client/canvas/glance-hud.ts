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
  /** 두 번 눌러 확정을 기다리는 동안에만 채워진다. 키 안내 자리를 대신 차지한다. */
  readonly armedMessageKey?: "canvas.triage.setAsideArmed";
}

export function resolveGlanceHudModel(input: {
  readonly mode: "map" | "formation" | "triage";
  readonly index: number;
  readonly total?: number;
  readonly maximized?: boolean;
  readonly companionOpen?: boolean;
  readonly setAsideArmed?: boolean;
}): GlanceHudModel {
  const index = input.mode === "triage"
    ? `${input.index}/${input.total ?? 0}`
    : String(input.index).padStart(2, "0");
  if (input.companionOpen) return { index, hints: [] };
  if (input.mode === "triage") {
    // 무장 중에는 남은 선택지가 하나뿐이라, 키 안내 두 줄보다 확정 안내가 그 자리에 있어야 시선이 옮겨가지 않는다.
    if (input.setAsideArmed) return { index, hints: [], armedMessageKey: "canvas.triage.setAsideArmed" };
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
