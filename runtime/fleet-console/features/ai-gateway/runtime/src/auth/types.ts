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
  listProviderIds(): Promise<string[]>;
  setApiKey(providerId: string, key: string): Promise<void>;
}

export interface CreateProviderAuthServiceDeps {
  /**
   * Fleet 데이터 루트. 호스트가 자기 **유효** 루트를 넘긴다. 생략하면 `getFleetDataDir()`를
   * 호출 시점에 읽는다 — 모듈 로드 시각이 아니라, 격리 실행이 루트를 정한 뒤에.
   */
  readonly dataDir?: string;
  /** 파일 경로를 통째로 지정한다(테스트·격리 전용). 주어지면 `dataDir`보다 우선한다. */
  readonly authPath?: string;
  readonly timeoutMs?: number;
}
