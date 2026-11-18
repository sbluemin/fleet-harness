import { createDurableJsonStore } from "@fleet-console/infra";

import { priceAnthropicTurn } from "./anthropic-pricing.js";
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
  /**
   * 단가표에 없는 버전을 같은 가족의 가장 최근 표 버전 단가로 **추정해** 센 턴 — 달 키 → 상류 id → 기록.
   * 나중에 어떤 버전을 어느 단가로 셌는지 알아보는 자리다. 정확한 단가로 센 턴은 여기에 없다.
   */
  readonly estimates?: Readonly<Record<string, Readonly<Record<string, StoredEstimate>>>>;
  /** 가족이 표에 없어 **세지 못한** 턴 — 달 키 → 상류 id → 횟수. 지출에는 더하지 않는다(0으로도 지어내지 않는다). */
  readonly unpriced?: Readonly<Record<string, Readonly<Record<string, StoredUnpriced>>>>;
}

interface StoredEstimate {
  /** 단가를 가져온 표의 상류 id. */
  readonly pricedAs: string;
  readonly turns: number;
  /** 이 상류 id의 추정 지출 합(pico-USD 십진 정수 문자열). */
  readonly costPicoUsd: string;
  readonly lastAt: number;
}

interface StoredUnpriced {
  readonly turns: number;
  readonly lastAt: number;
}

const MAX_MODELS_PER_MONTH = 16;
const MAX_MODEL_ID_LENGTH = 64;

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
        const model = observation.model.slice(0, MAX_MODEL_ID_LENGTH);
        const turn = priceAnthropicTurn(observation);
        // 성공한 턴은 이전 차단을 걷는다(포트 계약). 0원 관측은 누적을 바꾸지 않으므로 지울 차단이 없으면
        // 파일도 건드리지 않는다. 추정·단가 없음은 0원이어도 남긴다 — 그 기록이 이 자리의 목적이다.
        if (turn !== undefined && turn.costPicoUsd === 0n && !turn.estimated && document.block === undefined) return;
        const { block: _cleared, ...rest } = document;
        if (turn === undefined) {
          // 가족이 표에 없다: 비용을 지어내지 않고, 센 턴이 아니라 못 센 턴으로만 남긴다.
          const month = { ...document.unpriced?.[bounds.key] };
          const previous = month[model];
          if (previous === undefined && Object.keys(month).length >= MAX_MODELS_PER_MONTH) return;
          month[model] = { turns: (previous?.turns ?? 0) + 1, lastAt: at };
          commit({ ...rest, unpriced: { ...document.unpriced, [bounds.key]: month } });
          return;
        }
        const months = { ...document.months, [bounds.key]: (monthSpentPico(bounds.key) + turn.costPicoUsd).toString() };
        if (!turn.estimated) {
          commit({ ...rest, months });
          return;
        }
        const month = { ...document.estimates?.[bounds.key] };
        const previous = month[model];
        if (previous !== undefined || Object.keys(month).length < MAX_MODELS_PER_MONTH) {
          month[model] = {
            pricedAs: turn.pricedAs,
            turns: (previous?.turns ?? 0) + 1,
            costPicoUsd: (BigInt(previous?.costPicoUsd ?? "0") + turn.costPicoUsd).toString(),
            lastAt: at,
          };
        }
        commit({ ...rest, months, estimates: { ...document.estimates, [bounds.key]: month } });
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

function sanitizeEstimate(value: unknown): StoredEstimate | undefined {
  if (!isRecord(value)) return undefined;
  const lastAt = safeTime(value.lastAt);
  const turns = safeTime(value.turns);
  if (lastAt === undefined || turns === undefined) return undefined;
  if (typeof value.pricedAs !== "string" || value.pricedAs.length > MAX_MODEL_ID_LENGTH) return undefined;
  if (typeof value.costPicoUsd !== "string" || !/^\d{1,40}$/.test(value.costPicoUsd)) return undefined;
  return { pricedAs: value.pricedAs, turns, costPicoUsd: value.costPicoUsd, lastAt };
}

function sanitizeUnpriced(value: unknown): StoredUnpriced | undefined {
  if (!isRecord(value)) return undefined;
  const lastAt = safeTime(value.lastAt);
  const turns = safeTime(value.turns);
  return lastAt === undefined || turns === undefined ? undefined : { turns, lastAt };
}

/** 달 키 → 상류 id → 기록 맵. 형식이 틀린 달·id·기록은 버리고, 달마다 {@link MAX_MODELS_PER_MONTH}개까지만 남긴다. */
function sanitizeMonthlyRecords<T>(
  value: unknown,
  sanitizeEntry: (entry: unknown) => T | undefined,
): Record<string, Record<string, T>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, Record<string, T>> = {};
  for (const [key, models] of Object.entries(value)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || !isRecord(models)) continue;
    const kept: Record<string, T> = {};
    for (const [model, entry] of Object.entries(models)) {
      if (model.length > MAX_MODEL_ID_LENGTH || Object.keys(kept).length >= MAX_MODELS_PER_MONTH) continue;
      const clean = sanitizeEntry(entry);
      if (clean !== undefined) kept[model] = clean;
    }
    if (Object.keys(kept).length > 0) result[key] = kept;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
  const estimates = sanitizeMonthlyRecords(value.estimates, sanitizeEstimate);
  const unpriced = sanitizeMonthlyRecords(value.unpriced, sanitizeUnpriced);
  return {
    version: 1,
    months,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(block !== undefined ? { block } : {}),
    ...(estimates !== undefined ? { estimates } : {}),
    ...(unpriced !== undefined ? { unpriced } : {}),
  };
}
