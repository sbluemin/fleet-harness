import type { CleanupPort } from "@fleet-console/infra/http/host-ports";
import type { EventPort } from "@fleet-console/infra/http/host-ports";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { ModelRosterHost } from "./model-ports.js";
import type { ObjectiveLaunchVariantGroup, ObjectiveLaunchVariantRow } from "../../objectives/shared/records/types.js";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { MODEL_ROSTER_CHANGED_CHANNEL, ROSTER_FALLBACK_GROUP_ID, ROSTER_FALLBACK_MODEL, isModelRosterTarget, resolveRosterCoordinate, type ModelCoordinate, type ModelRoster, type ModelRosterRow, type ModelRosterTarget, type ResolvedWireCoordinate } from "../shared/models.js";
import {
  bareModelName,
  buildGatewayModelQuota,
  CLAUDE_COMPAT_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  exposableEffortLadder,
  findClaudeGatewayModel,
  gatewayModelContextWindow,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  toClaudeGatewayModelId,
  visibleGatewayModels,
  type GatewayModel,
  type GatewayProvider,
  type GatewayReasoningEffort,
  type ProviderStatusMap,
} from "@fleet-console/ai-gateway";

/**
 * 모델 로스터 — Console의 모든 모델 선택지(새 세션·Objectives·Settings·플러그인)가 읽는 유일한 원천.
 *
 * 로그인된 공급자의 카탈로그 전체를 런치 카탈로그와 같은 `ObjectiveLaunchVariantGroup[]` 모양으로 투영한다.
 * 켠 목록(위임 후보)과는 무관하다. 행의 `launch.model`은 정준 id(실행 id)다 — Claude는 Claude Code
 * 별칭(`opus[1m]`), 나머지는 scoped id(`codex--gpt-6-luna`). 강도 축은 카탈로그 사다리 전체다.
 * Claude CLI 설치 여부와 무관하므로 Agent SDK 세션도 같은 목록을 본다.
 */

/** 런치 메뉴의 강도 어휘 원본. 채팅 좌표 칩이 같은 어휘를 쓰도록 테스트가 두 표를 맞물린다. */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
  ultra: "ULTRACODE",
};

/** launch 대상의 일상 축. max는 모델이 실제로 내놓을 때만 선다. */
const LAUNCH_ORDINARY_AXIS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Console launch 전용 sentinel — 카탈로그 사다리(GatewayReasoningEffort)의 단이 아니라 모든
 * 모델의 마지막 칩으로 무조건 서는 Claude Code 하네스 능력이다. launch payload에는
 * 이 문자열이 그대로 실리고, spawn은 launch factory가 `--effort ultracode`로 전달한다.
 */
export const ULTRACODE_LAUNCH_EFFORT = "ultra";

export function modelRosterGroupId(provider: GatewayProvider): string {
  return `gateway:${provider}`;
}

/** Claude 공급자를 맨 앞에, 나머지는 GATEWAY_PROVIDERS 순서로 — AI Gateway 로스터 화면과 같은 규칙. */
const ROSTER_PROVIDER_ORDER: readonly GatewayProvider[] = [
  "claude",
  ...GATEWAY_PROVIDERS.filter((provider) => provider !== "claude"),
];

/**
 * 빈 로스터의 launch 카탈로그 — 최후 폴백 좌표(Sonnet 1M) 한 행만 둔 띠. 실행 표면이 모델 행 없이 멈추지 않게 하고,
 * 그 띠 id로 「폴백」임을 드러낸다. 강도 축은 launch 대상의 전체 축이다(서버가 실행 시 그대로 싣는다).
 */
export function buildRosterFallbackGroup(): ObjectiveLaunchVariantGroup {
  const model = ROSTER_FALLBACK_MODEL;
  const ordinary = ["low", "medium", "high", "xhigh", "max"] as const;
  return {
    id: ROSTER_FALLBACK_GROUP_ID,
    label: "Claude",
    rows: [{
      id: model,
      label: "Sonnet",
      launch: { model },
      contextWindow: CLAUDE_COMPAT_CONTEXT_WINDOW,
      effortAxis: [...ordinary, ULTRACODE_LAUNCH_EFFORT],
      gatedEfforts: ["max", ULTRACODE_LAUNCH_EFFORT],
      chips: [...ordinary, ULTRACODE_LAUNCH_EFFORT].map((effort) => effortChip(model, effort)),
    }],
  };
}

/** 정준 id(실행 id). Claude는 Claude Code 별칭, 나머지는 scoped id. */
export function canonicalGatewayModelId(model: GatewayModel): string {
  return model.provider === "claude" ? toClaudeGatewayModelId(model) : model.id;
}

/**
 * `statuses` 부재는 로그인 상태를 아직 모르는 것이다 — 카탈로그 전체가 보인다.
 * 맵에 없는 공급자도 같다. `signed_out`·`not_connected`만 빠진다.
 */
export function buildModelRoster(target: ModelRosterTarget, statuses?: ProviderStatusMap): ModelRoster {
  const visible = visibleGatewayModels(statuses);
  const groups: ObjectiveLaunchVariantGroup[] = [];
  for (const provider of ROSTER_PROVIDER_ORDER) {
    const models = visible.filter((model) => model.provider === provider);
    if (models.length === 0) continue;
    groups.push({
      id: modelRosterGroupId(provider),
      label: GATEWAY_PROVIDER_NAMES[provider],
      rows: models.map((model) => toRosterRow(model, target)),
    });
  }
  return groups;
}

function toRosterRow(
  model: GatewayModel,
  target: ModelRosterTarget,
): ObjectiveLaunchVariantRow {
  const id = canonicalGatewayModelId(model);
  // 일상 단은 카탈로그 사다리 전체다 — ultra는 이 어휘에 없으니 여기서는 절대 나오지 않는다.
  const ordinary: readonly GatewayReasoningEffort[] = exposableEffortLadder(model);
  const contextWindow = rosterContextWindow(model, id);
  const base: ModelRosterRow = {
    id,
    // Claude 가족은 1M 한 좌표뿐이므로 이름이 곧 그 좌표다.
    label: bareModelName(model),
    launch: { model: id },
    ...buildGatewayModelQuota(model),
    ...(contextWindow ? { contextWindow } : {}),
  };
  if (target === "agent") {
    // Agent SDK 세션은 ultra를 받지 않고 게이트도 없다 — 모델이 내놓는 사다리가 곧 전체다.
    if (ordinary.length === 0) return base;
    return {
      ...base,
      effortAxis: [...ordinary],
      chips: ordinary.map((effort) => effortChip(id, effort)),
    };
  }
  const hasMax = ordinary.includes("max");
  // apex는 게이트 뒤 전용이다. max는 모델이 실제로 내놓을 때만 축에 올리고, ultra는 하네스
  // 능력이라 모델과 무관하게 끝에 선다. 강도를 아예 지원하지 않는 모델은 ULTRACODE 단독 행이다.
  const effortAxis: readonly string[] = ordinary.length === 0
    ? [ULTRACODE_LAUNCH_EFFORT]
    : [...LAUNCH_ORDINARY_AXIS.filter((effort) => effort !== "max" || hasMax), ULTRACODE_LAUNCH_EFFORT];
  const gatedEfforts: readonly string[] = hasMax ? ["max", ULTRACODE_LAUNCH_EFFORT] : [ULTRACODE_LAUNCH_EFFORT];
  return {
    ...base,
    effortAxis,
    gatedEfforts,
    chips: [...ordinary, ULTRACODE_LAUNCH_EFFORT].map((effort) => effortChip(id, effort)),
  };
}

function effortChip(model: string, effort: string) {
  return { id: effort, label: EFFORT_LABELS[effort] ?? effort.toUpperCase(), launch: { model, effort } };
}

const CLAUDE_ONE_MILLION_MARKER = "[1m]";

function rosterContextWindow(model: GatewayModel, id: string): number | undefined {
  // Claude Code는 두 좌표만 안다 — `[1m]` 표기가 1M 창을 켠다. Claude 가족의 실행 id는 늘 `[1m]`이다.
  if (model.provider === "claude") return id.endsWith("[1m]") ? CLAUDE_COMPAT_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return gatewayModelContextWindow(model) ?? undefined;
}

/** 정준 id의 Agent SDK wire id. Claude는 별칭, 나머지는 Claude Code 디스커버리 표기(`claude-gateway--…`). */
export function rosterWireModelId(canonical: string): string {
  const model = findClaudeGatewayModel(canonical);
  return model ? toClaudeGatewayModelId(model) : canonical;
}

/**
 * 플러그인 서버 포트(`ctx.host.models`)와 HTTP 라우트가 함께 쓰는 로스터 읽기. 저장값을 매번 읽으므로
 * Gateway를 저장한 직후의 요청부터 새 로스터를 본다.
 */
export function createModelRosterHost(deps: {
  /**
   * 공급자 로그인 상태. 없으면, 또는 읽기에 실패하면 상태를 모르는 것으로 보고 카탈로그 전체를 보인다.
   */
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  readonly subscribe?: (listener: () => void) => () => void;
  /** 설치된 Claude Code에게 별칭이 가리키는 버전을 묻는다. 없으면 별칭 고정은 받은 값을 돌려준다. */
  readonly ensureClaudeNativeModels?: () => Promise<void>;
}): ModelRosterHost {
  const roster = (target: ModelRosterTarget): ModelRoster => {
    let statuses: ProviderStatusMap | undefined;
    try {
      statuses = deps.readProviderStatuses?.();
    } catch {
      // 상태 조회 실패는 숨기지 않는다 — 모르는 공급자는 카탈로그에 남긴다.
      statuses = undefined;
    }
    return buildModelRoster(target, statuses);
  };
  return {
    roster,
    resolve: (stored: ModelCoordinate, target: ModelRosterTarget, fallback?: ModelCoordinate): ResolvedWireCoordinate => {
      const resolved = resolveRosterCoordinate(roster(target), stored, fallback ?? { model: ROSTER_FALLBACK_MODEL });
      return { ...resolved, wireModel: rosterWireModelId(resolved.model) };
    },
    pinClaudeVersion: async (wireModel: string): Promise<string> => {
      try {
        await deps.ensureClaudeNativeModels?.();
      } catch {
        // 조회 실패는 알던 표로 답한다 — 표가 없으면 별칭 그대로다.
      }
      const model = findClaudeGatewayModel(wireModel);
      if (model?.provider !== "claude" || model.upstreamId === undefined) return wireModel;
      return wireModel.endsWith(CLAUDE_ONE_MILLION_MARKER) ? `${model.upstreamId}${CLAUDE_ONE_MILLION_MARKER}` : model.upstreamId;
    },
    ...(deps.ensureClaudeNativeModels ? {
      warmClaudeVersions: () => { void deps.ensureClaudeNativeModels?.().catch(() => undefined); },
    } : {}),
    ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
  };
}

interface ModelRosterRouteContext {
  readonly host: {
    readonly http: Pick<HttpPort, "writeJson">;
    readonly security: Pick<HttpSecurityPort, "isTerminalAuthorized">;
    readonly events: Pick<EventPort, "publish" | "registerSseChannel">;
    readonly lifecycle: Pick<CleanupPort, "registerCleanup">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

/**
 * `GET /api/v1/models/roster?target=launch|agent` 와 변경 브로드캐스트. 운영 카탈로그에 얹지 않는 이유: 카탈로그는
 * Claude CLI가 없으면 비지만 Agent SDK 세션의 선택지는 CLI 설치와 무관해야 한다.
 *
 * 돌려주는 `notify`는 로스터가 바뀐 직후 부른다 — 열린 모든 화면(다른 탭·모바일 포함)이 다시 읽는다.
 */
export function registerModelRosterRoutes(ctx: ModelRosterRouteContext, models: ModelRosterHost): { readonly notify: () => void } {
  ctx.host.lifecycle.registerCleanup(ctx.host.events.registerSseChannel(MODEL_ROSTER_CHANGED_CHANNEL));
  ctx.registerRouter("models/roster", async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const target = new URL(req.url ?? "/", "http://localhost").searchParams.get("target") ?? "launch";
    if (!isModelRosterTarget(target)) { ctx.host.http.writeJson(res, 400, { error: "invalid_target" }); return true; }
    const roster = models.roster(target);
    // Claude 행이 있으면 버전 이름을 채우러 간다 — 응답은 기다리지 않고, 표가 바뀌면 변경 알림이 다시 읽게 한다.
    if (roster.some((group) => group.id === modelRosterGroupId("claude"))) models.warmClaudeVersions?.();
    ctx.host.http.writeJson(res, 200, { target, roster });
    return true;
  }, [{ method: "GET", path: "", summary: "Read the model roster every Console model picker shares.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  return { notify: () => ctx.host.events.publish(MODEL_ROSTER_CHANGED_CHANNEL, {}) };
}
