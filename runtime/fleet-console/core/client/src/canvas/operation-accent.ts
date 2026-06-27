import type { OperationNode } from "../types.js";

export interface AccentOption {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

// 16색 큐레이션 팔레트 — hue 휠 전체(빨강/노랑/초록 포함). accent는 fill 채널 단독 소유이고 시스템 신호는
// border/링/beacon/glow가 맡으므로, 신호색과 hue가 겹쳐도 채널 분리로 상태와 혼동되지 않는다(낮은 chroma 틴트).
export const OPERATION_ACCENTS: readonly AccentOption[] = [
  { key: "red", label: "Red", color: "oklch(70% 0.12 25)" },
  { key: "orange", label: "Orange", color: "oklch(73% 0.12 50)" },
  { key: "amber", label: "Amber", color: "oklch(78% 0.11 70)" },
  { key: "yellow", label: "Yellow", color: "oklch(84% 0.11 95)" },
  { key: "lime", label: "Lime", color: "oklch(81% 0.12 120)" },
  { key: "green", label: "Green", color: "oklch(74% 0.12 145)" },
  { key: "emerald", label: "Emerald", color: "oklch(73% 0.10 165)" },
  { key: "teal", label: "Teal", color: "oklch(74% 0.09 185)" },
  { key: "cyan", label: "Cyan", color: "oklch(76% 0.09 205)" },
  { key: "sky", label: "Sky", color: "oklch(74% 0.10 230)" },
  { key: "blue", label: "Blue", color: "oklch(70% 0.11 255)" },
  { key: "indigo", label: "Indigo", color: "oklch(68% 0.11 278)" },
  { key: "violet", label: "Violet", color: "oklch(70% 0.11 300)" },
  { key: "purple", label: "Purple", color: "oklch(70% 0.12 320)" },
  { key: "magenta", label: "Magenta", color: "oklch(71% 0.12 340)" },
  { key: "rose", label: "Rose", color: "oklch(72% 0.11 5)" },
] as const;

export function resolveAccentColor(accentKey: string): string | null {
  return OPERATION_ACCENTS.find((accent) => accent.key === accentKey)?.color ?? null;
}

export function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}
