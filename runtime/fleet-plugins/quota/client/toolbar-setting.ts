import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { PROVIDER_ORDER_DEFAULT, sanitizeProviderSet, toggledProviderSet, type ProviderId } from "../provider-order.js";

/**
 * 「도구모음 요약」에 세울 공급자. 값은 Console 설정의 플러그인 문서(plugins.quota)에 살고, 팝업 바닥의
 * 글리프 줄이 읽고 쓴다.
 *
 * 저장값이 없거나(키 없음·배열 아님) 아직 읽지 못했으면 지원하는 공급자 전부다 — 첫 사용자도 요약을
 * 본다. 저장된 배열은 그대로 따르고, 빈 배열은 "직접 모두 껐다"는 뜻이라 요약 대신 막대 글리프 하나만 선다.
 */
export interface QuotaToolbarSetting {
  /** 기본 순서로 정렬된 집합 — 표시 순서도 기본 순서다. */
  readonly toolbarProviders: readonly ProviderId[];
  /** 플러그인 문서를 한 번이라도 읽었는가(실패도 읽은 것으로 친다) — 읽기 전에는 요약을 그리지 않는다. */
  readonly loaded: boolean;
}

const DEFAULT_SETTING: QuotaToolbarSetting = { toolbarProviders: PROVIDER_ORDER_DEFAULT, loaded: false };

/** 저장된 값을 집합으로 읽는다. 키가 없거나 배열이 아니면 "고른 적 없음"이라 전부를 뜻한다. */
export function storedToolbarProviders(value: unknown): readonly ProviderId[] {
  return Array.isArray(value) ? sanitizeProviderSet(value) : PROVIDER_ORDER_DEFAULT;
}

let setting: QuotaToolbarSetting = DEFAULT_SETTING;
let persisted: QuotaToolbarSetting = DEFAULT_SETTING;
/** 플러그인 문서 전체 — 다른 필드가 생겨도 이 쓰기가 지우지 않게 통째로 들고 있다가 덮어 쓴다. */
let document_: Record<string, unknown> = {};
let capability: ClientSettingsCapability | null = null;
const listeners = new Set<() => void>();
let writeChain: Promise<unknown> = Promise.resolve();
/** 아직 끝나지 않은 쓰기 수 — 첫 읽기가 늦게 와도 사용자가 방금 고른 값을 덮지 않게. */
let pendingWrites = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function connectQuotaToolbarSetting(next: ClientSettingsCapability): () => void {
  capability = next;
  // 첫 읽기를 쓰기 줄의 맨 앞에 세운다 — 쓰기가 읽어 온 문서 위에 얹히고, 늦은 읽기가 새 값을 덮지 않는다.
  writeChain = next.read("quota").then((value) => {
    if (capability !== next) return;
    document_ = value ?? {};
    persisted = { toolbarProviders: storedToolbarProviders(value?.toolbarProviders), loaded: true };
    if (pendingWrites > 0) return;
    setting = persisted;
    emit();
  }).catch(() => {
    // 읽지 못해도 요약은 선다 — 기본(전부)으로 그리고, 다음 쓰기가 문서를 만든다.
    if (capability !== next || setting.loaded) return;
    persisted = { ...persisted, loaded: true };
    if (pendingWrites > 0) return;
    setting = persisted;
    emit();
  });
  return () => {
    if (capability === next) capability = null;
  };
}

export function getQuotaToolbarSetting(): QuotaToolbarSetting {
  return setting;
}

export function subscribeQuotaToolbarSetting(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 한 공급자를 넣거나 뺀다 — 직전 쓰기가 끝나기 전에 연달아 눌러도 낙관 반영된 집합 위에 얹힌다. */
export function toggleQuotaToolbarProvider(id: ProviderId, shown: boolean): Promise<void> {
  const current = setting.toolbarProviders;
  if (current.includes(id) === shown) return Promise.resolve();
  return writeQuotaToolbarProviders(toggledProviderSet(current, id));
}

/** 낙관 반영 후 저장한다. 실패하면 마지막으로 저장된 값으로 되돌린다. 쓰기는 한 줄로 세운다. */
function writeQuotaToolbarProviders(providers: readonly ProviderId[]): Promise<void> {
  pendingWrites += 1;
  const next: QuotaToolbarSetting = { toolbarProviders: providers, loaded: true };
  setting = next;
  emit();
  const run = writeChain.then(async () => {
    const nextDocument = { ...document_, toolbarProviders: providers };
    try {
      await capability?.write("quota", nextDocument);
      document_ = nextDocument;
      persisted = next;
    } catch (error) {
      setting = persisted;
      emit();
      throw error;
    } finally {
      pendingWrites -= 1;
    }
  });
  writeChain = run.catch(() => undefined);
  return run;
}
