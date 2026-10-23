import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import type { PluginMcpTool, PluginAdmiralMcpRegistration } from "@fleet-console/sdk/mcp";
import { createWikiWorkspaceResolver } from "./wiki/index.js";

import { createCodexMcpTools } from "./wiki-mcp.js";

import { CODEX_CHANGED_EVENT, CODEX_WATCH_EVENT } from "../shared/contracts.js";
import { createCodexGateway } from "./codex/gateway.js";
import { createCodexKnowledgeWatcher } from "./codex/knowledge-watcher.js";
import { createCodexWorkspaceRouter } from "./codex/workspace-routes.js";
import { createCodexFileRouter } from "./codex/file-routes.js";

export const CODEX_MCP_SERVER_NAME = "fleet-codex";
export interface CodexFeatureDeps extends Pick<FleetPluginHostCapabilities, "knowledge" | "events" | "security" | "http" | "paths" | "server"> {
  readonly registerMcp: (name: string, tools: readonly PluginMcpTool[], options: PluginAdmiralMcpRegistration) => () => void;
}
export async function createCodexFeature(deps: CodexFeatureDeps) {
  const ctx = { host: deps };
  const cleanups: (() => void | Promise<void>)[] = [];
  const routes: { path: string; handler: RouteHandler; catalog: readonly ApiCatalogEntry[] }[] = [];
  const addRoute = (path: string, handler: RouteHandler, catalog?: ApiCatalogEntry) => routes.push({ path, handler, catalog: catalog ? [{ ...catalog, path: path + catalog.path }] : [] });
  // Wiki의 정체성은 사령관 id 하나다. 옛 위치의 위키는 라우트와 도구가 서기 전에 모두 사령관 지식으로 옮긴다 —
  // 이 슬롯의 writer는 이 프로세스 하나이고 이주는 동기라, 이주 중인 root에 닿는 요청이 없다.
  const knowledge = ctx.host.knowledge;
  const wikiWorkspaceResolver = createWikiWorkspaceResolver({ knowledge });
  wikiWorkspaceResolver.migrateAll();

  // 지식 루트 변화는 콘솔이 이미 여는 스트림에 실린다 — 자기 EventSource를 열면
  // 재접속·순서·생명주기가 콘솔과 갈라진다.
  cleanups.push(ctx.host.events.registerSseChannel(CODEX_CHANGED_EVENT));
  cleanups.push(ctx.host.events.registerSseChannel(CODEX_WATCH_EVENT));

  const watcher = createCodexKnowledgeWatcher({
    onChange: (workspaceId, scopes) => ctx.host.events.publish(CODEX_CHANGED_EVENT, { workspaceId, scopes }),
    onState: (workspaceId, state) => ctx.host.events.publish(CODEX_WATCH_EVENT, { workspaceId, state }),
  });
  cleanups.push(() => watcher.disposeAll());

  // Wiki 도구가 닿는 곳은 호스트가 실어 준 사령관(`context.commodoreId`)의 지식뿐이다 — Operation 세션에는 그 세션 소속의
  // 사령관이, 사령관 세션에는 그 사령관이 묶인다(`bindCommodore`).
  cleanups.push(deps.registerMcp(CODEX_MCP_SERVER_NAME, createCodexMcpTools(wikiWorkspaceResolver), { commodoreScoped: true }));

  const gateway = createCodexGateway({
    host: "127.0.0.1",
    version: "1",
    getPort: () => readPort(ctx),
    // 대조할 Origin은 요청을 받은 리스너의 것이다 — 콘솔의 루프백 주소로 고정하면
    // 원격 리스너로 들어온 정당한 쓰기가 자기 주소를 실었는데도 막힌다.
    allowedOriginsFor: (request) => {
      const origin = ctx.host.security.expectedOrigin(request);
      return origin ? [origin] : [];
    },
    security: {
      validateHost: (request) => ctx.host.security.validateHost(request),
      isWriteAdmitted: (request) => ctx.host.security.isWriteAdmitted(request),
    },
    wikiWorkspaceResolver,
    hasCommodore: (commodoreId) => knowledge?.root(commodoreId) != null,
    // 옛 주소의 id는 그때의 화면 맥락 id다 — 그 맥락의 사령관은 호스트가 찾는다.
    resolveLegacyWorkspace: (legacyId) => {
      const owner = knowledge?.commodoreForContext(legacyId);
      return owner?.ok ? owner.commodoreId : null;
    },
    onKnowledgeRootResolved: (workspaceId, knowledgeRoot) => watcher.watch(workspaceId, knowledgeRoot),
  });

  const workspaceRouter = createCodexWorkspaceRouter({
    resolveContext: (contextId) => knowledge ? knowledge.commodoreForContext(contextId) : { ok: false, reason: "unavailable" },
    isAuthorized: (req) => ctx.host.security.isWriteAdmitted(req),
    readJsonBody: (req) => ctx.host.http.readJsonBody(req),
    resolveWorkspace: (commodoreId) => gateway.resolveWorkspace(commodoreId),
    writeJson: (res, status, body) => ctx.host.http.writeJson(res, status, body),
  });
  addRoute("/api/v1/codex/workspace", async ({ req, res, pathname }) =>
    workspaceRouter({ req, res, pathname }), {
    method: "POST",
    path: "",
    summary: "Resolve the Codex workspace (the commodore's knowledge) for the viewed context.",
    category: "Codex",
    gate: "origin-write",
    transport: "http",
  });

  const fileRouter = createCodexFileRouter({
    getTheater: (id) => {
      const realpath = ctx.host.paths.resolveTheaterPath(id);
      return realpath ? { realpath } : null;
    },
    // 읽기 전용 POST도 파일 내용을 싣는다 — Host와 정확한 리스너 Origin을 요구한다.
    isAuthorized: (req) => ctx.host.security.validateHost(req)
      && typeof req.headers.origin === "string" && req.headers.origin === ctx.host.security.expectedOrigin(req),
    readJsonBody: (req) => ctx.host.http.readJsonBody(req),
    writeJson: (res, status, body) => ctx.host.http.writeJson(res, status, body),
  });
  for (const endpoint of ["file-peek", "file-refs"] as const) {
    addRoute(`/api/v1/codex/${endpoint}`, fileRouter, {
      method: "POST", path: "", summary: "Read contained Theater file references.",
      category: "Codex", gate: "origin-strict", transport: "http",
    });
  }

  // 매니페스트가 선언한 콘솔 경로 한 칸. 사용자가 주고받는 링크가 이 주소를 쓴다.
  addRoute("/console/codex", async ({ req, res }) => gateway.handle(req, res));
  return { routes, async dispose() { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } };
}

function readPort(ctx: { host: Pick<CodexFeatureDeps, "server"> }): number {
  const origin = ctx.host.server.origin();
  if (!origin) return 0;
  try {
    return Number(new URL(origin).port) || 0;
  } catch {
    return 0;
  }
}
