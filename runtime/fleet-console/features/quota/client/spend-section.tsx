import { useId, useState } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/i18n";

import type { ProviderBlock, ProviderSpend } from "@fleet-console/ai-gateway";
import type { QuotaMessageKey } from "./i18n/index.js";
import { clampPercent, localPercentSeverity, UsageMeter, type MeterSeverity } from "./meter.js";

type T = Translate<QuotaMessageKey>;

/**
 * 지출·예산을 금액으로 아는 공급자. 이 둘은 같은 표면(주간 미터·금액 줄·예산 폼·차단 띠)을
 * 쓰고 문구만 다르다 — 공급자마다 컴포넌트를 복제하면 예산 저장 규칙과 오류 문구가 표면마다
 * 갈린다. 새 공급자가 같은 표면을 얻으면 이 표에 한 줄을 더한다.
 */
const SPEND_LABELS = {
  gemini: {
    spent: "quota.gemini.spent",
    noBudget: "quota.gemini.noBudget",
    summary: "quota.gemini.budget.summary",
    used: "quota.gemini.budget.used",
    set: "quota.gemini.budget.set",
    label: "quota.gemini.budget.label",
    save: "quota.gemini.budget.save",
    cancel: "quota.gemini.budget.cancel",
    remove: "quota.gemini.budget.remove",
    invalid: "quota.gemini.budget.invalid",
    failed: "quota.gemini.budget.failed",
    withBudget: "quota.gemini.spend.withBudget",
    withoutBudget: "quota.gemini.spend.withoutBudget",
    blocks: {
      balance_depleted: "quota.gemini.block.balance",
      // Gemini는 지출 한도 사유를 보내지 않는다. 사유가 늘어도 차단 띠가 빈 채로 서지 않게
      // 같은 거절 문구로 접는다.
      spend_limit: "quota.gemini.block.rate",
      rate_limited: "quota.gemini.block.rate",
    },
  },
  anthropic: {
    spent: "quota.anthropic.spent",
    noBudget: "quota.anthropic.noBudget",
    summary: "quota.anthropic.budget.summary",
    used: "quota.anthropic.budget.used",
    set: "quota.anthropic.budget.set",
    label: "quota.anthropic.budget.label",
    save: "quota.anthropic.budget.save",
    cancel: "quota.anthropic.budget.cancel",
    remove: "quota.anthropic.budget.remove",
    invalid: "quota.anthropic.budget.invalid",
    failed: "quota.anthropic.budget.failed",
    withBudget: "quota.anthropic.spend.withBudget",
    withoutBudget: "quota.anthropic.spend.withoutBudget",
    blocks: {
      balance_depleted: "quota.anthropic.block.balance",
      spend_limit: "quota.anthropic.block.spendLimit",
      rate_limited: "quota.anthropic.block.rate",
    },
  },
} as const satisfies Record<string, {
  readonly spent: QuotaMessageKey;
  readonly noBudget: QuotaMessageKey;
  readonly summary: QuotaMessageKey;
  readonly used: QuotaMessageKey;
  readonly set: QuotaMessageKey;
  readonly label: QuotaMessageKey;
  readonly save: QuotaMessageKey;
  readonly cancel: QuotaMessageKey;
  readonly remove: QuotaMessageKey;
  readonly invalid: QuotaMessageKey;
  readonly failed: QuotaMessageKey;
  readonly withBudget: QuotaMessageKey;
  readonly withoutBudget: QuotaMessageKey;
  readonly blocks: Readonly<Record<ProviderBlock["reason"], QuotaMessageKey>>;
}>;

/** 예산·지출 표면을 가진 공급자. Quota 카드와 폰 행이 이 표를 보고 그린다. */
export type SpendProvider = keyof typeof SPEND_LABELS;

export function isSpendProvider(id: string): id is SpendProvider {
  return Object.prototype.hasOwnProperty.call(SPEND_LABELS, id);
}

/** 공급자 머리줄의 예산 진입 단추 문구 — 예산 유무와 관계없이 하나다. */
export function spendSetLabel(provider: SpendProvider): QuotaMessageKey {
  return SPEND_LABELS[provider].set;
}

/** 지출·예산의 심각도 — 미터의 로컬 밴드와 같은 기준(90/70)이다. 라우팅 판정은 창에만 붙는다. */
export function spendSeverity(percent: number): MeterSeverity {
  return localPercentSeverity(percent);
}

/**
 * USD 십진 문자열의 표시 형식. 여기서 Number로 바꾸는 것은 **표시뿐**이다 — 누적·계산은 서버
 * 원장이 pico-USD 정수로 끝냈고, 소수 자리는 보여 줄 만큼만 고른다(센트 미만 지출은 6~8자리).
 */
export function formatSpendUsd(locale: ConsoleLocale, value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  const magnitude = Math.abs(amount);
  const digits = amount === 0 ? 2 : magnitude < 0.0001 ? 8 : magnitude < 0.01 ? 6 : 2;
  return new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(amount);
}

/**
 * 입력값 검증. 서버 원장이 같은 규칙으로 다시 보므로 여기서는 왕복을 줄이는 몫만 진다.
 * 쉼표는 천 단위로 읽고, `$`는 걷는다. 0 이하·숫자 아님·과다 소수는 undefined.
 */
export function parseBudgetInput(raw: string): string | undefined {
  const text = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,9}(?:\.\d{1,12})?$/.test(text)) return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? text : undefined;
}

export function blockMessage(provider: SpendProvider, block: ProviderBlock, t: T): string {
  return t(SPEND_LABELS[provider].blocks[block.reason]);
}

export interface BudgetEditor {
  readonly editing: boolean;
  readonly draft: string;
  readonly error: "invalid" | "failed" | null;
  readonly saving: boolean;
  readonly begin: () => void;
  readonly cancel: () => void;
  readonly change: (value: string) => void;
  readonly save: () => void;
  readonly clear: () => void;
}

/**
 * 예산 입력의 상태. 저장·삭제는 호스트 POST 하나로 끝나고, 성공하면 요약이 갱신돼 미터가 곧바로 선다.
 * 실패는 입력 자리에서 말한다 — 카드 전체를 오류로 바꾸지 않는다.
 *
 * 데스크톱 카드는 머리줄의 「예산 설정」 단추와 폼이 같은 상태를 봐야 하므로, 이 훅을 카드가 소유하고
 * 폼에 넘긴다. 폰 행은 스스로 만든다.
 */
export function useBudgetEditor(budget: string | undefined, saveBudget: (usd: string | null) => Promise<boolean>): BudgetEditor {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<"invalid" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const begin = () => {
    setDraft(budget ?? "");
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const change = (value: string) => {
    setDraft(value);
    setError(null);
  };
  const submit = (usd: string | null) => {
    setSaving(true);
    void saveBudget(usd).then((saved) => {
      setSaving(false);
      if (!saved) {
        setError("failed");
        return;
      }
      setEditing(false);
    });
  };
  const save = () => {
    const usd = parseBudgetInput(draft);
    if (usd === undefined) {
      setError("invalid");
      return;
    }
    submit(usd);
  };
  return { editing, draft, error, saving, begin, cancel, change, save, clear: () => submit(null) };
}

/** 데스크톱 카드와 폰 행이 같은 폼을 쓴다 — 저장 규칙과 오류 문구가 표면마다 갈리지 않게. */
function BudgetForm({ provider, editor, hasBudget, t }: {
  readonly provider: SpendProvider;
  readonly editor: BudgetEditor;
  readonly hasBudget: boolean;
  readonly t: T;
}) {
  const labels = SPEND_LABELS[provider];
  const inputId = useId();
  return (
    <form
      className="quota-budget"
      onSubmit={(event) => {
        event.preventDefault();
        editor.save();
      }}
    >
      <label className="quota-budget__label" htmlFor={inputId}>{t(labels.label)}</label>
      <input
        id={inputId}
        className="quota-budget__input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="20"
        autoFocus
        disabled={editor.saving}
        aria-invalid={editor.error !== null}
        value={editor.draft}
        onChange={(event) => editor.change(event.target.value)}
      />
      <button type="submit" className="quota-button quota-button--primary" disabled={editor.saving}>{t(labels.save)}</button>
      <button type="button" className="quota-button" onClick={editor.cancel} disabled={editor.saving}>{t(labels.cancel)}</button>
      {hasBudget ? <button type="button" className="quota-disconnect" onClick={editor.clear} disabled={editor.saving}>{t(labels.remove)}</button> : null}
      {editor.error !== null ? (
        <p className="quota-budget__error" role="alert">{t(editor.error === "invalid" ? labels.invalid : labels.failed)}</p>
      ) : null}
    </form>
  );
}

interface SpendCommon {
  readonly provider: SpendProvider;
  readonly spend: ProviderSpend;
  readonly block?: ProviderBlock;
  readonly locale: ConsoleLocale;
  readonly t: T;
  /** 표면마다 문법이 다른 리셋 문구 — 데스크톱은 「리셋까지 2d 2h」, 폰은 「N일 N시간 뒤 초기화」. */
  readonly resetText: string;
}

export interface SpendProps extends SpendCommon {
  /** 미터의 title — 날짜가 붙은 긴 리셋 문구. */
  readonly resetTitle?: string;
  /** 머리줄 단추와 본문 폼이 공유하는 편집 상태(카드가 소유한다). */
  readonly editor: BudgetEditor;
}

export interface SpendRowProps extends SpendCommon {
  readonly saveBudget: (usd: string | null) => Promise<boolean>;
}

/** 예산이 있으면 「{budget} 중 {spent} 사용」, 없으면 「{spent} 사용」 — 금액 줄은 하나뿐이다. */
function spendLine(props: SpendCommon): string {
  const { provider, spend, locale, t } = props;
  const labels = SPEND_LABELS[provider];
  const spent = formatSpendUsd(locale, spend.spent);
  if (spend.budget === undefined) return t(labels.withoutBudget, { spent });
  return t(labels.withBudget, { spent, budget: formatSpendUsd(locale, spend.budget) });
}

/** 폰 행의 보조 줄 — 같은 금액을 다시 말하지 않도록 예산 대비 비율만 덧붙인다. */
function budgetSummary(props: SpendCommon, percent: number | undefined): string {
  const { provider, spend, locale, t } = props;
  const labels = SPEND_LABELS[provider];
  if (spend.budget === undefined) return t(labels.noBudget);
  return t(labels.summary, {
    spent: formatSpendUsd(locale, spend.spent),
    budget: formatSpendUsd(locale, spend.budget),
    pct: Math.round(percent ?? 0),
  });
}

/**
 * 지출 카드의 지출 구역 — 한도 미터와 같은 형상(주간 라벨·막대·퍼센트·리셋)에, Codex의 소진 예측
 * 자리에는 금액 줄을 둔다. 예산이 없으면 막대·퍼센트 없이 라벨·금액·리셋만 선다(B2).
 * 차단은 사유 문구로 남긴다.
 */
export function SpendSection(props: SpendProps) {
  const { provider, spend, block, t, resetText, resetTitle, editor } = props;
  const labels = SPEND_LABELS[provider];
  const percent = spend.budget === undefined ? undefined : spend.usedPercent;
  const severity = percent === undefined ? "normal" : spendSeverity(percent);
  return (
    <>
      <UsageMeter
        label={t("quota.meter.weekly")}
        {...(percent !== undefined ? { percent, usedText: t(labels.used, { pct: Math.round(percent) }) } : {})}
        severity={severity}
        note={spendLine(props)}
        resetText={resetText}
        {...(resetTitle !== undefined ? { resetTitle } : {})}
      />
      {editor.editing ? <BudgetForm provider={provider} editor={editor} hasBudget={spend.budget !== undefined} t={t} /> : null}
      {block !== undefined ? <div className="quota-strip quota-strip--error">{blockMessage(provider, block, t)}</div> : null}
    </>
  );
}

/** 폰의 「설정 › 사용량」 행 문법 — 같은 값·같은 폼을 묶음 카드의 행으로 그린다. */
export function SpendRows(props: SpendRowProps) {
  const { provider, spend, block, locale, t, resetText, saveBudget } = props;
  const labels = SPEND_LABELS[provider];
  const editor = useBudgetEditor(spend.budget, saveBudget);
  const percent = spend.usedPercent;
  const severity = percent === undefined ? "normal" : spendSeverity(percent);
  return (
    <>
      <div className="quota-m-row">
        <span className="quota-m-copy">
          {t(labels.spent)} <span className="quota-m-amount">{formatSpendUsd(locale, spend.spent)}</span>
          <small>{[budgetSummary(props, percent), resetText].filter(Boolean).join(" · ")}</small>
          {percent !== undefined ? (
            <span
              className="quota-m-bar"
              role="progressbar"
              aria-label={t(labels.used, { pct: Math.round(percent) })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round(percent))}
            >
              <i className={`is-${severity}`} style={{ width: `${clampPercent(percent)}%` }} />
            </span>
          ) : null}
        </span>
      </div>
      {editor.editing ? (
        <div className="quota-m-row">
          <BudgetForm provider={provider} editor={editor} hasBudget={spend.budget !== undefined} t={t} />
        </div>
      ) : (
        <button type="button" className="quota-m-row quota-m-action" onClick={editor.begin}>
          <span className="quota-m-copy">{t(labels.set)}</span>
        </button>
      )}
      {block !== undefined ? (
        <div className="quota-m-row" role="alert"><span className="quota-m-copy">{blockMessage(provider, block, t)}</span></div>
      ) : null}
    </>
  );
}
