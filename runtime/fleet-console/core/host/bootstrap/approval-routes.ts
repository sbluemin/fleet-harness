import type http from "node:http";

import { ApprovalError, type ApprovalCore } from "@fleet-console/approval";
import { APPROVAL_ANSWER_ROUTE, APPROVAL_DECISIONS, APPROVAL_LIST_ROUTE } from "@fleet-console/approval/contract";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { z } from "zod";

/**
 * 승인 목록·답. 사령관 기능이 아니라 콘솔 조립이 등록한다 — 컴퓨터 사용 타입도 같은 코어를 받는다.
 * 게이트는 사령관 설명 라우트와 같다. 사람(터미널 인가)만 부르고, 사령관 도구에는 답이 없다.
 */

export const APPROVAL_LIST_PATH = `/api/v1/${APPROVAL_LIST_ROUTE}`;
export const APPROVAL_ANSWER_PATH = `/api/v1/${APPROVAL_ANSWER_ROUTE}`;

export const APPROVAL_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "POST", path: APPROVAL_LIST_PATH, summary: "Read the approval snapshot: every pending request and the ones already settled.", category: "Approvals", gate: "origin-write", transport: "http" },
  { method: "POST", path: APPROVAL_ANSWER_PATH, summary: "Answer one approval. Description and intel proposals take approve or reject. An immediate request takes always or declined. A settled request cannot be answered again.", category: "Approvals", gate: "origin-write", transport: "http" },
];

const answerBody = z.object({ id: z.string().uuid(), decision: z.enum(APPROVAL_DECISIONS) }).strict();

export function createApprovalRouter(deps: {
  readonly core: ApprovalCore;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: (req: http.IncomingMessage) => Promise<unknown>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}): RouteHandler {
  return async ({ req, res, pathname }) => {
    if (pathname !== APPROVAL_LIST_PATH && pathname !== APPROVAL_ANSWER_PATH) return false;
    if (req.method !== "POST") { deps.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!deps.isAuthorized(req)) { deps.writeJson(res, 401, { error: "unauthorized" }); return true; }
    try {
      if (pathname === APPROVAL_LIST_PATH) {
        deps.writeJson(res, 200, deps.core.snapshot());
        return true;
      }
      const parsed = answerBody.safeParse(await deps.readJsonBody(req) ?? {});
      if (!parsed.success) { deps.writeJson(res, 400, { error: "invalid_request" }); return true; }
      deps.writeJson(res, 200, { request: deps.core.answer(parsed.data.id, parsed.data.decision) });
    } catch (error) {
      if (error instanceof ApprovalError) {
        const status = error.code === "unknown_request" ? 404 : error.code === "invalid_request" || error.code === "unknown_type" ? 400 : 409;
        deps.writeJson(res, status, { error: error.code });
        return true;
      }
      throw error;
    }
    return true;
  };
}
