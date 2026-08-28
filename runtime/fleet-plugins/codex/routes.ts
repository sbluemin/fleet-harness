import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import { createWikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";

import { CODEX_CHANGED_EVENT, CODEX_WATCH_EVENT } from "./server/codex/contracts.js";
import { createCodexGateway } from "./server/codex/gateway.js";
import { createCodexKnowledgeWatcher } from "./server/codex/knowledge-watcher.js";
import { createCodexWorkspaceRouter } from "./server/codex/workspace-routes.js";

const CODEX_PLUGIN_ID = "codex";
const MIGRATION_LOCK = "knowledge.migration.lock";

export default definePlugin({
  id: CODEX_PLUGIN_ID,
  name: "Codex",
  async register(ctx) {
    // 지식 루트 변화는 콘솔이 이미 여는 스트림에 실린다 — 자기 EventSource를 열면
    // 재접속·순서·생명주기가 콘솔과 갈라진다.
    ctx.host.lifecycle.registerCleanup(ctx.host.events.registerSseChannel(CODEX_CHANGED_EVENT));
    ctx.host.lifecycle.registerCleanup(ctx.host.events.registerSseChannel(CODEX_WATCH_EVENT));

    const watcher = createCodexKnowledgeWatcher({
      onChange: (workspaceId, scopes) => ctx.host.events.publish(CODEX_CHANGED_EVENT, { workspaceId, scopes }),
      onState: (workspaceId, state) => ctx.host.events.publish(CODEX_WATCH_EVENT, { workspaceId, state }),
    });
    ctx.host.lifecycle.registerCleanup(() => watcher.disposeAll());

    const wikiWorkspaceResolver = createWikiWorkspaceResolver({
      ensureWorkspace: (cwd: string) => {
        const workspace = ctx.host.paths.ensureWorkspaceDirectory(cwd);
        return { id: workspace.id, path: workspace.path, cwd };
      },
      withMigrationLock: <T,>(workspace: { readonly path: string }, operation: () => T): T =>
        ctx.host.paths.withDirectoryLock(path.join(workspace.path, MIGRATION_LOCK), operation),
    });

    /**
     * 진행 중인 등록의 꼬리. 이벤트 처리는 비동기라 요청이 그것을 앞지를 수 있으므로,
     * 게이트웨이가 답하기 전에 이 꼬리를 한 번 기다린다.
     */
    let registrations: Promise<unknown> = Promise.resolve();
    const track = (work: Promise<unknown>): void => {
      registrations = registrations.then(() => work).catch(() => undefined);
    };

    const gateway = createCodexGateway({
      host: "127.0.0.1",
      version: "1",
      theaterPaths: {
        canonicalize: (cwd) => ctx.host.paths.canonicalizeTheaterPath(cwd),
        hash: (canonicalCwd) => ctx.host.paths.workspaceHash(canonicalCwd),
      },
      getPort: () => readPort(ctx),
      allowedOrigins: () => {
        const origin = ctx.host.server.origin();
        return origin ? [origin] : [];
      },
      security: {
        validateHost: (request) => ctx.host.security.validateHost(request),
        isWriteAdmitted: (request) => ctx.host.security.isWriteAdmitted(request),
      },
      wikiWorkspaceResolver,
      dataDir: ctx.host.paths.fleetDataDir,
      // Theater id와 워크스페이스 id는 같은 해시다 — 모르는 워크스페이스는 Theater로 되찾는다.
      resolveWorkspaceRoot: (workspaceId) => ctx.host.paths.resolveTheaterPath(workspaceId),
      whenRegistrationsSettle: () => registrations.then(() => undefined),
      onKnowledgeRootResolved: (workspaceId, knowledgeRoot) => watcher.watch(workspaceId, knowledgeRoot),
      onWorkspaceReleased: (workspaceId) => watcher.unwatch(workspaceId),
    });

    // Theater 생명주기는 코어가 이벤트로 알린다 — 예전에는 코어가 이 등록을 직접 불렀다.
    ctx.host.lifecycle.registerCleanup(ctx.host.events.subscribe("theater:registered", (payload) => {
      track(registerTheaterWorkspace(ctx, gateway, payload));
    }));
    ctx.host.lifecycle.registerCleanup(ctx.host.events.subscribe("theater:restored", (payload) => {
      track(registerTheaterWorkspace(ctx, gateway, payload));
    }));
    ctx.host.lifecycle.registerCleanup(ctx.host.events.subscribe("theater:forgotten", (payload) => {
      const theaterId = readTheaterId(payload);
      if (theaterId) gateway.unregisterTheaterWorkspaces(theaterId);
    }));

    // 이 Theater가 위키를 가졌는가 — 코어가 추측하지 않고 소유자가 답한다.
    ctx.host.lifecycle.registerCleanup(
      ctx.host.theaterFlags.register("hasWiki", (theaterId) => gateway.getWorkspace(theaterId) !== null),
    );

    const workspaceRouter = createCodexWorkspaceRouter({
      getTheater: (theaterId) => {
        const realpath = ctx.host.paths.resolveTheaterPath(theaterId);
        return realpath ? { id: theaterId, realpath } : null;
      },
      isAuthorized: (req) => ctx.host.security.isWriteAdmitted(req),
      readJsonBody: ctx.host.http.readJsonBody,
      resolveWorkspace: (theaterId, theaterRoot) => gateway.resolveWorkspaceForTheater(theaterId, theaterRoot),
      writeJson: ctx.host.http.writeJson,
    });
    registerRouter(ctx, "/api/v1/plugins/codex/workspace", async ({ req, res, pathname }) =>
      workspaceRouter({ req, res, pathname }), {
      method: "POST",
      path: "",
      summary: "Resolve the Codex workspace for a Theater.",
      category: "Codex Plugin",
      gate: "origin-write",
      transport: "http",
    });

    // 매니페스트가 선언한 콘솔 경로 한 칸. 사용자가 주고받는 링크가 이 주소를 쓴다.
    registerRouter(ctx, "/console/codex", async ({ req, res }) => gateway.handle(req, res));
  },
});

async function registerTheaterWorkspace(
  ctx: FleetPluginServerContext,
  gateway: ReturnType<typeof createCodexGateway>,
  payload: unknown,
): Promise<void> {
  const theaterId = readTheaterId(payload);
  if (!theaterId) return;
  const root = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!root) return;
  await gateway.registerWorkspace(root, undefined, theaterId);
}

function readTheaterId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { readonly theaterId?: unknown }).theaterId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPort(ctx: FleetPluginServerContext): number {
  const origin = ctx.host.server.origin();
  if (!origin) return 0;
  try {
    return Number(new URL(origin).port) || 0;
  } catch {
    return 0;
  }
}
