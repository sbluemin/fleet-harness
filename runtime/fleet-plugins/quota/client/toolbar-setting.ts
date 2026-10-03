import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { sanitizeFoldedProviders, toggledFoldedProviders, type ProviderId } from "../provider-order.js";

/**
 * 「도구모음 요약」에 세울 공급자 — 기본은 비어 있다(옵트인). 비어 있으면 요약은 칸째 사라진다.
 * 값은 Console 설정의 플러그인 문서(plugins.quota)에 산다. 카드 순서·접힘은 패널 상태라 플러그인
 * 저장소(quota/settings)에 따로 두고, 이 값은 사용자가 고르는 설정이라 설정 화면의 섹션과 패널 바닥의
 * 글리프 토글이 같은 이 한 값을 읽고 쓴다.
 */
export interface QuotaToolbarSetting {
  /** 기본 순서로 정렬된 집합 — 표시 순서는 패널의 카드 순서를 따른다. */
  readonly toolbarProviders: readonly ProviderId[];
}

const DEFAULT_SETTING: QuotaToolbarSetting = { toolbarProviders: [] };

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
    persisted = { toolbarProviders: sanitizeFoldedProviders(value?.toolbarProviders) };
    if (pendingWrites > 0) return;
    setting = persisted;
    emit();
  }).catch(() => undefined);
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
  return writeQuotaToolbarProviders(toggledFoldedProviders(current, id));
}

/** 낙관 반영 후 저장한다. 실패하면 마지막으로 저장된 값으로 되돌린다. 쓰기는 한 줄로 세운다. */
function writeQuotaToolbarProviders(providers: readonly ProviderId[]): Promise<void> {
  pendingWrites += 1;
  const next: QuotaToolbarSetting = { toolbarProviders: providers };
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
