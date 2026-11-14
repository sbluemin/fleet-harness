import type { ObjectiveRecord } from "../../../objectives/shared/records/types.js";
import type { ConsoleRuntimeContext } from "../context.js";
import type http from "node:http";


import { registerRouter } from "../context.js";
import { DEFAULT_EXPERIMENT_SETTINGS, type ConsoleExperimentSettings } from "../../../settings/shared/experiments.js";

/**
 * Agent Objective 하나에 실험 능력(Console 사용·Computer Use)을 허용하거나 거두는 서버 몫. 설정이 꺼진
 * 실험은 404 `experiment_disabled`로 끝난다 — 켜지 않은 실험은 존재하지 않는 표면이다.
 */

const AGENT_OBJECTIVE_TYPE = "agent";

function readExperiments(ctx: ConsoleRuntimeContext): ConsoleExperimentSettings {
  return ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
}

function getAgentObjective(ctx: ConsoleRuntimeContext, objectiveId: string): ObjectiveRecord | null {
  const objectiveRecord = ctx.host.objectiveRecords.get(objectiveId);
  return "agent" === AGENT_OBJECTIVE_TYPE ? objectiveRecord : null;
}

export function registerExperimentRoutes(ctx: ConsoleRuntimeContext): void {
  registerRouter(ctx, "experiments", async ({ req, res, pathname }) => {
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const path = pathname.slice(`${ctx.basePath}/experiments`.length) || "/";
    const useRequestMatch = /^\/sessions\/([^/]+)\/use-requests\/([^/]+)$/u.exec(path);
    if (useRequestMatch) return handleUseRequest(req, res, decodeURIComponent(useRequestMatch[1] ?? ""), decodeURIComponent(useRequestMatch[2] ?? ""));
    ctx.host.http.writeJson(res, 404, { error: "not_found" });
    return true;
  }, [
    { method: "POST", path: "/sessions/:sessionId/use-requests/:requestId", summary: "Answer an Agent Objective's pending Computer Use request from its panel: decline or keep allowing.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);

  /**
   * 패널 안 허용 요청에 답한다. `always` 는 이 Objective의 컴퓨터 사용을 계속 허용하는 기록을 남긴 뒤 요청을 푼다 — 붙잡힌 호출은
   * 풀리자마자 판정을 다시 해 허용을 읽는다. `deny` 는 거절로 끝낸다. `turn`(이번 작업만)은 받지 않는다.
   * 컴퓨터 사용 실험이 꺼져 있으면 허용은 거절된다(카드는 설정으로 안내한다).
   */
  async function handleUseRequest(req: http.IncomingMessage, res: http.ServerResponse, objectiveId: string, requestId: string): Promise<boolean> {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    const requests = ctx.host.useRequests;
    if (!requests) { ctx.host.http.writeJson(res, 404, { error: "not_found" }); return true; }
    const body = await ctx.host.http.readJsonBody<{ readonly decision?: unknown; readonly capability?: unknown; readonly language?: unknown }>(req);
    const decision = body?.decision;
    const capability = body?.capability;
    if (decision === "turn" || (decision !== "deny" && decision !== "always") || capability !== "computer") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const objectiveRecord = getAgentObjective(ctx, objectiveId);
    if (!objectiveRecord) { ctx.host.http.writeJson(res, 404, { error: "objectiveRecord_not_found" }); return true; }
    const pending = requests.list().requests.find((request) => request.id === requestId && request.objectiveId === objectiveRecord.id);
    if (!pending) { ctx.host.http.writeJson(res, 404, { error: "request_not_found" }); return true; }
    if (pending.capability !== capability) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    if (decision !== "deny" && !readExperiments(ctx).computerUse) { ctx.host.http.writeJson(res, 409, { error: "experiment_disabled" }); return true; }
    if (decision === "always") {
      const language = body?.language === "ko" ? "ko" : "en";
      const payload = { ...(objectiveRecord ?? {}) };
      payload.computerUse = { enabled: true, language };
      ctx.host.objectiveRecords.patch(objectiveRecord.id, { ...payload });
    }
    const answered = requests.answer(objectiveRecord.id, requestId, decision);
    if (!answered.ok) { ctx.host.http.writeJson(res, 404, { error: answered.error }); return true; }
    ctx.host.http.writeJson(res, 200, { decision, capability: answered.capability });
    return true;
  }
}
