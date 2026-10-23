import type { Translate } from "@fleet-console/i18n";
import { normalizeIdentityTone, type IdentityTone } from "../shared/identity-tones.js";

import type { CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import type { OperationNode } from "../../../core/client/src/integration/types.js";

// 8톤 정체성 팔레트 — 키 목록은 SDK(`identity-tones`)가 한 벌로 소유하고, 여기서는 theme.css의 --id-* 토큰과
// 호스트 문구만 잇는다. 정체성은 제목 잉크·틱·도트 채널만 소유하고, 보더/링/beacon/glow는 상태 신호 전용이다.
const TONE_LABEL_KEYS: Readonly<Record<IdentityTone, CoreMessageKey>> = {
  crimson: "sidebar.accent.crimson",
  amber: "sidebar.accent.amber",
  moss: "sidebar.accent.moss",
  teal: "sidebar.accent.teal",
  cerulean: "sidebar.accent.cerulean",
  indigo: "sidebar.accent.indigo",
  plum: "sidebar.accent.plum",
  rose: "sidebar.accent.rose",
};

/** 톤 피커(`Workspace accent-tone-list`)에 넘기는 호스트 문구. */
export function accentToneLabels(t: Translate<CoreMessageKey>) {
  return {
    tone: (key: IdentityTone) => t(TONE_LABEL_KEYS[key]),
    none: t("sidebar.accent.none"),
    noneAria: t("sidebar.accent.noneAria"),
  };
}

/** 저장된 키(구 16키 포함)의 색 토큰 — 모르는 키는 null(accent 없음). */
export function resolveAccentColor(accentKey: string): string | null {
  const normalized = normalizeIdentityTone(accentKey);
  return normalized ? `var(--id-${normalized})` : null;
}

export function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}
