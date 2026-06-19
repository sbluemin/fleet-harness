import type http from "node:http";

import type { CliType } from "@dotobokuri/core-unified-agent";
import {
  CLI_TO_AUTH_PROVIDER_ID,
  type AuthService,
  type AuthValidationFailureResult,
} from "@dotobokuri/fleet-infra/auth";

import type { ModelAuthMutationResult, ModelAuthProviderState, ModelAuthState } from "./model-auth-types.js";

type AuthKeyValidation =
  | { readonly providerId: string; readonly status: "success" }
  | AuthValidationFailureResult;

interface ModelAuthRouteDeps {
  readonly authService: Pick<AuthService, "setApiKey" | "deleteApiKey" | "listProviderIds">;
  readonly validateApiKey: (cli: CliType, apiKey: string) => Promise<AuthKeyValidation>;
  readonly migrateLegacyAuth: () => Promise<unknown>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface ModelAuthRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface ModelAuthProviderDefinition {
  readonly cli: CliType;
  readonly displayName: string;
}

interface SignInBody {
  readonly apiKey?: unknown;
}

// kimi 우선 — console에 노출하는 모델 로그인 provider 화이트리스트. 다른 provider(claude-zai 등)는
// 의도적으로 제외한다. 경로로 들어온 임의 cli는 이 목록 대조로만 통과한다.
const MODEL_AUTH_PROVIDERS: readonly ModelAuthProviderDefinition[] = [
  { cli: "claude-kimi", displayName: "Moonshot Kimi" },
];

// 사용자 키 거부(400)와 외부 provider 검증 자체 장애(502)를 HTTP 상태로 구분한다.
const UPSTREAM_FAILURE_STATUSES: ReadonlySet<string> = new Set(["timeout", "network", "server"]);

export function createModelAuthRouter(deps: ModelAuthRouteDeps): (context: ModelAuthRouteContext) => Promise<boolean> {
  return async function handleModelAuthRoute(context: ModelAuthRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/model-auth/state") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      // legacy 저장소(~/.fleet/agent/auth.json)만 가진 업그레이드 사용자도 정확한 signedIn을 보도록,
      // fleet-cli의 auth/launch 경로와 동일하게 store를 읽기 전 legacy를 마이그레이션한다.
      await deps.migrateLegacyAuth();
      // 상태 조회는 loopback GET이며 signedIn 불린만 반환하므로 global-settings/state와 대칭으로 게이트하지 않는다.
      deps.writeJson(res, 200, await buildModelAuthState(deps.authService));
      return true;
    }
    const cli = parseProviderPath(pathname);
    if (!cli) return false;
    const provider = MODEL_AUTH_PROVIDERS.find((entry) => entry.cli === cli);
    if (!provider) {
      deps.writeJson(res, 404, { error: "provider_not_found" });
      return true;
    }
    if (req.method === "PUT") {
      await signInProvider(req, res, deps, provider);
      return true;
    }
    if (req.method === "DELETE") {
      await signOutProvider(req, res, deps, provider);
      return true;
    }
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  };
}

export async function buildModelAuthState(
  authService: Pick<AuthService, "listProviderIds">,
): Promise<ModelAuthState> {
  const signedInIds = new Set(await authService.listProviderIds());
  return {
    providers: MODEL_AUTH_PROVIDERS.map((provider) => toProviderState(provider, signedInIds)),
  };
}

async function signInProvider(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ModelAuthRouteDeps,
  provider: ModelAuthProviderDefinition,
): Promise<void> {
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isJsonRequest(req)) {
    deps.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  const body = await deps.readJsonBody<SignInBody>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    deps.writeJson(res, 400, { error: "invalid_json" });
    return;
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length === 0) {
    deps.writeJson(res, 400, { error: "invalid_api_key" });
    return;
  }
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli];
  if (!providerId) {
    deps.writeJson(res, 500, { error: "provider_unavailable" });
    return;
  }
  // 검증은 서버에서만 수행한다 — 키는 외부 provider 검증과 로컬 저장에만 쓰이고 브라우저로 되돌려보내지 않는다.
  const validation = await deps.validateApiKey(provider.cli, apiKey);
  if (validation.status !== "success") {
    const status = UPSTREAM_FAILURE_STATUSES.has(validation.status) ? 502 : 400;
    // 실패 메시지는 console 자체 문구로 만든다 — fleet-infra 표준 메시지는 providerId(=auth.json 저장 키)와
    // upstream detail을 담으므로, 그대로 브라우저로 보내면 state DTO에서 막은 저장키가 에러 경로로 샌다(Token Boundary).
    deps.writeJson(res, status, {
      error: formatSignInFailureMessage(provider.displayName, validation.status),
      status: validation.status,
    });
    return;
  }
  await deps.authService.setApiKey(providerId, apiKey);
  await writeMutationState(res, deps);
}

async function signOutProvider(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ModelAuthRouteDeps,
  provider: ModelAuthProviderDefinition,
): Promise<void> {
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli];
  if (!providerId) {
    deps.writeJson(res, 500, { error: "provider_unavailable" });
    return;
  }
  // 현재 store에서만 삭제한다. legacy(~/.fleet/agent/auth.json) 원본 영구 제거는 fleet-cli logout과
  // 공유하는 fleet-infra/auth SSoT 한계(migrate는 복사만, deleteApiKey는 현재 store만 삭제)라 이 PR scope
  // 밖이다(후속 분리). 여기서 migrate를 호출하면 legacy를 복사만 하고 원본이 남아 다음 read에서 부활하므로,
  // 혼란을 피하려 migrate 없이 현재 store만 삭제한다.
  await deps.authService.deleteApiKey(providerId);
  await writeMutationState(res, deps);
}

async function writeMutationState(res: http.ServerResponse, deps: ModelAuthRouteDeps): Promise<void> {
  const response: ModelAuthMutationResult = { state: await buildModelAuthState(deps.authService) };
  deps.writeJson(res, 200, response);
}

function toProviderState(
  provider: ModelAuthProviderDefinition,
  signedInIds: ReadonlySet<string>,
): ModelAuthProviderState {
  // providerId(= ~/.fleet/auth.json 영속 키)는 signedIn 판정에만 쓰고 브라우저 DTO로는 내보내지 않는다(Token Boundary).
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli] ?? provider.cli;
  return {
    cli: provider.cli,
    displayName: provider.displayName,
    signedIn: signedInIds.has(providerId),
  };
}

function parseProviderPath(pathname: string): CliType | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "model-auth" || parts[1] !== "providers") return null;
  const cli = safeDecodeURIComponent(parts[2] ?? "");
  return cli ? (cli as CliType) : null;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

// displayName만 쓰는 브라우저-안전 실패 문구. providerId(저장 키)·upstream detail은 의도적으로 배제한다.
function formatSignInFailureMessage(displayName: string, status: string): string {
  switch (status) {
    case "unauthorized":
      return `${displayName} rejected the API key. Check the key and try again.`;
    case "forbidden":
      return `The API key is not allowed for ${displayName}. Check its permissions.`;
    case "timeout":
      return `Validating the ${displayName} API key timed out. Check your connection and try again.`;
    case "network":
      return `Could not reach ${displayName} to validate the API key. Check your connection and try again.`;
    case "server":
      return `${displayName} returned an error while validating the API key. Try again later.`;
    default:
      return `Could not validate the ${displayName} API key. Check the key and try again.`;
  }
}
