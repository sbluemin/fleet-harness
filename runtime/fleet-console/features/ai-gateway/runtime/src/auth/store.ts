import * as path from "node:path";

import { createDurableJsonStore, createStoreCarryOver, jsonFileExists } from "@fleet-console/infra";

import type { AuthService, AuthStorageData, CreateProviderAuthServiceDeps } from "./types.js";

// 공급자 API 키는 Console 슬롯의 단일 파일(`<dataDir>/auth.json`)이 소유한다.
// 파일명과 저장 키(공급자 id) 문자열은 사용자의 로그인 상태 그 자체다 — 바꾸면 조용히
// 로그아웃되므로 이 패키지가 옮겨 다녀도 두 값은 고정이다. 자리를 옮길 때도 마찬가지라,
// 옛 자리의 값은 `legacyDirs` 승계로 따라온다.
const PROVIDER_AUTH_FILE_NAME = "auth.json";
const AUTH_LOCK_OWNER_FILE_NAME = "owner.json";
const AUTH_LOCK_TIMEOUT_MS = 5_000;

/**
 * `auth.json`의 경로. 자리는 호스트가 정해 넘긴다 — 이 패키지는 데이터 루트를 스스로 찾지
 * 않는다. 기본값을 두면 자리를 넘기는 것을 잊은 호출자가 조용히 사용자의 다른 자격증명
 * 파일을 읽고 덮어쓴다.
 */
export function resolveProviderAuthPath(dataDir: string): string {
  return path.join(dataDir, PROVIDER_AUTH_FILE_NAME);
}

/**
 * LLM 공급자 자격증명 저장소.
 *
 * 쓰기·읽기 안전성(0600 원자쓰기·advisory lock·symlink 방어·0700 부모)은 전부
 * core-infra의 durable JSON 원시가 소유한다. 이 모듈은 그 위에 공급자 도메인 —
 * 파일 정체성, 저장 키 네임스페이스, 항목 병합 규칙 — 만 얹는다.
 */
export function createProviderAuthService(deps: CreateProviderAuthServiceDeps): AuthService {
  const { authPath: explicitPath, dataDir } = deps;
  if (explicitPath === undefined && dataDir === undefined) {
    throw new Error("Provider auth store requires either dataDir (the host's Console slot) or an explicit authPath");
  }
  const authPath = explicitPath ?? resolveProviderAuthPath(dataDir!);
  const store = createDurableJsonStore<AuthStorageData>({
    filePath: authPath,
    lockDir: `${authPath}.lock`,
    lockOwnerFileName: AUTH_LOCK_OWNER_FILE_NAME,
    sanitize: sanitizeAuthStore,
    sensitivity: "sensitive",
    timeoutMs: deps.timeoutMs ?? AUTH_LOCK_TIMEOUT_MS,
    tempCleanupPrefix: `${PROVIDER_AUTH_FILE_NAME}.`,
  });

  const carryOver = createStoreCarryOver<AuthStorageData>({
    destinationPath: authPath,
    adopted: () => jsonFileExists(authPath),
    sourcePaths: (deps.legacyDirs ?? []).map((dir) => resolveProviderAuthPath(dir)),
    // 항목이 하나라도 있으면 그것이 사용자의 로그인 상태다. 키 모양은 보지 않는다 —
    // 읽는 쪽(`getApiKey`)의 몫이고, 여기서 걸러 내면 승계가 곧 로그아웃이 된다.
    adopt: (parsed) => {
      const data = sanitizeAuthStore(parsed);
      return Object.keys(data).length > 0 ? data : undefined;
    },
  });

  /**
   * 옛 자리를 아직 읽지 못한 상태에서는 쓰지 않는다. 목적지 파일이 생기는 순간 그것이
   * "승계 끝"의 표식이 되므로, 지금 쓰면 아직 옮기지 못한 자격증명이 영영 고아가 된다 —
   * 사용자에게는 조용한 로그아웃으로 보인다. 저장은 다시 시도할 수 있지만 그쪽은 아니다.
   */
  const update = (mutate: (current: AuthStorageData) => AuthStorageData | undefined): void => {
    carryOver.probe();
    if (!carryOver.settled()) {
      throw new Error(
        `Provider credentials were not written: a previous auth file (${carryOver.sourcePaths.join(", ")}) `
        + "could not be read, and writing now would strand it. Make that file readable or remove it, then retry.",
      );
    }
    store.update((current) => mutate(carryOver.base(current)));
    carryOver.consume();
  };

  /** 읽기도 승계를 앞당긴다 — 옮기기 전에는 옛 자리의 값이 곧 현재 로그인 상태다. */
  const load = (): AuthStorageData => {
    carryOver.probe();
    if (carryOver.pending()) {
      try {
        store.update(carryOver.base);
        carryOver.consume();
      } catch {
        // 락 경합·쓰기 실패는 결론이 아니다. 승계된 값으로 이번 읽기에 답하고 다음 접근이 다시 시도한다.
        return carryOver.base(store.load());
      }
    }
    return store.load();
  };

  return {
    async deleteApiKey(providerId: string): Promise<boolean> {
      let deleted = false;
      update((data) => {
        if (!Object.prototype.hasOwnProperty.call(data, providerId)) return undefined;
        const next = { ...data };
        delete next[providerId];
        deleted = true;
        return next;
      });
      return deleted;
    },

    async getApiKey(providerId: string): Promise<string | undefined> {
      const entry = load()[providerId];
      return typeof entry?.key === "string" ? entry.key : undefined;
    },

    async listProviderIds(): Promise<string[]> {
      return Object.keys(load()).sort();
    },

    async setApiKey(providerId: string, key: string): Promise<void> {
      update((data) => ({
        ...data,
        [providerId]: {
          ...(data[providerId] ?? {}),
          key,
        },
      }));
    },
  };
}

/**
 * 최상위가 객체가 아닌 문서만 버리고, 항목은 손대지 않고 그대로 통과시킨다.
 * sanitize 결과가 곧 다음 쓰기의 내용이라, 여기서 모르는 항목을 걸러 내면 한 공급자에
 * 로그인하는 것만으로 다른 공급자의 저장 항목이 사라진다. 키 모양 검증은 읽는 쪽
 * (`getApiKey`)의 몫이다.
 */
function sanitizeAuthStore(value: unknown): AuthStorageData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as AuthStorageData;
}
