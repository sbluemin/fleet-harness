import * as path from "node:path";

import { createDurableJsonStore, getFleetDataDir } from "@dotobokuri/core-infra";

import type { AuthService, AuthStorageData, CreateProviderAuthServiceDeps } from "./types.js";

// 공급자 API 키는 Fleet 데이터 루트의 단일 파일(`<dataDir>/auth.json`)이 소유한다.
// 파일명과 저장 키(공급자 id) 문자열은 사용자의 로그인 상태 그 자체다 — 바꾸면 조용히
// 로그아웃되므로 이 패키지가 옮겨 다녀도 두 값은 고정이다.
const PROVIDER_AUTH_FILE_NAME = "auth.json";
const AUTH_LOCK_OWNER_FILE_NAME = "owner.json";
const AUTH_LOCK_TIMEOUT_MS = 5_000;

/**
 * `auth.json`의 경로. dataDir가 없으면 **호출 시각**에 Fleet 루트를 읽는다.
 * 모듈 로드 시각에 굳히면 격리 실행이 루트를 정하기 전 값이 박혀, 격리 콘솔이 사용자의
 * 진짜 자격증명을 읽고 덮어쓴다.
 */
export function resolveProviderAuthPath(dataDir?: string): string {
  return path.join(dataDir ?? getFleetDataDir(), PROVIDER_AUTH_FILE_NAME);
}

/**
 * LLM 공급자 자격증명 저장소.
 *
 * 쓰기·읽기 안전성(0600 원자쓰기·advisory lock·symlink 방어·0700 부모)은 전부
 * core-infra의 durable JSON 원시가 소유한다. 이 모듈은 그 위에 공급자 도메인 —
 * 파일 정체성, 저장 키 네임스페이스, 항목 병합 규칙 — 만 얹는다.
 */
export function createProviderAuthService(deps: CreateProviderAuthServiceDeps = {}): AuthService {
  const authPath = deps.authPath ?? resolveProviderAuthPath(deps.dataDir);
  const store = createDurableJsonStore<AuthStorageData>({
    filePath: authPath,
    lockDir: `${authPath}.lock`,
    lockOwnerFileName: AUTH_LOCK_OWNER_FILE_NAME,
    sanitize: sanitizeAuthStore,
    sensitivity: "sensitive",
    timeoutMs: deps.timeoutMs ?? AUTH_LOCK_TIMEOUT_MS,
    tempCleanupPrefix: `${PROVIDER_AUTH_FILE_NAME}.`,
  });

  return {
    async deleteApiKey(providerId: string): Promise<boolean> {
      let deleted = false;
      store.update((data) => {
        if (!Object.prototype.hasOwnProperty.call(data, providerId)) return undefined;
        const next = { ...data };
        delete next[providerId];
        deleted = true;
        return next;
      });
      return deleted;
    },

    async getApiKey(providerId: string): Promise<string | undefined> {
      const entry = store.load()[providerId];
      return typeof entry?.key === "string" ? entry.key : undefined;
    },

    async listProviderIds(): Promise<string[]> {
      return Object.keys(store.load()).sort();
    },

    async setApiKey(providerId: string, key: string): Promise<void> {
      store.update((data) => ({
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
