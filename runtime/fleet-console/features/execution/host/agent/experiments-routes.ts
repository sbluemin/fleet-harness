import type { ConsoleRuntimeContext } from "../context.js";
import type http from "node:http";

import type { OperationNode } from "@fleet-console/sdk/plugin";
import { registerRouter } from "../context.js";
import { DEFAULT_EXPERIMENT_SETTINGS, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

/**
 * Agent Operation 하나에 실험 능력(Console 사용·Computer Use)을 허용하거나 거두는 서버 몫. 설정이 꺼진
 * 실험은 404 `experiment_disabled`로 끝난다 — 켜지 않은 실험은 존재하지 않는 표면이다.
 */

const AGENT_OPERATION_TYPE = "agent";

function readExperiments(ctx: ConsoleRuntimeContext): ConsoleExperimentSettings {
  return ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
}

function getAgentOperation(ctx: ConsoleRuntimeContext, operationId: string): OperationNode | null {
  const operation = ctx.host.operations.get(operationId);
  return operation?.pluginId === null && operation.type === AGENT_OPERATION_TYPE ? operation : null;
}

export function registerExperimentRoutes(ctx: ConsoleRuntimeContext): void {
  registerRouter(ctx, "experiments", async ({ req, res, pathname }) => {
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const path = pathname.slice(`${ctx.basePath}/experiments`.length) || "/";
    const consoleUseMatch = /^\/sessions\/([^/]+)\/console-use$/u.exec(path);
    if (consoleUseMatch) return handleConsoleUse(req, res, decodeURIComponent(consoleUseMatch[1] ?? ""));
    const computerUseMatch = /^\/sessions\/([^/]+)\/computer-use$/u.exec(path);
    if (computerUseMatch) return handleComputerUse(req, res, decodeURIComponent(computerUseMatch[1] ?? ""));
    const useRequestMatch = /^\/sessions\/([^/]+)\/use-requests\/([^/]+)$/u.exec(path);
    if (useRequestMatch) return handleUseRequest(req, res, decodeURIComponent(useRequestMatch[1] ?? ""), decodeURIComponent(useRequestMatch[2] ?? ""));
    ctx.host.http.writeJson(res, 404, { error: "not_found" });
    return true;
  }, [
    { method: "POST", path: "/sessions/:sessionId/console-use", summary: "Allow or revoke Console use for an Agent Operation (experiment).", category: "Console Execution", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/computer-use", summary: "Allow or revoke Computer Use for an Agent Operation (experiment).", category: "Console Execution", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/use-requests/:requestId", summary: "Answer an Agent Operation's pending Console use or Computer Use request from its panel: decline, allow for this turn, or keep allowing.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);

  /**
   * Operation 하나에 콘솔 사용을 허용하거나 거둔다. 기록은 payload에 남고 판정은 도구 호출마다
   * 다시 읽히므로, 켜고 끄는 것이 재연결 없이 다음 호출부터 듣는다. 언어를 함께 적는 이유는
   * 거부 응답이 사용자에게 그대로 옮길 문장을 실어야 하는데 호스트 설정의 `auto`는 호스트가
   * 풀 수 없기 때문이다 — 켤 때 브라우저가 말해 준 언어를 그대로 보관한다.
   */
  async function handleConsoleUse(req: http.IncomingMessage, res: http.ServerResponse, operationId: string): Promise<boolean> {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    const body = await ctx.host.http.readJsonBody<{ readonly enabled?: unknown; readonly language?: unknown }>(req);
    if (!body || typeof body.enabled !== "boolean") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const language = body.language === "ko" ? "ko" : "en";
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) { ctx.host.http.writeJson(res, 404, { error: "operation_not_found" }); return true; }
    const payload = { ...(operation.payload ?? {}) };
    if (body.enabled) payload.consoleUse = { enabled: true, language };
    else { delete payload.consoleUse; ctx.host.useRequests?.revoke(operation.id, "console"); }
    ctx.host.operations.patch(operation.id, { payload });
    ctx.host.http.writeJson(res, 200, { consoleUse: body.enabled });
    return true;
  }

  /**
   * Operation 하나에 컴퓨터 사용을 허용하거나 거둔다 — 콘솔 사용과 같은 정책이다. 기록은 payload에
   * 남고 판정은 도구 호출마다 다시 읽힌다. 거둘 때는 그 Operation이 잡고 있던 기기도 곧바로 놓는다.
   */
  async function handleComputerUse(req: http.IncomingMessage, res: http.ServerResponse, operationId: string): Promise<boolean> {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!readExperiments(ctx).computerUse) { ctx.host.http.writeJson(res, 404, { error: "experiment_disabled" }); return true; }
    const body = await ctx.host.http.readJsonBody<{ readonly enabled?: unknown; readonly language?: unknown }>(req);
    if (!body || typeof body.enabled !== "boolean") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const language = body.language === "ko" ? "ko" : "en";
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) { ctx.host.http.writeJson(res, 404, { error: "operation_not_found" }); return true; }
    const payload = { ...(operation.payload ?? {}) };
    if (body.enabled) payload.computerUse = { enabled: true, language };
    else { delete payload.computerUse; ctx.host.useRequests?.revoke(operation.id, "computer"); ctx.host.computerUseMcp?.revokeOperation(operation.id); }
    ctx.host.operations.patch(operation.id, { payload });
    ctx.host.http.writeJson(res, 200, { computerUse: body.enabled });
    return true;
  }

  /**
   * 패널 안 허용 요청에 답한다. `always` 는 ··· 메뉴 스위치를 켜는 것과 같은 기록을 남긴 뒤 요청을 푼다 — 붙잡힌 호출은
   * 풀리자마자 판정을 다시 해 스위치를 읽는다. `turn` 은 기록 없이 이번 턴 동안만 허용하고, `deny` 는 거절로 끝낸다.
   * 컴퓨터 사용 실험이 꺼져 있으면 허용은 거절된다(카드는 설정으로 안내한다).
   */
  async function handleUseRequest(req: http.IncomingMessage, res: http.ServerResponse, operationId: string, requestId: string): Promise<boolean> {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    const requests = ctx.host.useRequests;
    if (!requests) { ctx.host.http.writeJson(res, 404, { error: "not_found" }); return true; }
    const body = await ctx.host.http.readJsonBody<{ readonly decision?: unknown; readonly capability?: unknown; readonly language?: unknown }>(req);
    const decision = body?.decision;
    const capability = body?.capability;
    if ((decision !== "deny" && decision !== "turn" && decision !== "always") || (capability !== "console" && capability !== "computer")) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) { ctx.host.http.writeJson(res, 404, { error: "operation_not_found" }); return true; }
    const pending = requests.list().requests.find((request) => request.id === requestId && request.operationId === operation.id);
    if (!pending) { ctx.host.http.writeJson(res, 404, { error: "request_not_found" }); return true; }
    if (pending.capability !== capability) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    if (decision !== "deny" && capability === "computer" && !readExperiments(ctx).computerUse) { ctx.host.http.writeJson(res, 409, { error: "experiment_disabled" }); return true; }
    if (decision === "always") {
      const language = body?.language === "ko" ? "ko" : "en";
      const payload = { ...(operation.payload ?? {}) };
      payload[capability === "console" ? "consoleUse" : "computerUse"] = { enabled: true, language };
      ctx.host.operations.patch(operation.id, { payload });
    }
    const answered = requests.answer(operation.id, requestId, decision);
    if (!answered.ok) { ctx.host.http.writeJson(res, answered.error === "request_not_found" ? 404 : 409, { error: answered.error }); return true; }
    ctx.host.http.writeJson(res, 200, { decision, capability: answered.capability });
    return true;
  }
}
