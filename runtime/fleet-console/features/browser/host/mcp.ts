import { randomUUID } from "node:crypto";
import { createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer } from "@fleet-console/agent-runtime/claude";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { z } from "zod";
import type { AdmiralMcpSession } from "../../execution/shared/admiral-mcp.js";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";
import { DESKTOP_BROWSER_DEFAULT_SPACE_ID, commodoreBrowserSpaceId, commodoreOfBrowserSpace } from "@fleet-console/protocol/desktop";
import { GLOBAL_BROWSER_OWNER_ID, invalidTargetMessage, type BrowserCaller, type BrowserService } from "./service.js";
import { BROWSER_MCP_INSTRUCTIONS, createBrowserToolSpecs, type BrowserToolCtx, type BrowserToolDeps } from "./tools.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";
import { objectiveIdFromSessionLabel } from "../../computer-use/host/mcp.js";

export const FLEET_BROWSER_MCP_SERVER = "fleet-browser";
export const SESSION_BROWSER_OWNER_PREFIX = "plugin-browser:";
export const STANDALONE_BROWSER_OWNER_PREFIX = "standalone-cli:";

export interface BrowserMcpDeps extends BrowserToolDeps {
  readonly transport?: McpHttpTransport;
  readonly service: BrowserService;
  readonly onFailure?: (kind: string, error: unknown) => void;
  readonly objectiveRecords: () => readonly ObjectiveRecord[];
  readonly resolveObjective?: (id: string) => ObjectiveRecord | null;
  /**
   * 호출한 세션 → 사용 컨텍스트. 자식 세션은 루트(contextId)의 브라우저를 함께 쓰고, 턴 종료·중단은 그 세션(participantId)의
   * 호출만 끊는다. 없으면 두 값이 호출한 Objective 자신이다. 실행 도메인이 계보로 풀고 부트스트랩이 주입한다.
   */
  readonly useContext?: (objectiveId: string) => { readonly contextId: string; readonly participantId: string } | null;
  readonly language?: () => "en" | "ko" | null;
  /** 그 사령관이 있는가 — 사령관 scope(`commodore:<id>`)와 그 사령관의 Objective 는 있는 사령관의 스페이스에만 선다. */
  readonly commodoreExists?: (commodoreId: string) => boolean;
}

/** 호출한 세션의 사용 범위 — 주인(contextId)과 참가자(participantId). */
function scopeOf(deps: BrowserMcpDeps, objectiveId: string): { readonly contextId: string; readonly participantId: string } {
  return deps.useContext?.(objectiveId) ?? { contextId: objectiveId, participantId: objectiveId };
}

/**
 * Objective 세션의 브라우저 자리 — 브라우저는 Console 전역이고, 스페이스는 그 Objective 를 소유한 사령관의 것이다.
 * 사령관, 그 사령관의 모든 Objective 의 지휘관과 구성원(자식 세션)이 같은 스페이스를 쓰고 작업 탭은 각자(participantId) 고른다.
 * 묶음(ownerId)은 루트 Objective 다 — 그 Objective 를 거둘 때 그것이 연 탭만 닫는다. 사령관을 모르거나 사령관이 없으면 디폴트 스페이스에 선다.
 */
function placeOf(deps: BrowserMcpDeps, root: ObjectiveRecord, participantId: string): BrowserCaller & { readonly browserId: string } {
  const commodoreId = typeof root.commodoreId === "string" && root.commodoreId ? root.commodoreId : null;
  const spaceId = commodoreId && deps.commodoreExists?.(commodoreId) !== false ? commodoreBrowserSpaceId(commodoreId) : DESKTOP_BROWSER_DEFAULT_SPACE_ID;
  return { browserId: BROWSER_GLOBAL_ID, spaceId, ownerId: root.id, participantId };
}

type BrowserRefusal = "caller_unresolved" | "desktop_required" | "unmanaged";

const REFUSAL_INSTRUCTION: Record<BrowserRefusal, string> = {
  caller_unresolved: "This session has no active Console browser binding, so the Fleet Browser can never answer it. Do not retry and do not ask the user to change a setting. Continue without the browser.",
  unmanaged: "This Console is not managed by Fleet Desktop. Do not retry or substitute a remote Desktop; continue without Fleet Browser.",
  desktop_required: "This Console's managing Fleet Desktop is disconnected. Do not retry until the user reconnects it.",
};

const REFUSAL_MESSAGE: Record<BrowserRefusal, Record<"en" | "ko", string>> = {
  caller_unresolved: {
    en: "This session has no active Console browser binding, so the Fleet Browser is unavailable to it.",
    ko: "이 세션에는 활성 Console 브라우저 연결이 없어 플릿 브라우저를 쓸 수 없습니다.",
  },
  unmanaged: {
    en: "This Console is not managed by Fleet Desktop, so the Fleet Browser is unavailable.",
    ko: "이 Console은 Fleet Desktop이 관리하지 않아 플릿 브라우저를 쓸 수 없습니다.",
  },
  desktop_required: {
    en: "This Console's managing Fleet Desktop is disconnected, so the Fleet Browser is unavailable.",
    ko: "이 Console을 관리하는 Fleet Desktop 연결이 끊겨 플릿 브라우저를 쓸 수 없습니다.",
  },
};

function refuse(reason: BrowserRefusal, objectiveId: string | null, language: "en" | "ko") {
  const retryable = reason === "desktop_required";
  return { content: [{ type: "text" as const, text: JSON.stringify({
    error: "browser_not_authorized", reason, retryable, retryAfter: retryable ? "user_action" : "never",
    remedy: { actor: "none", surface: "none", path: [] },
    agentInstruction: REFUSAL_INSTRUCTION[reason], message: REFUSAL_MESSAGE[reason][language],
  }) }], isError: true };
}

function refusalForAvailability(availability: { readonly available: boolean; readonly host: string | null; readonly executionHost?: { readonly status?: string } }): BrowserRefusal | null {
  if (availability.available) return null;
  if (availability.executionHost?.status === "unmanaged" || (availability.executionHost === undefined && availability.host === null)) return "unmanaged";
  return "desktop_required";
}

function deny(
  deps: BrowserMcpDeps,
  sessionLabel: string | undefined,
  standalonePlaces?: ReadonlyMap<string, BrowserCaller & { readonly browserId: string }>,
) {
  const id = objectiveIdFromSessionLabel(sessionLabel);
  const fallback = deps.language?.() ?? "en";
  // 독립 CLI 세션은 등록된 자리로만 풀며, 미등록·해제된 독립 라벨은 Objective 로 떨어지지 않는다.
  const standalonePlace = standalonePlaces?.get(id);
  if (standalonePlace) {
    const availability = deps.service.availability();
    const refusal = refusalForAvailability(availability);
    if (refusal) return { denied: refuse(refusal, standalonePlace.browserId, fallback), place: standalonePlace };
    return { denied: null, place: standalonePlace };
  }
  // 전역 브라우저 id 와 일반·독립 세션 별칭은 Objective 호출자로 풀지 않는다.
  const objectiveRecord = id === GLOBAL_BROWSER_OWNER_ID
    || id.startsWith(SESSION_BROWSER_OWNER_PREFIX)
    || id.startsWith(STANDALONE_BROWSER_OWNER_PREFIX)
    ? null
    : deps.resolveObjective?.(id) ?? deps.objectiveRecords().find((op) => op.id === id);
  if (!objectiveRecord) return { denied: refuse("caller_unresolved", null, fallback), place: null };
  // 자식 세션은 루트와 같은 스페이스·같은 묶음에 선다 — 같은 탭 집합, 작업 탭은 각자.
  const scope = scopeOf(deps, objectiveRecord.id);
  const root = scope.contextId === objectiveRecord.id ? objectiveRecord : deps.resolveObjective?.(scope.contextId) ?? deps.objectiveRecords().find((op) => op.id === scope.contextId);
  if (!root) return { denied: refuse("caller_unresolved", null, fallback), place: null };
  const place = placeOf(deps, root, scope.participantId);
  // 브라우저는 Desktop 앱의 것이다 — 창을 든 Desktop 이 있고 브라우저·모바일 화면이 없을 때만 열린다.
  const availability = deps.service.availability();
  const refusal = refusalForAvailability(availability);
  if (refusal) return { denied: refuse(refusal, place.browserId, fallback), place };
  return { denied: null, place };
}

/**
 * 대상의 모든 갈래가 어긋나면 zod 는 그 자리에 「Invalid input」만 남긴다. 모델이 무엇을 섞었는지 알도록
 * 받은 필드를 담은 문구로 바꾼다. 거부 여부는 그대로다.
 */
function describeArgumentIssue(args: unknown, issue: { code: string; path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String);
  const last = path.at(-1);
  if (issue.code === "invalid_union" && (last === "target" || last === "within")) {
    let value: unknown = args;
    for (const key of issue.path) value = typeof value === "object" && value !== null ? (value as Record<PropertyKey, unknown>)[key] : undefined;
    return `${path.join(".")}: ${invalidTargetMessage(value, last === "within" && path.at(-2) === "target")}`;
  }
  return `${path.join(".")}: ${issue.message}`;
}

export interface BrowserPluginOptions {
  readonly pluginId: string;
  readonly scopeId: string;
  readonly enabled: () => boolean;
}

export interface BrowserPluginConnection {
  readonly embeddedServer: ClaudeGatewayMcpServer;
  readonly toolNames: readonly string[];
  endTurn(): void;
  dispose(): Promise<void>;
}

export interface BrowserMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/**
 * Session Browser MCP 서버. 도구는 세션이 열릴 때부터 실려 있고, 로컬 전용 여부만 호출마다 다시 판정한다.
 */
export function createBrowserMcpHost(deps: BrowserMcpDeps) {
  const connections = new Set<BrowserMcpConnection>();
  // 일반 세션의 공간 별칭은 Console 실행 동안 유지하되, 그 연결과 탭은 세션이 끝날 때 회수한다.
  const pluginOwners = new Map<string, string>();
  const pluginConnections = new Map<string, BrowserPluginConnection>();
  // 독립 CLI 세션의 브라우저 자리. PTY 가 살아 있는 동안 사령관 스페이스에 자기 묶음으로 서고, 종료 시 자기 탭만 회수한다.
  const standalonePlaces = new Map<string, BrowserCaller & { readonly browserId: string }>();
  const ownerKey = (pluginId: string, scopeId: string) => JSON.stringify([pluginId, scopeId]);
  /** 사령관 세션의 scope(`commodore:<id>`)는 곧 그 사령관의 공간 id 다. 없는 사령관이면 null. */
  const commodoreScope = (pluginId: string, scopeId: string): string | null => {
    if (pluginId !== "commodore") return null;
    const commodoreId = commodoreOfBrowserSpace(scopeId);
    return commodoreId && deps.commodoreExists?.(commodoreId) !== false ? commodoreBrowserSpaceId(commodoreId) : null;
  };
  const specs = createBrowserToolSpecs(deps);
  let disposed = false;
  return {
    connect(): BrowserMcpConnection {
      if (disposed) throw new Error("Browser MCP host is disposed");
      const controller = new AbortController();
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      for (const spec of specs) {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({ ...spec, execute: (args, context) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ error: "browser_arguments_invalid", issues: parsed.success ? [] : parsed.error.issues.map((issue) => describeArgumentIssue(args, issue)) }) }], isError: true });
          const { denied, place } = deny(deps, context.sessionLabel, standalonePlaces);
          if (denied || !place) return Promise.resolve(denied ?? refuse("caller_unresolved", null, "en"));
          const signals = [controller.signal, ...(context.signal ? [context.signal] : [])];
          // 세션 라벨 자리에 전역 브라우저 id 를 실어 보낸다. 부른 참가자와 그 스페이스·묶음은 따로 싣는다.
          const toolContext: BrowserToolCtx = { ...context, sessionLabel: place.browserId, participantId: place.participantId, spaceId: place.spaceId, ownerId: place.ownerId, signal: AbortSignal.any(signals) };
          return spec.execute(parsed.data, toolContext);
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_BROWSER_MCP_SERVER }, instructions: BROWSER_MCP_INSTRUCTIONS, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_BROWSER_MCP_SERVER, runtime: { registry, snapshotStore, server, onFailure: deps.onFailure } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const connection: BrowserMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Browser MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => { if (closed) throw new Error("Browser MCP disposed"); return manager.issueSessionToken(request); },
        // 이 세션(참가자)의 턴이 끝났다 — 그 참가자의 호출만 끊는다. 같은 브라우저를 쓰는 다른 참가자의 호출은 그대로 간다.
        cancelSession: (label) => {
          const id = objectiveIdFromSessionLabel(label);
          const participantId = standalonePlaces.get(id)?.participantId ?? scopeOf(deps, id).participantId;
          deps.service.interruptParticipant(participantId);
        },
        releaseSessionToken: (label) => {
          const id = objectiveIdFromSessionLabel(label);
          const participantId = standalonePlaces.get(id)?.participantId ?? scopeOf(deps, id).participantId;
          deps.service.interruptParticipant(participantId);
          manager.releaseSessionToken(label);
        },
        cleanup: () => { manager.cleanup(); },
        dispose: () => {
          if (closing) return closing;
          closed = true;
          controller.abort();
          manager.cleanup();
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
    },
    /** 라우트의 `:id` 가 세션 문맥 별칭인가 — 사령관 scope 이거나, 연결된 적 있는 일반·독립 세션의 별칭이다. */
    isSessionOwner(id: string): boolean {
      if (id === GLOBAL_BROWSER_OWNER_ID) return false;
      const commodoreId = commodoreOfBrowserSpace(id);
      if (commodoreId) return deps.commodoreExists?.(commodoreId) === true;
      if ([...standalonePlaces.values()].some((place) => place.ownerId === id)) return true;
      return [...pluginOwners.values()].includes(id);
    },
    /** 독립 CLI PTY 에 fleet-browser HTTP MCP 자리를 배정한다 — 사령관이 있으면 그 사령관의 스페이스에 자기 묶음으로 선다. */
    registerStandaloneSession(sessionLabel: string, options: { readonly commodoreId: string | null }): void {
      if (disposed) throw new Error("Browser MCP host is disposed");
      const commodoreId = typeof options.commodoreId === "string" && options.commodoreId ? options.commodoreId : null;
      const spaceId = commodoreId && deps.commodoreExists?.(commodoreId) !== false
        ? commodoreBrowserSpaceId(commodoreId)
        : DESKTOP_BROWSER_DEFAULT_SPACE_ID;
      const ownerId = sessionLabel.startsWith(STANDALONE_BROWSER_OWNER_PREFIX)
        ? sessionLabel
        : `${STANDALONE_BROWSER_OWNER_PREFIX}${sessionLabel}`;
      standalonePlaces.set(sessionLabel, { browserId: BROWSER_GLOBAL_ID, spaceId, ownerId, participantId: ownerId });
    },
    /** 독립 CLI PTY 가 끝났다 — 진행 중 호출을 끊고 그 CLI 가 연 탭과 스크린샷만 거둔다. 같은 스페이스의 사령관과 다른 CLI 탭은 보존한다. */
    async releaseStandaloneSession(sessionLabel: string): Promise<void> {
      const place = standalonePlaces.get(sessionLabel);
      if (!place) return;
      standalonePlaces.delete(sessionLabel);
      deps.service.interrupt(BROWSER_GLOBAL_ID, place.participantId);
      deps.service.endAgentSession(BROWSER_GLOBAL_ID, "turn", place.participantId);
      deps.service.forgetParticipant(place.participantId);
      deps.screenshots?.release(place.ownerId);
      await deps.service.closeOwner(place.ownerId);
    },
    connectPlugin(options: BrowserPluginOptions): BrowserPluginConnection {
      if (disposed) throw new Error("Browser MCP host is disposed");
      if (!options.pluginId || !options.scopeId || options.scopeId.length > 256) throw new Error("browser_scope_invalid");
      const key = ownerKey(options.pluginId, options.scopeId);
      // 모든 세션이 전역 브라우저를 쓴다. 사령관 세션은 그 사령관의 스페이스에, 사령관에 묶이지 않은 세션은 디폴트 스페이스에 자기 묶음으로 선다.
      const commodore = commodoreScope(options.pluginId, options.scopeId);
      const owner = commodore ?? pluginOwners.get(key) ?? `${SESSION_BROWSER_OWNER_PREFIX}${randomUUID()}`;
      if (options.pluginId === "commodore" && !commodore) throw new Error("browser_scope_invalid");
      const spaceId = commodore ?? DESKTOP_BROWSER_DEFAULT_SPACE_ID;
      const participantId = commodore ? `${options.pluginId}-session:${options.scopeId}` : owner;
      if (pluginConnections.has(participantId)) throw new Error("browser_scope_in_use");
      const controller = new AbortController();
      const calls = new Set<AbortController>();
      let closed = false;
      let closing: Promise<void> | null = null;
      const language = () => deps.language?.() ?? "en";
      const endTurn = () => {
        for (const call of calls) call.abort();
        calls.clear();
        deps.service.interrupt(BROWSER_GLOBAL_ID, participantId);
        deps.service.endAgentSession(BROWSER_GLOBAL_ID, "turn", participantId);
      };
      const tools = createBrowserToolSpecs({ ...deps, screenshotDelivery: "inline" }).map((spec) => {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
        return defineTool(spec.id, spec.description, schema.shape, async (args) => {
          if (closed || controller.signal.aborted || !options.enabled()) return refuse("caller_unresolved", null, language());
          const availability = deps.service.availability();
          const refusal = refusalForAvailability(availability);
          if (refusal) return refuse(refusal, owner, language());
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { content: [{ type: "text", text: JSON.stringify({ error: "browser_arguments_invalid", issues: parsed.error.issues.map((issue) => describeArgumentIssue(args, issue)) }) }], isError: true };
          const call = new AbortController();
          calls.add(call);
          try {
            // 호출자는 브라우저나 스페이스를 바꿀 수 없다. 다른 스페이스의 탭은 도구 경계에서 읽기만 허용한다.
            const toolContext: BrowserToolCtx = { cwd: "", sessionLabel: BROWSER_GLOBAL_ID, participantId, spaceId, ownerId: owner, signal: AbortSignal.any([controller.signal, call.signal]) };
            const result = await spec.execute(parsed.data, toolContext);
            if (closed || call.signal.aborted || !options.enabled()) return refuse("caller_unresolved", null, language());
            return result as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean };
          } finally { calls.delete(call); }
        });
      });
      const connection: BrowserPluginConnection = {
        embeddedServer: createEmbeddedMcpServer({ name: FLEET_BROWSER_MCP_SERVER, tools, instructions: BROWSER_MCP_INSTRUCTIONS }),
        toolNames: specs.map((spec) => spec.id),
        endTurn,
        dispose() {
          if (closing) return closing;
          closed = true;
          controller.abort();
          endTurn();
          // 사령관 탭은 세션이 끝나도 남긴다. 일반 세션은 자기가 연 탭만 거두고 전역 컨텍스트와 디폴트 스페이스의 나머지는 보존한다.
          deps.service.forgetParticipant(participantId);
          if (commodore) { pluginConnections.delete(participantId); closing = Promise.resolve(); return closing; }
          deps.screenshots?.release(owner);
          closing = deps.service.closeOwner(owner).finally(() => { pluginConnections.delete(participantId); });
          return closing;
        },
      };
      if (!commodore) pluginOwners.set(key, owner);
      pluginConnections.set(participantId, connection);
      return connection;
    },
    /** 한 Objective 를 거둘 때 — 그 Objective 가 연 탭을 닫고 그 참가자들의 진행 중 호출을 끊는다. 같은 스페이스의 사령관과 다른 Objective 는 그대로다. */
    revokeObjective(objectiveId: string): Promise<void> {
      const closing = deps.service.closeOwner(objectiveId);
      // 스크린샷은 사람이 본 페이지의 사본이다 — 브라우저를 거둘 때 함께 거둔다.
      deps.screenshots?.release(objectiveId);
      return closing;
    },
    /** 턴이 끝났다 — 그 참가자를 사용 세션에서 빼고, 남은 참가자가 없을 때만 표시를 내린다. 실행 런타임의 턴 종료 훅이 부른다. */
    endAgentSession(objectiveId: string): void { const scope = scopeOf(deps, objectiveId); deps.service.endParticipant(scope.participantId, "turn"); },
    toolNames: specs.map((spec) => spec.id),
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections, ...pluginConnections.values()].map((connection) => connection.dispose()));
      standalonePlaces.clear();
      pluginOwners.clear();
      await deps.service.dispose();
      deps.screenshots?.cleanup();
    },
  };
}

export type BrowserMcpHost = ReturnType<typeof createBrowserMcpHost>;
