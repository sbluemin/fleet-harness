// 모델 로그인(provider API key 등록) 상태의 직렬화 계약.
// signedIn 불린만 노출하며, API key 값/마스킹은 절대 브라우저로 싣지 않는다(Token Boundary).

export interface ModelAuthProviderState {
  readonly cli: string;
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface ModelAuthState {
  readonly providers: readonly ModelAuthProviderState[];
}

export interface ModelAuthMutationResult {
  readonly state: ModelAuthState;
}
