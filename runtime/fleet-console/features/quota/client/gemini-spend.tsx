import { useId, useState } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/i18n";

import type { ProviderBlock, ProviderSpend } from "@fleet-console/ai-gateway";
import type { QuotaMessageKey } from "./i18n/index.js";

type T = Translate<QuotaMessageKey>;

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

export function blockMessage(block: ProviderBlock, t: T): string {
  return t(block.reason === "balance_depleted" ? "quota.gemini.block.balance" : "quota.gemini.block.rate");
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
function GeminiBudgetForm({ editor, hasBudget, t }: { readonly editor: BudgetEditor; readonly hasBudget: boolean; readonly t: T }) {
  const inputId = useId();
  return (
    <form
      className="quota-budget"
      onSubmit={(event) => {
        event.preventDefault();
        editor.save();
      }}
    >
      <label className="quota-budget__label" htmlFor={inputId}>{t("quota.gemini.budget.label")}</label>
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
      <button type="submit" className="quota-button quota-button--primary" disabled={editor.saving}>{t("quota.gemini.budget.save")}</button>
      <button type="button" className="quota-button" onClick={editor.cancel} disabled={editor.saving}>{t("quota.gemini.budget.cancel")}</button>
      {hasBudget ? <button type="button" className="quota-disconnect" onClick={editor.clear} disabled={editor.saving}>{t("quota.gemini.budget.remove")}</button> : null}
      {editor.error !== null ? (
        <p className="quota-budget__error" role="alert">{t(editor.error === "invalid" ? "quota.gemini.budget.invalid" : "quota.gemini.budget.failed")}</p>
      ) : null}
    </form>
  );
}

export interface GeminiSpendProps {
  readonly spend: ProviderSpend;
  readonly block?: ProviderBlock;
  readonly locale: ConsoleLocale;
  readonly t: T;
  /** 표면마다 문법이 다른 리셋 문구 — 데스크톱은 카운트다운, 폰은 「N일 N시간 뒤 초기화」. */
  readonly resetText: string;
  readonly saveBudget: (usd: string | null) => Promise<boolean>;
}

function budgetSummary(props: GeminiSpendProps, percent: number | undefined): string {
  const { spend, locale, t } = props;
  if (spend.budget === undefined) return t("quota.gemini.noBudget");
  return t("quota.gemini.budget.summary", {
    spent: formatSpendUsd(locale, spend.spent),
    budget: formatSpendUsd(locale, spend.budget),
    pct: Math.round(percent ?? 0),
  });
}

/**
 * Gemini 카드의 지출 구역 — 이번 달 지출 금액, 예산이 있으면 사용률 막대, 없으면 금액만.
 * 402·429는 차단 사유로, 값의 근거(플릿 측정)는 한 줄로 남긴다.
 */
export function GeminiSpendSection(props: GeminiSpendProps) {
  const { spend, block, t, resetText, saveBudget } = props;
  const editor = useBudgetEditor(spend.budget, saveBudget);
  const percent = spend.usedPercent;
  const severity = percent === undefined ? "normal" : spendSeverity(percent);
  return (
    <div className="quota-spend">
      <div className="quota-spend__head">
        <span className="quota-spend__label">{t("quota.gemini.spent")}</span>
        <strong className="quota-spend__amount">{formatSpendUsd(props.locale, spend.spent)}</strong>
        {editor.editing ? null : (
          <button type="button" className="quota-spend__edit" onClick={editor.begin}>
            {t(spend.budget === undefined ? "quota.gemini.budget.set" : "quota.gemini.budget.edit")}
          </button>
        )}
      </div>
      {percent !== undefined ? (
        <div
          className="quota-spend__bar"
          role="progressbar"
          aria-label={t("quota.gemini.budget.used", { pct: Math.round(percent) })}
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
      {editor.editing ? <GeminiBudgetForm editor={editor} hasBudget={spend.budget !== undefined} t={t} /> : null}
      {block !== undefined ? <div className="quota-strip quota-strip--error">{blockMessage(block, t)}</div> : null}
      <p className="quota-spend__basis">{t("quota.gemini.basis")}</p>
    </div>
  );
}

/** 폰의 「설정 › 사용량」 행 문법 — 같은 값·같은 폼을 묶음 카드의 행으로 그린다. */
export function GeminiSpendRows(props: GeminiSpendProps) {
  const { spend, block, locale, t, resetText, saveBudget } = props;
  const editor = useBudgetEditor(spend.budget, saveBudget);
  const percent = spend.usedPercent;
  const severity = percent === undefined ? "normal" : spendSeverity(percent);
  return (
    <>
      <div className="quota-m-row">
        <span className="quota-m-copy">
          {t("quota.gemini.spent")} <span className="quota-m-amount">{formatSpendUsd(locale, spend.spent)}</span>
          <small>{[budgetSummary(props, percent), resetText].filter(Boolean).join(" · ")}</small>
          {percent !== undefined ? (
            <span
              className="quota-m-bar"
              role="progressbar"
              aria-label={t("quota.gemini.budget.used", { pct: Math.round(percent) })}
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
          <GeminiBudgetForm editor={editor} hasBudget={spend.budget !== undefined} t={t} />
        </div>
      ) : (
        <button type="button" className="quota-m-row quota-m-action" onClick={editor.begin}>
          <span className="quota-m-copy">{t(spend.budget === undefined ? "quota.gemini.budget.set" : "quota.gemini.budget.edit")}</span>
        </button>
      )}
      {block !== undefined ? (
        <div className="quota-m-row" role="alert"><span className="quota-m-copy">{blockMessage(block, t)}</span></div>
      ) : null}
    </>
  );
}
