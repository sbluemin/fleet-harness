export interface AuthStorageEntry {
  key: string;
  [extraField: string]: unknown;
}

export interface AuthValidationFailureMessageInput {
  providerId: string;
  status: AuthValidationFailureStatus;
  detail?: string;
}

export type AuthValidationFailureStatus =
  | "unauthorized"
  | "forbidden"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export type AuthValidationStatus = "success" | AuthValidationFailureStatus;

export interface AuthValidationRequest {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
}

export interface AuthValidationResult {
  providerId: string;
  status: AuthValidationStatus;
  detail?: string;
}

export type AuthValidationFailureResult = AuthValidationResult & {
  status: AuthValidationFailureStatus;
};

export type AuthStorageData = Record<string, AuthStorageEntry>;

export interface AuthService {
  deleteApiKey(providerId: string): Promise<boolean>;
  getApiKey(providerId: string): Promise<string | undefined>;
  getEntry(providerId: string): Promise<AuthStorageEntry | undefined>;
  setEntry(providerId: string, entry: AuthStorageEntry): Promise<void>;
  /**
   * 잠금 안에서 현재 항목을 읽어 다음 항목을 정한다. `undefined`를 돌려주면 쓰지 않는다.
   * 갱신 토큰 회전처럼 "읽은 값이 그대로일 때만 쓴다"는 비교-교체가 필요한 쓰기에 쓴다.
   * 썼으면 true다.
   */
  updateEntry(
    providerId: string,
    mutate: (current: AuthStorageEntry | undefined) => AuthStorageEntry | undefined,
  ): Promise<boolean>;
  listProviderIds(): Promise<string[]>;
  setApiKey(providerId: string, key: string): Promise<void>;
}

export interface CreateProviderAuthServiceDeps {
  /**
   * 자격증명이 사는 디렉터리 — 호스트의 Console 슬롯. `authPath`를 주지 않는다면 필수다:
   * 이 패키지는 데이터 루트를 스스로 찾지 않는다.
   */
  readonly dataDir?: string;
  /** 파일 경로를 통째로 지정한다(테스트·격리 전용). 주어지면 `dataDir`보다 우선한다. */
  readonly authPath?: string;
  /**
   * 자격증명이 예전에 살던 디렉터리들. 가장 최근 자리를 앞에 둔다. 그 안의 `auth.json`을
   * 한 번만 승계한다 — 승계하지 못하면 사용자에게는 조용한 로그아웃으로 보인다.
   */
  readonly legacyDirs?: readonly string[];
  readonly timeoutMs?: number;
}
