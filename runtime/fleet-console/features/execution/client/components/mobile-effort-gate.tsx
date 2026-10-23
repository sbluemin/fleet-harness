import { useState } from "react";

import type { OperationLaunchVariantRow } from "../../shared/operations/types.js";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { buildEffortDeck } from "../launch-selection.js";
import "./mobile-launch-sheet.css";

// 새 대화 시트와 Operation 입력창 모델 시트가 함께 쓰는 강도 게이트. 새 대화 시트 모듈은 아바타(플러그인 레지스트리)를
// 끌어오므로, 실행 본문이 쓰는 이 조각은 따로 산다. 모양(.mls-efft·.mls-gr·.mls-toggle)은 두 시트가 함께 쓰는 mobile-launch-sheet.css 에 있다.

export function Toggle({ on }: { readonly on: boolean }) {
  return <span className={`mls-toggle${on ? " is-on" : ""}`} aria-hidden="true" />;
}

type EffortDeck = ReturnType<typeof buildEffortDeck>;

/**
 * 모델 시트의 강도 게이트(S-11e ①) — 새 작업 시트와 Operation 입력창 모델 시트가 같은 규칙을 쓴다.
 * 기본은 일상 단계만 보이고, 「{tiers} 펼치기」를 켜면 게이트 뒤 단계가 탭 끝에 선다. 지금 값이 이미 게이트 단계면
 * 펼친 채로 시작한다(deck이 값으로 문을 붙든다). 펼치기를 끄면 게이트 단은 숨고, 그 단을 고른 상태였으면 바로 아래 일상 단으로 되돌린다.
 */
export function useMobileEffortGate(
  row: OperationLaunchVariantRow | null,
  effort: string | null,
  autoLabel: string,
  onEffort: (effort: string | null) => void,
): { readonly deck: EffortDeck; readonly toggleGate: () => void } {
  const [opened, setOpened] = useState(false);
  const deck = buildEffortDeck(row, effort, autoLabel, "", opened);
  const toggleGate = () => {
    if (!deck.gateOpen) { setOpened(true); return; }
    if (deck.gateHeldByValue && row) {
      const gated = new Set(row.gatedEfforts ?? []);
      const everyday = (row.chips ?? []).filter((chip) => !gated.has(chip.id));
      onEffort(everyday.at(-1)?.id ?? null);
    }
    setOpened(false);
  };
  return { deck, toggleGate };
}

/** 「추론 강도」 글자 탭 한 줄 — 고른 칸은 text 600 + 아래 2(S-11b). */
export function MobileEffortTabs({ deck, label, onPick }: {
  readonly deck: EffortDeck;
  readonly label: string;
  readonly onPick: (effort: string | null) => void;
}) {
  return (
    <div className="mls-efft" role="radiogroup" aria-label={label}>
      {deck.options.map((option) => (
        <button key={option.id ?? "auto"} type="button" role="radio" aria-checked={option.checked} className={option.checked ? "is-on" : ""} onClick={() => onPick(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/** 「{tiers} 펼치기」 토글 행 — 고른 모델에 게이트 뒤 단계가 있을 때만 선다. */
export function MobileEffortGateRow({ deck, onToggle }: { readonly deck: EffortDeck; readonly onToggle: () => void }) {
  const t = useT();
  if (!deck.hasGate) return null;
  return (
    <button type="button" role="switch" aria-checked={deck.gateOpen} className="mls-gr" onClick={onToggle}>
      <span className="mls-gr-tx">{t("launchVariants.effort.apexToggle", { tiers: deck.gatedNames })}</span>
      <Toggle on={deck.gateOpen} />
    </button>
  );
}
