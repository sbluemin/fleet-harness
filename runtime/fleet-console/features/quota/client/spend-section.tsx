import { useId, useState } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/i18n";

import type { ProviderBlock, ProviderSpend } from "@fleet-console/ai-gateway";
import type { QuotaMessageKey } from "./i18n/index.js";

type T = Translate<QuotaMessageKey>;

/**
 * 지출·예산을 금액으로 아는 공급자. 이 둘은 같은 표면(금액·예산 폼·사용률 막대·차단 띠)을
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
    edit: "quota.gemini.budget.edit",
    label: "quota.gemini.budget.label",
    save: "quota.gemini.budget.save",
    cancel: "quota.gemini.budget.cancel",
    remove: "quota.gemini.budget.remove",
    invalid: "quota.gemini.budget.invalid",
    failed: "quota.gemini.budget.failed",
    basis: "quota.gemini.basis",
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
    edit: "quota.anthropic.budget.edit",
    label: "quota.anthropic.budget.label",
    save: "quota.anthropic.budget.save",
    cancel: "quota.anthropic.budget.cancel",
    remove: "quota.anthropic.budget.remove",
    invalid: "quota.anthropic.budget.invalid",
    failed: "quota.anthropic.budget.failed",
    basis: "quota.anthropic.basis",
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
  readonly edit: QuotaMessageKey;
  readonly label: QuotaMessageKey;
  readonly save: QuotaMessageKey;
  readonly cancel: QuotaMessageKey;
  readonly remove: QuotaMessageKey;
  readonly invalid: QuotaMessageKey;
  readonly failed: QuotaMessageKey;
  readonly basis: QuotaMessageKey;
  readonly blocks: Readonly<Record<ProviderBlock["reason"], QuotaMessageKey>>;
}>;

/** 예산·지출 표면을 가진 공급자. Quota 카드와 폰 행이 이 표를 보고 그린다. */
export type SpendProvider = keyof typeof SPEND_LABELS;

export function isSpendProvider(id: string): id is SpendProvider {
  return Object.prototype.hasOwnProperty.call(SPEND_LABELS, id);
}

/** 지출·예산의 심각도 — 미터의 로컬 밴드와 같은 기준(90/70)이다. 라우팅 판정은 창에만 붙는다. */
export function spendSeverity(percent: number): "normal" | "warning" | "critical" {
  return percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
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

interface BudgetEditor {
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
 * 예산 입력의 상태. 저장·삭제는 호스트 POST 하나로 끝나고, 성공하면 요약이 갱신돼 막대가 곧바로 선다.
 * 실패는 입력 자리에서 말한다 — 카드 전체를 오류로 바꾸지 않는다.
 */
function useBudgetEditor(budget: string | undefined, saveBudget: (usd: string | null) => Promise<boolean>): BudgetEditor {
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

export interface SpendProps {
  readonly provider: SpendProvider;
  readonly spend: ProviderSpend;
  readonly block?: ProviderBlock;
  readonly locale: ConsoleLocale;
  readonly t: T;
  /** 표면마다 문법이 다른 리셋 문구 — 데스크톱은 카운트다운, 폰은 「N일 N시간 뒤 초기화」. */
  readonly resetText: string;
  readonly saveBudget: (usd: string | null) => Promise<boolean>;
}

function budgetSummary(props: SpendProps, percent: number | undefined): string {
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
 * 지출 카드의 지출 구역 — 이번 달 지출 금액, 예산이 있으면 사용률 막대, 없으면 금액만.
 * 차단은 사유 문구로, 값의 근거(플릿 측정)는 한 줄로 남긴다.
 */
export function SpendSection(props: SpendProps) {
  const { provider, spend, block, t, resetText, saveBudget } = props;
  const labels = SPEND_LABELS[provider];
  const editor = useBudgetEditor(spend.budget, saveBudget);
  const percent = spend.usedPercent;
  const severity = percent === undefined ? "normal" : spendSeverity(percent);
  return (
    <div className="quota-spend">
      <div className="quota-spend__head">
        <span className="quota-spend__label">{t(labels.spent)}</span>
        <strong className="quota-spend__amount">{formatSpendUsd(props.locale, spend.spent)}</strong>
        {editor.editing ? null : (
          <button type="button" className="quota-spend__edit" onClick={editor.begin}>
            {t(spend.budget === undefined ? labels.set : labels.edit)}
          </button>
        )}
      </div>
      {percent !== undefined ? (
        <div
          className="quota-spend__bar"
          role="progressbar"
          aria-label={t(labels.used, { pct: Math.round(percent) })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(percent))}
        >
          <span
            className={`quota-spend__fill${severity === "normal" ? "" : ` quota-spend__fill--${severity}`}`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      ) : null}
      <div className="quota-spend__foot">
        <span>{budgetSummary(props, percent)}</span>
        <span>{resetText}</span>
      </div>
      {editor.editing ? <BudgetForm provider={provider} editor={editor} hasBudget={spend.budget !== undefined} t={t} /> : null}
      {block !== undefined ? <div className="quota-strip quota-strip--error">{blockMessage(provider, block, t)}</div> : null}
      <p className="quota-spend__basis">{t(labels.basis)}</p>
    </div>
  );
}

/** 폰의 「설정 › 사용량」 행 문법 — 같은 값·같은 폼을 묶음 카드의 행으로 그린다. */
export function SpendRows(props: SpendProps) {
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
              <i className={`is-${severity}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
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
          <span className="quota-m-copy">{t(spend.budget === undefined ? labels.set : labels.edit)}</span>
        </button>
      )}
      {block !== undefined ? (
        <div className="quota-m-row" role="alert"><span className="quota-m-copy">{blockMessage(provider, block, t)}</span></div>
      ) : null}
    </>
  );
}
