import type http from "node:http";

import type { HttpPort, HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { z } from "zod";

import {
  TASKFORCE_ROUTE_NAMES,
  taskforceCreateSchema,
  taskforceIdOnlySchema,
  taskforceImageQuerySchema,
  taskforceMembersAddSchema,
  taskforceMembersRemoveSchema,
  taskforcePostSchema,
  taskforceReadSchema,
  taskforceUpdateSchema,
  type TaskforceJudgingStatus,
  type TaskforceState,
} from "../../shared/contracts/taskforce.js";
import { TaskforceStoreError } from "./errors.js";
import type { TaskforceStore } from "./store.js";

/**
 * TaskForce 라우트 — 사령관 라우트와 같은 문법이다. 사람 화면이 부르는 POST + JSON이
 * 주이고 이미지 사본 읽기만 GET이며, 같은 origin의 Console만 지난다. 화면은 응답이
 * 아니라 `commodore` 채널의 `taskforce-*` 사건으로 갱신되므로 응답은 확인용이다.
 *
 * 닫힌 TF의 말(post)은 기록에 남기기 전에 거절한다 — 조용히 잃지 않는다.
 * system 항목(종료·재열기·퇴장)은 닫힌 TF에도 남는다.
 */

export interface TaskforceRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

export interface TaskforceRouteContext {
  readonly host: { readonly http: HttpPort; readonly security: HttpSecurityPort };
}

export interface TaskforceRouteHooks {
  /** 아는 사령관인가 — 성원 검증이 여기에 기대어 선다. 없으면 모양만 검사한다. */
  readonly isKnownCommodore?: (commodoreId: string) => boolean;
}

export function createTaskforceRoutes(
  ctx: TaskforceRouteContext,
  store: TaskforceStore,
  hooks: TaskforceRouteHooks = {},
): readonly TaskforceRoute[] {
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>) => Promise<unknown> | unknown): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const value = await run(parsed.data);
      ctx.host.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) { fail(res, error); }
    return true;
  };
  const fail = (res: http.ServerResponse, error: unknown) => {
    if (error instanceof TaskforceStoreError) {
      const status = error.code === "unknown_taskforce" ? 404
        : error.code === "invalid_request" ? 400
        : error.code === "taskforce_closed" ? 409
        : 500;
      ctx.host.http.writeJson(res, status, error.details ? { error: error.code, details: error.details } : { error: error.code });
      return;
    }
    const code = error instanceof Error ? error.message : "taskforce_failed";
    ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "taskforce_failed" });
  };
  const known = (commodoreId: string): void => {
    if (hooks.isKnownCommodore && !hooks.isKnownCommodore(commodoreId)) throw new TaskforceStoreError("invalid_request");
  };
  const read = (taskforceId: string) => {
    const state = store.read(taskforceId);
    if (!state) throw new TaskforceStoreError("unknown_taskforce");
    return state;
  };
  /** 읽을 때의 판단 스냅샷 — 사건과 같은 모양에서 `op`만 뺀다. 아직 판단이 없으면 빈 모습이다. */
  const judgingOf = (state: TaskforceState): TaskforceJudgingStatus => state.judging
    ? { taskforceId: state.id, judging: [...state.judging.judging], outcomes: { ...state.judging.outcomes }, at: state.judging.at }
    : { taskforceId: state.id, judging: [], outcomes: {}, at: 0 };

  const image: RouteHandler = ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const parsed = taskforceImageQuerySchema.safeParse(Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams));
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const { taskforceId, seq, imageId } = parsed.data;
    const found = store.readImage(taskforceId, seq, imageId);
    if (!found) { ctx.host.http.writeJson(res, 404, { error: "attachment_not_found" }); return true; }
    res.writeHead(200, { "Content-Type": found.mime, "Content-Length": found.bytes.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(found.bytes);
    return true;
  };

  return [
    { name: TASKFORCE_ROUTE_NAMES.list, method: "POST", summary: "List TaskForces with their last ledger preview.", handler: json(z.object({}).strict(), () => ({ taskforces: store.list() })) },
    { name: TASKFORCE_ROUTE_NAMES.create, method: "POST", summary: "Create a TaskForce with at least two participating Commodores; the topic is posted as the created entry.", handler: json(taskforceCreateSchema, ({ name, topic, members }) => {
      for (const member of members) known(member);
      const { state, entry } = store.create({ name, topic, members });
      return { taskforce: state, entry };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.read, method: "POST", summary: "Read a TaskForce with a page of its ledger, newest last.", handler: json(taskforceReadSchema, ({ taskforceId, limit, before }) => {
      const taskforce = read(taskforceId);
      return { taskforce, judging: judgingOf(taskforce), ...store.readLedger(taskforceId, { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) }) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.post, method: "POST", summary: "Post the person's utterance to an open TaskForce.", handler: json(taskforcePostSchema, ({ taskforceId, text, mentions = [], replyTo, images = [] }) => {
      read(taskforceId);
      for (const member of mentions) known(member);
      const decoded = images.map((image) => {
        let bytes: Buffer;
        try { bytes = Buffer.from(image.dataBase64, "base64"); }
        catch { throw new TaskforceStoreError("invalid_request"); }
        if (!bytes.byteLength) throw new TaskforceStoreError("invalid_request");
        return { name: image.name, mime: image.mime, bytes };
      });
      // 이미지 사본을 먼저 땅에 두고 원장을 덧붙인다 — seq가 어긋나면(같은 TF의 동시 post)
      // 사본 디렉터리를 실제 seq로 옮기고, append가 거절하면 우리가 둔 파일만 거둔다.
      const provisional = seqOf(store, taskforceId) + 1;
      const saved = decoded.length ? store.saveImages(taskforceId, provisional, decoded) : [];
      try {
        const { state, entry } = store.append(taskforceId, {
          speaker: { kind: "person" }, text, mentions,
          ...(replyTo !== undefined ? { replyTo } : {}),
          ...(saved.length ? { images: saved } : {}),
        });
        if (saved.length && entry.seq !== provisional) store.moveImages(taskforceId, provisional, entry.seq);
        return { taskforce: state, entry };
      } catch (error) {
        if (saved.length) store.removeImages(taskforceId, provisional, saved.map((image) => image.id));
        throw error;
      }
    }) },
    { name: TASKFORCE_ROUTE_NAMES.update, method: "POST", summary: "Rename a TaskForce or rewrite its topic.", handler: json(taskforceUpdateSchema, ({ taskforceId, name, topic }) => {
      read(taskforceId);
      return { taskforce: store.update(taskforceId, { ...(name !== undefined ? { name } : {}), ...(topic !== undefined ? { topic } : {}) }) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.addMembers, method: "POST", summary: "Add Commodores to a TaskForce; a member-added system entry is appended.", handler: json(taskforceMembersAddSchema, ({ taskforceId, commodoreIds }) => {
      read(taskforceId);
      for (const member of commodoreIds) known(member);
      return { taskforce: store.addMembers(taskforceId, commodoreIds) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.removeMembers, method: "POST", summary: "Remove a Commodore from a TaskForce; a member-removed system entry is appended.", handler: json(taskforceMembersRemoveSchema, ({ taskforceId, commodoreId }) => {
      read(taskforceId);
      return { taskforce: store.removeMember(taskforceId, commodoreId) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.continue, method: "POST", summary: "Reset the commodore chain and unpause the TaskForce.", handler: json(taskforceIdOnlySchema, ({ taskforceId }) => {
      read(taskforceId);
      return { taskforce: store.continue(taskforceId) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.close, method: "POST", summary: "Close a TaskForce; closed TaskForces reject new utterances until reopened.", handler: json(taskforceIdOnlySchema, ({ taskforceId }) => {
      read(taskforceId);
      return { taskforce: store.close(taskforceId) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.reopen, method: "POST", summary: "Reopen a closed TaskForce.", handler: json(taskforceIdOnlySchema, ({ taskforceId }) => {
      read(taskforceId);
      return { taskforce: store.reopen(taskforceId) };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.delete, method: "POST", summary: "Permanently delete a TaskForce and its ledger.", handler: json(taskforceIdOnlySchema, ({ taskforceId }) => {
      read(taskforceId);
      store.delete(taskforceId);
      return { deleted: taskforceId };
    }) },
    { name: TASKFORCE_ROUTE_NAMES.image, method: "GET", summary: "Read a preserved TaskForce ledger image by TaskForce, entry seq and image id.", handler: image },
  ];
}

/** 다음 seq를 미리 읽는다 — 이미지 사본을 원장 append 전에 땅에 두기 위해서다. */
function seqOf(store: TaskforceStore, taskforceId: string): number {
  return store.read(taskforceId)?.lastSeq ?? 0;
}
