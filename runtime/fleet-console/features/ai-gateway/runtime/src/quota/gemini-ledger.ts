import { createDurableJsonStore } from "@fleet-console/infra";

import {
  budgetUsedPercent,
  geminiTurnCostPicoUsd,
  normalizeBudgetUsd,
  picoUsdFromUsd,
  spendWeekBounds,
  usdFromPicoUsd,
} from "./gemini-pricing.js";
import type {
  GeminiBlockObservation,
  GeminiBlockReason,
  GeminiUsageObservation,
  GeminiUsagePort,
} from "./gemini-usage.js";
import type { ProviderBlock, ProviderSpend } from "./types.js";

/**
 * Gemini 지출 원장.
 *
 * Gemini API는 잔액·지출·한도를 API로 주지 않는다(2026-11-18 실측: /usage·/quota·/billing 등
 * 404). 그래서 게이트웨이가 응답마다 넘겨 준 usageMetadata 토큰에 확인한 단가를 곱해
 * America/Los_Angeles 주(월요일 00:00 시작)별로 누적한다. 단가·주 경계·예산 계산은
 * `gemini-pricing.ts`가 갖는다.
 *
 * 자리는 호스트가 넘긴다 — 이 모듈은 데이터 루트를 찾지 않는다(`last-good.ts`와 같은 규칙).
 * 저장 파일은 주별 누적과 주 예산, 마지막 402·429뿐이고 키·요청 본문은 담지 않는다.
 * 주 단위로 바뀌기 전의 달별 누적은 지우지 않고 남긴다 — 화면과 계산은 이번 주만 본다(A3).
 *
 * 금액은 pico-USD 정수(bigint)로만 더하고, 파일에는 십진 정수 문자열로 쓴다. 부동소수 누적은
 * 하지 않는다.
 */
export interface GeminiSpendLedger extends GeminiUsagePort {
  /** 그 시각이 속한 주의 누적과, 아직 유효한 마지막 차단. `at` 생략 시 지금. */
  read(at?: number): GeminiSpendReading;
  /**
   * 주 예산(USD) 설정. 모든 주에 적용된다. 0 이하·숫자 아님·형식 오류면 저장하지 않고
   * false를 돌려준다(핸들러가 그것을 400으로 옮긴다).
   */
  setBudget(value: unknown): boolean;
  clearBudget(): void;
}

export interface GeminiSpendReading {
  readonly spend: ProviderSpend;
  /** 마지막 402·429. 다음 `observeUsage`나 다음 주가 걷는다. */
  readonly block?: ProviderBlock;
}

export interface GeminiSpendLedgerDeps {
  readonly filePath: string;
  readonly now?: () => number;
  /**
   * 누적·예산·차단이 바뀌었을 때. 호스트가 사용량 캐시를 무효화하는 자리다.
   * 실패는 삼킨다 — 원장은 추론 경로의 곁다리다.
   */
  readonly onChange?: () => void;
}

interface StoredBlock {
  readonly httpStatus: 402 | 429;
  readonly reason: GeminiBlockReason;
  readonly at: number;
  readonly model?: string;
  readonly code?: string;
  readonly message?: string;
}

interface GeminiSpendDocument {
  readonly version: 1;
  /** 레거시 달 키("2026-11") → 그 달 누적. 주 단위 전환 전 기록이라 읽지도 쓰지도 않고 지우지 않는다(A3). */
  readonly months: Readonly<Record<string, string>>;
  /** 주 키("2026-11-16" — 그 주 월요일) → 그 주 누적 지출(pico-USD 십진 정수 문자열). */
  readonly weeks?: Readonly<Record<string, string>>;
  /** 사람이 정한 주 예산(USD 십진 문자열). 주마다 반복되는 값이라 주 키에 넣지 않는다. */
  readonly budgetUsd?: string;
  readonly block?: StoredBlock;
}

const EMPTY_DOCUMENT: GeminiSpendDocument = { version: 1, months: {} };

/** 오류 본문 원문은 화면에 한 줄로 서므로 길이·개행만 다듬는다. 키·요청 본문은 오지 않는다. */
const MAX_BLOCK_TEXT = 300;

export function createGeminiSpendLedger(deps: GeminiSpendLedgerDeps): GeminiSpendLedger {
  const now = deps.now ?? Date.now;
  const store = createDurableJsonStore<GeminiSpendDocument>({
    filePath: deps.filePath,
    lockDir: `${deps.filePath}.lock`,
    lockOwnerFileName: "owner.json",
    sanitize: sanitizeDocument,
    sensitivity: "sensitive",
    tempCleanupPrefix: "gemini-spend.json.",
  });
  let document: GeminiSpendDocument = loadDocument();

  function loadDocument(): GeminiSpendDocument {
    try {
      return store.load();
    } catch {
      // 깨진 파일은 없는 것과 같다. 다음 관측이 다시 쓴다.
      return EMPTY_DOCUMENT;
    }
  }

  function commit(next: GeminiSpendDocument): void {
    document = next;
    try {
      store.save(next);
    } catch {
      // 디스크가 거절해도 이번 프로세스의 누적·예산은 남는다.
    }
    try {
      deps.onChange?.();
    } catch {
      // 구독자가 실패해도 원장은 그대로다.
    }
  }

  function weekSpentPico(key: string): bigint {
    const raw = document.weeks?.[key];
    return raw !== undefined && /^\d{1,40}$/.test(raw) ? BigInt(raw) : 0n;
  }

  /** 이번 주 이전의 차단은 지난주 사실이다 — 리셋 뒤에도 남은 429가 현재 사유로 보이지 않게 뺀다. */
  function currentBlock(at: number): ProviderBlock | undefined {
    const block = document.block;
    if (block === undefined) return undefined;
    const bounds = spendWeekBounds(at);
    if (block.at < bounds.periodStart || block.at > at) return undefined;
    return block;
  }

  return {
    read(at = now()) {
      const bounds = spendWeekBounds(at);
      const spentPicoUsd = weekSpentPico(bounds.key);
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
      return { spend, ...(block !== undefined ? { block } : {}) };
    },

    observeUsage(observation) {
      try {
        const at = Number.isFinite(observation.at) ? observation.at : now();
        const bounds = spendWeekBounds(at);
        const cost = geminiTurnCostPicoUsd(observation, at);
        // 성공한 턴은 이전 차단을 걷는다(포트 계약). 0토큰 관측은 누적을 바꾸지 않으므로
        // 지울 차단이 없으면 파일도 건드리지 않는다.
        if (cost === 0n && document.block === undefined) return;
        const weeks = { ...document.weeks, [bounds.key]: (weekSpentPico(bounds.key) + cost).toString() };
        const { block: _cleared, ...rest } = document;
        commit({ ...rest, weeks });
      } catch {
        // 원장 실패는 추론을 막지 않는다.
      }
    },

    observeBlock(observation: GeminiBlockObservation) {
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
  if ((httpStatus !== 402 && httpStatus !== 429) || at === undefined) return undefined;
  if (reason !== "balance_depleted" && reason !== "rate_limited") return undefined;
  return {
    httpStatus,
    reason,
    at,
    ...(typeof value.model === "string" && value.model.length <= 64 ? { model: value.model } : {}),
    ...(typeof value.code === "string" && value.code.length <= MAX_BLOCK_TEXT ? { code: value.code } : {}),
    ...(typeof value.message === "string" && value.message.length <= MAX_BLOCK_TEXT + 1 ? { message: value.message } : {}),
  };
}

/** 주 키 — 그 주 월요일의 달력 날짜("2026-11-16"). */
const WEEK_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/;

function sanitizeAmounts(value: unknown, pattern: RegExp): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!pattern.test(key)) continue;
    if (typeof raw !== "string" || !/^\d{1,40}$/.test(raw)) continue;
    result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 깨진 파일·손으로 고친 값은 버린다. 남은 값만 다음 저장이 다시 쓴다. 레거시 달 누적은 그대로 보존한다. */
function sanitizeDocument(value: unknown): GeminiSpendDocument {
  if (!isRecord(value) || value.version !== 1) return EMPTY_DOCUMENT;
  const months = sanitizeAmounts(value.months, /^\d{4}-(0[1-9]|1[0-2])$/);
  const weeks = sanitizeAmounts(value.weeks, WEEK_KEY_PATTERN);
  const budgetUsd = normalizeBudgetUsd(value.budgetUsd);
  const block = sanitizeBlock(value.block);
  return {
    version: 1,
    months: months ?? {},
    ...(weeks !== undefined ? { weeks } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(block !== undefined ? { block } : {}),
  };
}
