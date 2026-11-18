import { createDurableJsonStore } from "@fleet-console/infra";

import { anthropicTurnCostPicoUsd } from "./anthropic-pricing.js";
import type {
  AnthropicBlockObservation,
  AnthropicBlockReason,
  AnthropicUsagePort,
} from "./anthropic-usage.js";
import {
  budgetUsedPercent,
  geminiMonthBounds,
  normalizeBudgetUsd,
  picoUsdFromUsd,
  usdFromPicoUsd,
} from "./gemini-pricing.js";
import type { ProviderBlock, ProviderRateLimit, ProviderSpend } from "./types.js";

/**
 * Anthropic 지출 원장.
 *
 * 크레딧 잔액을 읽을 API가 없으므로(2026-11-18 실측) 게이트웨이가 응답마다 넘겨 준 usage 토큰에 확인한 단가를
 * 곱해 **America/Los_Angeles 달력 월**별로 누적한다(사람 결정 58f4b5a3: Gemini와 같은 달력 월). 크레딧의
 * 실제 주기는 구독 결제 주기라 이 달력 월과 어긋난다 — 이 원장은 "플릿이 센 이번 달 사용액"이지 크레딧
 * 잔액이 아니다. 월 경계 계산은 Gemini 원장이 쓰는 `geminiMonthBounds`를 그대로 쓴다(이름만 Gemini이고
 * 태평양시 달력 월 하나를 계산하는 순수 함수다). 단가·계산은 `anthropic-pricing.ts`가 갖는다.
 *
 * 자리는 호스트가 넘긴다. 저장 파일은 월별 누적과 월 예산, 마지막 차단뿐이고 키·요청 본문은 담지 않는다.
 * 마지막 `anthropic-ratelimit-*` 관측은 **메모리에만** 둔다 — 분 단위 한도라 재시작 뒤에 의미가 없고,
 * 응답마다 파일을 쓸 이유도 없다.
 *
 * 금액은 pico-USD 정수(bigint)로만 더하고, 파일에는 십진 정수 문자열로 쓴다.
 */
export interface AnthropicSpendLedger extends AnthropicUsagePort {
  /** 그 시각이 속한 달의 누적과, 아직 유효한 마지막 차단·한도 관측. `at` 생략 시 지금. */
  read(at?: number): AnthropicSpendReading;
  /** 월 예산(USD) 설정. 모든 달에 적용된다. 0 이하·숫자 아님·형식 오류면 저장하지 않고 false. */
  setBudget(value: unknown): boolean;
  clearBudget(): void;
}

export interface AnthropicSpendReading {
  readonly spend: ProviderSpend;
  /** 마지막 거절. 다음 `observeUsage`나 다음 달이 걷는다. */
  readonly block?: ProviderBlock;
  /** 마지막 응답 헤더의 분당 한도(이 프로세스가 본 것). */
  readonly rateLimit?: ProviderRateLimit;
}

export interface AnthropicSpendLedgerDeps {
  readonly filePath: string;
  readonly now?: () => number;
  /** 누적·예산·차단·한도가 바뀌었을 때. 호스트가 사용량 캐시를 무효화하는 자리다. 실패는 삼킨다. */
  readonly onChange?: () => void;
}

interface StoredBlock {
  readonly httpStatus: 400 | 402 | 429;
  readonly reason: AnthropicBlockReason;
  readonly at: number;
  readonly model?: string;
  readonly code?: string;
  readonly message?: string;
}

interface AnthropicSpendDocument {
  readonly version: 1;
  /** 태평양시 달력 월 키("2026-11") → 그 달 누적 지출(pico-USD 십진 정수 문자열). */
  readonly months: Readonly<Record<string, string>>;
  /** 사람이 정한 월 예산(USD 십진 문자열). 달마다 반복되는 값이라 월 키에 넣지 않는다. */
  readonly budgetUsd?: string;
  readonly block?: StoredBlock;
}

const EMPTY_DOCUMENT: AnthropicSpendDocument = { version: 1, months: {} };
const MAX_BLOCK_TEXT = 300;

export function createAnthropicSpendLedger(deps: AnthropicSpendLedgerDeps): AnthropicSpendLedger {
  const now = deps.now ?? Date.now;
  const store = createDurableJsonStore<AnthropicSpendDocument>({
    filePath: deps.filePath,
    lockDir: `${deps.filePath}.lock`,
    lockOwnerFileName: "owner.json",
    sanitize: sanitizeDocument,
    sensitivity: "sensitive",
    tempCleanupPrefix: "anthropic-spend.json.",
  });
  let document: AnthropicSpendDocument = loadDocument();
  let rateLimit: ProviderRateLimit | undefined;

  function loadDocument(): AnthropicSpendDocument {
    try {
      return store.load();
    } catch {
      // 깨진 파일은 없는 것과 같다. 다음 관측이 다시 쓴다.
      return EMPTY_DOCUMENT;
    }
  }

  function notify(): void {
    try {
      deps.onChange?.();
    } catch {
      // 구독자가 실패해도 원장은 그대로다.
    }
  }

  function commit(next: AnthropicSpendDocument): void {
    document = next;
    try {
      store.save(next);
    } catch {
      // 디스크가 거절해도 이번 프로세스의 누적·예산은 남는다.
    }
    notify();
  }

  function monthSpentPico(key: string): bigint {
    const raw = document.months[key];
    return raw !== undefined && /^\d{1,40}$/.test(raw) ? BigInt(raw) : 0n;
  }

  /** 이번 달 이전의 차단은 지난달 사실이다 — 리셋 뒤에도 남은 거절이 현재 사유로 보이지 않게 뺀다. */
  function currentBlock(at: number): ProviderBlock | undefined {
    const block = document.block;
    if (block === undefined) return undefined;
    const bounds = geminiMonthBounds(at);
    if (block.at < bounds.periodStart || block.at > at) return undefined;
    return block;
  }

  return {
    read(at = now()) {
      const bounds = geminiMonthBounds(at);
      const spentPicoUsd = monthSpentPico(bounds.key);
      const budget = document.budgetUsd;
      const budgetPicoUsd = budget === undefined ? undefined : picoUsdFromUsd(budget);
      const usedPercent = budgetPicoUsd === undefined ? undefined : budgetUsedPercent(spentPicoUsd, budgetPicoUsd);
      const spend: ProviderSpend = {
        currency: "USD",
        spent: usdFromPicoUsd(spentPicoUsd),
        ...(budget !== undefined && usedPercent !== undefined ? { budget, usedPercent } : {}),
        periodStart: bounds.periodStart,
        resetsAt: bounds.resetsAt,
        basis: "fleet_measured",
      };
      const block = currentBlock(at);
      return {
        spend,
        ...(block !== undefined ? { block } : {}),
        ...(rateLimit !== undefined ? { rateLimit } : {}),
      };
    },

    observeUsage(observation) {
      try {
        const at = Number.isFinite(observation.at) ? observation.at : now();
        const bounds = geminiMonthBounds(at);
        const cost = anthropicTurnCostPicoUsd(observation);
        // 성공한 턴은 이전 차단을 걷는다(포트 계약). 0원 관측은 누적을 바꾸지 않으므로 지울 차단이 없으면
        // 파일도 건드리지 않는다.
        if (cost === 0n && document.block === undefined) return;
        const months = { ...document.months, [bounds.key]: (monthSpentPico(bounds.key) + cost).toString() };
        const { block: _cleared, ...rest } = document;
        commit({ ...rest, months });
      } catch {
        // 원장 실패는 추론을 막지 않는다.
      }
    },

    observeBlock(observation: AnthropicBlockObservation) {
      try {
        const at = Number.isFinite(observation.at) ? observation.at : now();
        commit({
          ...document,
          block: {
            httpStatus: observation.httpStatus,
            reason: observation.reason,
            at,
            model: observation.model,
            ...(observation.code !== undefined ? { code: clampText(observation.code) } : {}),
            ...(observation.message !== undefined ? { message: clampText(observation.message) } : {}),
          },
        });
      } catch {
        // 원장 실패는 추론을 막지 않는다.
      }
    },

    observeRateLimit(observed) {
      try {
        rateLimit = observed;
        notify();
      } catch {
        // 원장 실패는 추론을 막지 않는다.
      }
    },

    setBudget(value) {
      const budgetUsd = normalizeBudgetUsd(value);
      if (budgetUsd === undefined) return false;
      commit({ ...document, budgetUsd });
      return true;
    },

    clearBudget() {
      if (document.budgetUsd === undefined) return;
      const { budgetUsd: _removed, ...rest } = document;
      commit(rest);
    },
  };
}

function clampText(value: string): string | undefined {
  const text = value.replace(/[\r\n]+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_BLOCK_TEXT ? `${text.slice(0, MAX_BLOCK_TEXT)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeBlock(value: unknown): StoredBlock | undefined {
  if (!isRecord(value)) return undefined;
  const httpStatus = value.httpStatus;
  const reason = value.reason;
  const at = safeTime(value.at);
  if ((httpStatus !== 400 && httpStatus !== 402 && httpStatus !== 429) || at === undefined) return undefined;
  if (reason !== "balance_depleted" && reason !== "spend_limit" && reason !== "rate_limited") return undefined;
  return {
    httpStatus,
    reason,
    at,
    ...(typeof value.model === "string" && value.model.length <= 64 ? { model: value.model } : {}),
    ...(typeof value.code === "string" && value.code.length <= MAX_BLOCK_TEXT ? { code: value.code } : {}),
    ...(typeof value.message === "string" && value.message.length <= MAX_BLOCK_TEXT + 1 ? { message: value.message } : {}),
  };
}

/** 깨진 파일·손으로 고친 값은 버린다. 남은 값만 다음 저장이 다시 쓴다. */
function sanitizeDocument(value: unknown): AnthropicSpendDocument {
  if (!isRecord(value) || value.version !== 1) return EMPTY_DOCUMENT;
  const months: Record<string, string> = {};
  if (isRecord(value.months)) {
    for (const [key, raw] of Object.entries(value.months)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) continue;
      if (typeof raw !== "string" || !/^\d{1,40}$/.test(raw)) continue;
      months[key] = raw;
    }
  }
  const budgetUsd = normalizeBudgetUsd(value.budgetUsd);
  const block = sanitizeBlock(value.block);
  return {
    version: 1,
    months,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(block !== undefined ? { block } : {}),
  };
}
