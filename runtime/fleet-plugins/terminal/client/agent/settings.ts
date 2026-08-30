export interface AiGatewayModelSelection {
  readonly id: string;
  /** 정체성으로 내보낼 강도. 부재 = 이 모델의 사다리 전체. */
  readonly efforts?: readonly string[];
  readonly hostOnly?: boolean;
}

export interface AiGatewaySettings {
  readonly models?: readonly AiGatewayModelSelection[];
  /**
   * 옵트인 공급자 소진 순서. 부재 = 선호 없음. 저장 시 키 부재는 서버가 "보존"으로
   * 읽으므로, 해제는 빈 배열로만 표현된다.
   */
  readonly providerPriority?: readonly AiGatewayProviderId[];
}

export type AiGatewayProviderId = "antigravity" | "codex" | "cursor" | "kimi" | "opencode" | "xai";

/** Absent / null is Auto. `"early"` / `"late"` are 88 / 97. A number is Custom 70–99. */
export type CompactCeiling = "early" | "late" | number;

/**
 * 카탈로그가 매기는 등급 축. core-ai-gateway의 `GatewayCapabilityClass`를 그대로 옮겨 적은
 * 것으로, 브라우저 코드가 Node 계층 패키지를 끌어오지 않기 위해 이 파일의 다른 카탈로그
 * 타입과 같은 방식으로 미러링한다.
 */
export type AiGatewayCapabilityClass = "flagship" | "standard" | "light";

export interface AiGatewayCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly oneMillion: boolean;
  readonly maxMode: boolean;
  readonly fast: boolean;
  /** 부재(`null`) = 라우팅 별칭이라 어떤 단일 등급도 참이 아닌 모델. */
  readonly capabilityClass: AiGatewayCapabilityClass | null;
  readonly description: string | null;
  readonly effort: { readonly levels: readonly string[] } | null;
}

export interface AiGatewayCatalogProvider {
  readonly id: AiGatewayProviderId;
  readonly models: readonly AiGatewayCatalogModel[];
}

export interface AiGatewayCatalog {
  readonly providers: readonly AiGatewayCatalogProvider[];
}

export type ClaudeCodeSystemPromptMode = "on" | "off";

/** Which xAI endpoint a subscription turn opens on. Mirrors the gateway's own vocabulary. */
export type XaiEndpointPreference = "direct" | "cli-proxy";

export interface SystemPromptSettingsState {
  readonly agentIdleDormantMinutes: number | null;
  readonly claudeCodeSystemPrompt: ClaudeCodeSystemPromptMode;
  readonly claudeCodeSkipPermissions: boolean;
  readonly aiGateway: AiGatewaySettings | null;
  readonly aiGatewayCatalog: AiGatewayCatalog;
  readonly cursorDiagnosticsEnabled: boolean;
  readonly wireLogEnabled: boolean;
  readonly compactCeiling: CompactCeiling | null;
  readonly xaiEndpoint: XaiEndpointPreference;
}

export type SystemPromptSettingsUpdate =
  | { readonly agentIdleDormantMinutes: number | null }
  | { readonly claudeCodeSystemPrompt: ClaudeCodeSystemPromptMode }
  | { readonly claudeCodeSkipPermissions: boolean }
  | { readonly aiGateway: AiGatewaySettings | null }
  | { readonly cursorDiagnosticsEnabled: boolean }
  | { readonly wireLogEnabled: boolean }
  | { readonly compactCeiling: CompactCeiling | null }
  | { readonly xaiEndpoint: XaiEndpointPreference };

class TerminalSettingsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalSettingsApiError";
    this.status = status;
  }
}

export async function fetchSystemPromptSettings(signal?: AbortSignal): Promise<SystemPromptSettingsState> {
  const response = await fetch("/plugins/terminal/settings", { signal });
  await assertOk(response);
  return assertSystemPromptSettingsState(await response.json(), response.status);
}

export async function saveSystemPromptSettings(settings: SystemPromptSettingsUpdate, signal?: AbortSignal): Promise<SystemPromptSettingsState> {
  const response = await fetch("/plugins/terminal/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
    signal,
  });
  await assertOk(response);
  return assertSystemPromptSettingsState(await response.json(), response.status);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new TerminalSettingsApiError(response.status, message);
}

function assertSystemPromptSettingsState(value: unknown, status: number): SystemPromptSettingsState {
  const payload = value as Partial<SystemPromptSettingsState>;
  if (
    !payload
    || !isAgentIdleDormantMinutes(payload.agentIdleDormantMinutes)
    || !isClaudeCodeSystemPromptMode(payload.claudeCodeSystemPrompt)
    || typeof payload.claudeCodeSkipPermissions !== "boolean"
    || !isAiGatewayCatalog(payload.aiGatewayCatalog)
    || typeof payload.cursorDiagnosticsEnabled !== "boolean"
    || typeof payload.wireLogEnabled !== "boolean"
    || !isCompactCeiling(payload.compactCeiling)
    || !isXaiEndpointPreference(payload.xaiEndpoint)
  ) {
    throw new TerminalSettingsApiError(status, "Invalid Terminal settings response");
  }
  return {
    agentIdleDormantMinutes: payload.agentIdleDormantMinutes,
    claudeCodeSystemPrompt: payload.claudeCodeSystemPrompt,
    claudeCodeSkipPermissions: payload.claudeCodeSkipPermissions,
    aiGateway: payload.aiGateway ?? null,
    aiGatewayCatalog: payload.aiGatewayCatalog,
    cursorDiagnosticsEnabled: payload.cursorDiagnosticsEnabled,
    wireLogEnabled: payload.wireLogEnabled,
    compactCeiling: payload.compactCeiling,
    xaiEndpoint: payload.xaiEndpoint,
  };
}

function isXaiEndpointPreference(value: unknown): value is XaiEndpointPreference {
  return value === "direct" || value === "cli-proxy";
}

function isClaudeCodeSystemPromptMode(value: unknown): value is ClaudeCodeSystemPromptMode {
  return value === "on" || value === "off";
}

function isAiGatewayCatalog(value: unknown): value is AiGatewayCatalog {
  if (!value || typeof value !== "object") return false;
  const providers = (value as AiGatewayCatalog).providers;
  return Array.isArray(providers) && providers.every((provider) =>
    provider && typeof provider.id === "string" && Array.isArray(provider.models));
}

function isAgentIdleDormantMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isCompactCeiling(value: unknown): value is CompactCeiling | null {
  if (value === null) return true;
  if (value === "early" || value === "late") return true;
  return typeof value === "number" && Number.isInteger(value) && value >= 70 && value <= 99;
}

import { React } from "@fleet-console/sdk/plugin/browser";


// aiGatewayCatalog는 서버 소유 읽기 전용 투영이라 저장 필드에서 제외한다.
export type SystemPromptSettingsField = "agentIdleDormantMinutes" | "claudeCodeSystemPrompt" | "claudeCodeSkipPermissions" | "aiGateway" | "cursorDiagnosticsEnabled" | "wireLogEnabled" | "compactCeiling" | "xaiEndpoint";

interface SystemPromptSettingsStoreState {
  readonly loading: boolean;
  readonly state: SystemPromptSettingsState | null;
  readonly savingField: SystemPromptSettingsField | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: SystemPromptSettingsStoreState = {
  loading: false,
  state: null,
  savingField: null,
  error: null,
};
// 로드 세대값. 저장(낙관적 갱신)이 시작되면 증가시켜, 그 이전에 출발한 in-flight GET 응답을 폐기한다.
let loadGeneration = 0;

export function useSystemPromptSettingsStore(): SystemPromptSettingsStoreState {
  return React.useSyncExternalStore(subscribe, getSystemPromptSettingsStoreState, getSystemPromptSettingsStoreState);
}

function getSystemPromptSettingsStoreState(): SystemPromptSettingsStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadSystemPromptSettings(signal?: AbortSignal): Promise<void> {
  const generation = ++loadGeneration;
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchSystemPromptSettings(signal);
    // 저장이 끼어들어 세대가 바뀌었으면 stale 응답이므로 저장 결과를 덮지 않는다.
    if (generation !== loadGeneration) return;
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted || generation !== loadGeneration) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export async function setSystemPromptSettingsField<Field extends SystemPromptSettingsField>(
  field: Field,
  value: SystemPromptSettingsState[Field],
): Promise<boolean> {
  const current = snapshot.state;
  if (!current) return false;
  // 진행 중인 로드 응답이 이 저장 결과를 덮지 않도록 세대값을 올린다.
  loadGeneration += 1;
  const optimistic = { ...current, [field]: value };
  const update = toSettingsUpdate(field, optimistic);
  setSnapshot({ state: optimistic, savingField: field, error: null });
  try {
    const state = await saveSystemPromptSettings(update);
    setSnapshot({ state, savingField: null, error: null });
    return true;
  } catch (error) {
    setSnapshot({ state: current, savingField: null, error: toErrorMessage(error) });
    return false;
  }
}

function toSettingsUpdate(field: SystemPromptSettingsField, state: SystemPromptSettingsState): SystemPromptSettingsUpdate {
  if (field === "claudeCodeSystemPrompt") {
    return { claudeCodeSystemPrompt: state.claudeCodeSystemPrompt };
  }
  if (field === "claudeCodeSkipPermissions") {
    return { claudeCodeSkipPermissions: state.claudeCodeSkipPermissions };
  }
  if (field === "aiGateway") return { aiGateway: state.aiGateway };
  if (field === "cursorDiagnosticsEnabled") {
    return { cursorDiagnosticsEnabled: state.cursorDiagnosticsEnabled };
  }
  if (field === "wireLogEnabled") {
    return { wireLogEnabled: state.wireLogEnabled };
  }
  if (field === "compactCeiling") {
    return { compactCeiling: state.compactCeiling };
  }
  if (field === "xaiEndpoint") {
    return { xaiEndpoint: state.xaiEndpoint };
  }
  // 후미 폴백이라 분기를 빠뜨린 새 필드는 조용히 **다른 설정**을 저장한다(실측: 승인
  // 게이트를 켜면 휴면 시간이 저장됐다). 필드를 더할 때는 분기도 함께 더할 것 —
  // 그 대칭은 아래 테스트가 필드 목록 전체를 돌며 지킨다.
  return { agentIdleDormantMinutes: state.agentIdleDormantMinutes };
}

function setSnapshot(patch: Partial<SystemPromptSettingsStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
