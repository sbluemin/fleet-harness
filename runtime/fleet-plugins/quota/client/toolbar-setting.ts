import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

/**
 * 「도구모음에 요약 표시」 — 기본은 꺼짐(옵트인). 값은 Console 설정의 플러그인 문서(plugins.quota)에 산다.
 * 카드 순서·접힘은 패널 상태라 플러그인 저장소(quota/settings)에 따로 두고, 이 값은 사용자가 고르는 설정이라
 * 설정 화면의 섹션과 패널 바닥 토글이 같은 이 한 값을 읽고 쓴다.
 */
export interface QuotaToolbarSetting {
  readonly toolbarSummary: boolean;
}

const DEFAULT_SETTING: QuotaToolbarSetting = { toolbarSummary: false };

let setting: QuotaToolbarSetting = DEFAULT_SETTING;
let persisted: QuotaToolbarSetting = DEFAULT_SETTING;
/** 플러그인 문서 전체 — 다른 필드가 생겨도 이 쓰기가 지우지 않게 통째로 들고 있다가 덮어 쓴다. */
let document_: Record<string, unknown> = {};
let capability: ClientSettingsCapability | null = null;
const listeners = new Set<() => void>();
let writeChain: Promise<unknown> = Promise.resolve();

function emit(): void {
  for (const listener of listeners) listener();
}

export function connectQuotaToolbarSetting(next: ClientSettingsCapability): () => void {
  capability = next;
  void next.read("quota").then((value) => {
    if (capability !== next) return;
    document_ = value ?? {};
    setting = persisted = { toolbarSummary: value?.toolbarSummary === true };
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

/** 낙관 반영 후 저장한다. 실패하면 마지막으로 저장된 값으로 되돌린다. 쓰기는 한 줄로 세운다. */
export function writeQuotaToolbarSummary(enabled: boolean): Promise<void> {
  const run = writeChain.then(async () => {
    setting = { toolbarSummary: enabled };
    emit();
    const nextDocument = { ...document_, toolbarSummary: enabled };
    try {
      await capability?.write("quota", nextDocument);
      document_ = nextDocument;
      persisted = setting;
    } catch (error) {
      setting = persisted;
      emit();
      throw error;
    }
  });
  writeChain = run.catch(() => undefined);
  return run;
}
