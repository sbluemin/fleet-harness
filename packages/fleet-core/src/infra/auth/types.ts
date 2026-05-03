export interface AuthStorageEntry {
  key: string;
  [extraField: string]: unknown;
}

export type AuthStorageData = Record<string, AuthStorageEntry>;

export interface AuthService {
  getApiKey(providerId: string): Promise<string | undefined>;
  setApiKey(providerId: string, key: string): Promise<void>;
  setAuthPath(path: string): void;
}
