import type { BirdMode, FlightState } from "./roaming.js";

export type BirdVisual =
  | "grab"
  | "cheer"
  | "salute"
  | "alert"
  | "think"
  | "walk"
  | "sleep"
  | "preen"
  | "cruise"
  | "hover";

export interface BirdSignals {
  readonly grabbed: boolean;
  readonly oneShot: "cheer" | "salute" | null;
  readonly alert: boolean;
  readonly thinking: boolean;
  readonly mode: BirdMode;
  readonly flight: FlightState;
}

export function birdVisual(signals: BirdSignals): BirdVisual {
  if (signals.grabbed) return "grab";
  // 만세·경례는 1회성 연출이라 지속 상태보다 먼저 끝까지 보여야 한다.
  if (signals.oneShot === "cheer") return "cheer";
  if (signals.oneShot === "salute") return "salute";
  // 지속 경보는 작업 중 상태보다 급하므로 먼저 알린다.
  if (signals.alert) return "alert";
  if (signals.thinking) return "think";
  if (signals.mode === "walk" || signals.mode === "sleep" || signals.mode === "preen") {
    return signals.mode;
  }
  if (signals.flight === "cruise") return "cruise";
  return "hover";
}
