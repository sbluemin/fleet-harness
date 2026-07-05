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

export interface CreateAuthServiceDeps {
  readonly authPath?: string;
}
