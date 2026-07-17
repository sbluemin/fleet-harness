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

export class TerminalModelAuthApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalModelAuthApiError";
    this.status = status;
  }
}

export async function fetchModelAuthState(signal?: AbortSignal): Promise<ModelAuthState> {
  const response = await fetch("/plugins/terminal/model-auth/state", { signal });
  await assertOk(response);
  return assertModelAuthState(await response.json(), response.status);
}

export async function signInModelProvider(cli: string, apiKey: string, signal?: AbortSignal): Promise<ModelAuthMutationResult> {
  const response = await fetch(`/plugins/terminal/model-auth/providers/${encodeURIComponent(cli)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
    signal,
  });
  await assertOk(response);
  return assertMutationResult(await response.json(), response.status);
}

export async function signOutModelProvider(cli: string, signal?: AbortSignal): Promise<ModelAuthMutationResult> {
  const response = await fetch(`/plugins/terminal/model-auth/providers/${encodeURIComponent(cli)}`, {
    method: "DELETE",
    signal,
  });
  await assertOk(response);
  return assertMutationResult(await response.json(), response.status);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // Non-JSON failures keep the HTTP status text.
  }
  throw new TerminalModelAuthApiError(response.status, message);
}

function assertMutationResult(value: unknown, status: number): ModelAuthMutationResult {
  const payload = value as { readonly state?: unknown };
  if (!payload || typeof payload !== "object" || !("state" in payload)) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth mutation response");
  }
  return { state: assertModelAuthState(payload.state, status) };
}

function assertModelAuthState(value: unknown, status: number): ModelAuthState {
  const payload = value as { readonly providers?: unknown };
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.providers)) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth state response");
  }
  return { providers: payload.providers.map((provider) => assertProviderState(provider, status)) };
}

function assertProviderState(value: unknown, status: number): ModelAuthProviderState {
  const payload = value as Partial<ModelAuthProviderState>;
  if (
    typeof payload.cli !== "string"
    || typeof payload.displayName !== "string"
    || typeof payload.signedIn !== "boolean"
  ) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth provider response");
  }
  return {
    cli: payload.cli,
    displayName: payload.displayName,
    signedIn: payload.signedIn,
  };
}
