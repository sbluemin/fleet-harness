import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { AttachmentHost } from "../../execution/shared/agent.js";
import type { ExperimentsHost } from "../../settings/shared/experiment-ports.js";
import type http from "node:http";
import { randomUUID } from "node:crypto";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "../shared/contracts/attachment-budget.js";
import { validCommodoreImageId } from "./images.js";

import { CONVERSATION_REFERENCE_MARK } from "../../execution/shared/conversation/references.js";
import { canonicalModelId } from "../../ai-gateway/shared/models.js";

export interface CommodoreRouteContext {
  readonly host: { readonly experiments?: ExperimentsHost; readonly attachments?: AttachmentHost; readonly http: HttpPort; readonly security: HttpSecurityPort; };
}
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, isExperimentModelId, type ExperimentAideSelection } from "../../settings/shared/experiments.js";
import { z } from "zod";

import { CommodoreStoreError } from "./errors.js";
import { decisionAnswersSchema } from "../shared/contracts/questions.js";
import type { CommodoreStore } from "./store.js";
import { COMMODORE_EFFORTS, patrolIntervalMs, commodorePatrolSchema, commodoreSourceSchema, EMPTY_RUN_TOTALS, MAX_COMMODORE_REFERENCES, MAX_DIRECTIVE, MAX_INTEL_TEXT, MAX_SOURCES, MAX_TRANSCRIPT_PAGE, MAX_TRANSCRIPT_TEXT, type CommodoreRunStatus, type CommodoreState } from "../shared/contracts/types.js";

/**
 * 「사령관 기록」 서랍이 부르는 라우트 — 이미지 사본 읽기만 GET이고 나머지는 POST + JSON, 같은 origin 의 Console 만 지난다. 화면은 응답이 아니라
 * `commodore` 사건으로 갱신되므로 응답은 확인용이다.
 *
 * 지시·정보는 실행 여부와 무관하게 읽고 쓸 수 있다. 순찰 안 함은 자동 깨움만 막는다. 사람 메시지는
 * 감독자가 한 턴을 받을 수 있을 때만 기록한다 — 받을 실행기가 없는데 문장만 남겨 조용히 잃지 않는다.
 */

export interface CommodoreRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

export type { CommodoreStateView } from "../shared/contracts/types.js";
import type { CommodoreStateView } from "../shared/contracts/types.js";

/** 감독자가 라우트에 꽂는 손 — 메시지는 실제 runner가 있을 때만 받는다. */
export interface CommodoreRouteHooks {
  readonly resolve?: (theaterId: string) => string | null;
  readonly create?: (theaterId: string) => string;
  readonly theaterIds?: (commodoreId: string) => readonly string[];
  /** 순찰이 안 함이어도 사람 메시지 한 턴을 받을 수 있는가. */
  readonly acceptsMessage?: (commodoreId: string) => boolean;
  readonly run?: (commodoreId: string) => Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기(`retrying`·`error`)를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying` 을 던진다. */
  readonly retry?: (commodoreId: string) => Promise<void> | void;
  readonly clear?: (commodoreId: string) => Promise<void>;
  readonly objective?: (objectiveId: string) => { readonly id: string; readonly theaterId: string; readonly title: string; readonly removed?: unknown } | null;
  /** 보드 어댑터가 등록돼 있는가 — 없으면 감독자가 runner를 세우지 않으므로 사령관은 꺼진 것으로 보이고 켜지지 않는다. */
  readonly boardReady?: () => boolean;
}

const ids = z.string().min(1).max(128);
/** 모든 요청은 사람의 언어를 실을 수 있다 — 목표 라우트와 같은 출처(브라우저 로케일)이고, Theater 의 사령관 기록 언어가 된다. */
const commodoreRef = z.object({ commodoreId: ids, language: z.enum(["en", "ko"]).optional() });

export function createCommodoreRoutes(ctx: CommodoreRouteContext, store: CommodoreStore, hooks: CommodoreRouteHooks = {}): readonly CommodoreRoute[] {
  const experiments = () => ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
  const view = (commodoreId: string, state: CommodoreState): CommodoreStateView => {
    const settings = experiments();
    const boardReady = hooks.boardReady?.() ?? true;
    const active = settings.commodore && patrolIntervalMs(state) !== null && boardReady;
    const run = hooks.run?.(commodoreId) ?? { phase: active ? "idle" : "off" };
    const asks = state.asks ?? [];
    const objectives = Object.fromEntries([...new Set(asks.flatMap((ask) => (ask.objectiveId ? [ask.objectiveId] : [])))].map((id) => {
      const found = hooks.objective?.(id);
      return [id, found && (hooks.theaterIds?.(commodoreId) ?? []).includes(found.theaterId) ? { title: found.title } : null];
    }));
    return { commodoreId, theaterIds: hooks.theaterIds?.(commodoreId) ?? [], state, boardReady, enabled: settings.commodore, defaults: experimentAideSelection(settings, "commodore"), active, run: { ...run, totals: state.run ?? EMPTY_RUN_TOTALS }, asks: { open: asks.filter((ask) => !ask.settled).length, objectives } };
  };
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>) => Promise<unknown> | unknown): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const { commodoreId, language } = parsed.data as { readonly commodoreId?: string; readonly language?: "en" | "ko" };
      if (commodoreId && language && store.read(commodoreId)) store.setLanguage(commodoreId, language);
      const value = await run(parsed.data);
      ctx.host.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) { fail(res, error); }
    return true;
  };
  const fail = (res: http.ServerResponse, error: unknown) => {
    if (error instanceof CommodoreStoreError) {
      const status = error.code === "theater_unavailable" || error.code === "unknown_intel" || error.code === "unknown_ask" || error.code === "unknown_memory" ? 404 : error.code === "invalid_request" || error.code === "invalid_ref" || error.code.startsWith("attachment_") ? 400 : 409;
      ctx.host.http.writeJson(res, status, { error: error.code });
      return;
    }
    const code = error instanceof Error ? error.message : "commodore_failed";
    ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "commodore_failed" });
  };
  const read = (commodoreId: string): CommodoreState => {
    const state = store.read(commodoreId);
    if (!state) throw new CommodoreStoreError("theater_unavailable");
    return state;
  };

  const imageQuery = z.object({ commodoreId: ids, messageId: z.string().refine(validCommodoreImageId), attachmentId: z.string().refine(validCommodoreImageId) }).strict();
  const image: RouteHandler = ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const parsed = imageQuery.safeParse(Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams));
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const { commodoreId, messageId, attachmentId } = parsed.data;
    const found = store.images.read(commodoreId, messageId, attachmentId);
    if (!found) { ctx.host.http.writeJson(res, 404, { error: "attachment_not_found" }); return true; }
    res.writeHead(200, { "Content-Type": found.mime, "Content-Length": found.bytes.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(found.bytes);
    return true;
  };

  return [
    { name: "commodore/resolve", method: "POST", summary: "Resolve a registered Theater to its Commodore UUID.", handler: json(z.object({ theaterId: ids }).strict(), ({ theaterId }) => ({ commodoreId: hooks.resolve?.(theaterId) ?? null })) },
    { name: "commodore/create", method: "POST", summary: "Idempotently create a Commodore for a registered Theater.", handler: json(z.object({ theaterId: ids }).strict(), ({ theaterId }) => {
      if (!hooks.create) throw new CommodoreStoreError("theater_unavailable");
      return { commodoreId: hooks.create(theaterId) };
    }) },
    { name: "commodore/attachment", method: "GET", summary: "Read a preserved Commodore message image by Theater, message and attachment id.", handler: image },
    { name: "commodore/state", method: "POST", summary: "Read a Theater's Commodore state: patrol, directive, intel, sources and model coordinates.", handler: json(commodoreRef, ({ commodoreId }) => view(commodoreId, read(commodoreId))) },
    { name: "commodore/directive", method: "POST", summary: "Set the person's standing directive for a Theater's Commodore; a changed text raises its revision.", handler: json(commodoreRef.extend({ text: z.string().max(MAX_DIRECTIVE) }).strict(), ({ commodoreId, text }) => { read(commodoreId); return view(commodoreId, store.setDirective(commodoreId, text)); }) },
    { name: "commodore/intel/add", method: "POST", summary: "Add an intel item from the person to a Theater's Commodore.", handler: json(commodoreRef.extend({ text: z.string().trim().min(1).max(MAX_INTEL_TEXT) }).strict(), ({ commodoreId, text }) => { read(commodoreId); const { state, item } = store.addIntel(commodoreId, { text, source: "person" }); return { ...view(commodoreId, state), item }; }) },
    { name: "commodore/intel/edit", method: "POST", summary: "Edit the text of an intel item in place; its id, source and position stay. Unchanged text is a no-op.", handler: json(commodoreRef.extend({ intelId: ids, text: z.string().trim().min(1).max(MAX_INTEL_TEXT) }).strict(), ({ commodoreId, intelId, text }) => { read(commodoreId); const { state, item } = store.editIntel(commodoreId, intelId, text); return { ...view(commodoreId, state), item }; }) },
    { name: "commodore/intel/remove", method: "POST", summary: "Remove an intel item from a Theater's Commodore.", handler: json(commodoreRef.extend({ intelId: ids }).strict(), ({ commodoreId, intelId }) => { read(commodoreId); return view(commodoreId, store.removeIntel(commodoreId, intelId)); }) },
    { name: "commodore/sources", method: "POST", summary: "Replace the list of intel sources the Commodore reads on patrol.", handler: json(commodoreRef.extend({ sources: z.array(commodoreSourceSchema.omit({ id: true })).max(MAX_SOURCES) }).strict(), ({ commodoreId, sources }) => { read(commodoreId); return view(commodoreId, store.setSources(commodoreId, sources)); }) },
    { name: "commodore/coordinates", method: "POST", summary: "Set or clear a Theater's Commodore model and effort; cleared falls back to the experiment defaults. Applies from the next turn.", handler: json(commodoreRef.extend({ model: z.string().refine(isExperimentModelId).nullable(), effort: z.enum(COMMODORE_EFFORTS).nullable() }).strict(), ({ commodoreId, model, effort }) => {
      read(commodoreId);
      if ((model === null) !== (effort === null)) throw new CommodoreStoreError("invalid_request");
      // 정준 id(실행 id)로 접어 저장한다 — 옛 표기(`claude-gateway--…`)도 받는다. Gateway에서 꺼진 모델도 저장은 하고
      // 실행만 폴백한다(감독자가 턴마다 로스터에 대조한다).
      return view(commodoreId, store.setCoordinates(commodoreId, model !== null && effort !== null ? { model: canonicalModelId(model), effort } : null));
    }) },
    { name: "commodore/commander", method: "POST", summary: "Set or clear the Commander model and effort for objectives the Commodore creates; cleared falls back to the board's Commander default.", handler: json(commodoreRef.extend({ model: z.string().trim().min(1).max(128).nullable(), effort: z.string().trim().min(1).max(32).nullable().optional() }).strict(), ({ commodoreId, model, effort }) => {
      read(commodoreId);
      if (model === null && effort) throw new CommodoreStoreError("invalid_request");
      return view(commodoreId, store.setCommander(commodoreId, model === null ? null : { model: canonicalModelId(model), ...(effort ? { effort } : {}) }));
    }) },
    { name: "commodore/patrol", method: "POST", summary: "Set the Commodore patrol interval, or off to disable automatic wakes including Console restart. Off is the default.", handler: json(commodoreRef.extend({ minutes: commodorePatrolSchema }).strict(), ({ commodoreId, minutes }) => {
      read(commodoreId);
      if (minutes !== "off" && !experiments().commodore) throw new CommodoreStoreError("commodore_disabled");
      if (minutes !== "off" && hooks.boardReady && !hooks.boardReady()) throw new CommodoreStoreError("commodore_inactive");
      return view(commodoreId, store.setPatrol(commodoreId, minutes));
    }) },
    { name: "commodore/stop-at", method: "POST", summary: "Schedule the end of autonomous objectiveRecord at an epoch-millisecond timestamp, or pass null to cancel it. Requires automatic patrol and a future timestamp.", handler: json(commodoreRef.extend({ stopAt: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable() }).strict(), ({ commodoreId, stopAt }) => {
      read(commodoreId);
      if (!experiments().commodore) throw new CommodoreStoreError("commodore_disabled");
      if (!hooks.run?.(commodoreId)) throw new CommodoreStoreError("commodore_inactive");
      return view(commodoreId, store.setStopAt(commodoreId, stopAt));
    }) },
    { name: "commodore/message", method: "POST", summary: "Send the person's message to a running Theater Commodore; it is kept in the log and wakes the next turn. Up to three objectives of the same Theater may be referenced inline: the text carries U+FFFC once per reference id, in order. Without references, U+FFFC is dropped from the text. Refused while the experiment or the board is unavailable; patrol off still allows this message turn.", handler: json(commodoreRef.extend({ text: z.string().trim().min(1).max(MAX_TRANSCRIPT_TEXT), objectiveId: ids.optional(), references: z.array(ids).min(1).max(MAX_COMMODORE_REFERENCES).optional(), attachmentIds: z.array(ids).max(4).optional() }).strict(), ({ commodoreId, text: raw, objectiveId, references: referenceIds = [], attachmentIds = [] }) => {
      const state = read(commodoreId);
      // 서버가 권위다 — 종료·Clear 중이거나 보드가 없으면 기록에 남기기 전에 거절한다.
      if (!experiments().commodore) throw new CommodoreStoreError("commodore_disabled");
      // 결정 대기·추천안 임시: 안 함에서도 사람 메시지 한 턴은 받되 자동 깨움은 열지 않는다.
      if (!(hooks.acceptsMessage?.(commodoreId) ?? (patrolIntervalMs(state) !== null && !!hooks.run?.(commodoreId)))) throw new CommodoreStoreError("commodore_inactive");
      if (state.stopAt !== undefined && state.stopAt <= Date.now()) throw new CommodoreStoreError("commodore_stopping");
      const objective = objectiveId ? hooks.objective?.(objectiveId) : null;
      if (objectiveId && !objective) throw new CommodoreStoreError("unknown_objective");
      if (objective && !(hooks.theaterIds?.(commodoreId) ?? []).includes(objective.theaterId)) throw new CommodoreStoreError("objective_theater_mismatch");
      // 본문 속 참조 — 참조가 있으면 표식 글자 수와 참조 수가 같아야 하고, 한 목표는 한 번만, 그리고 같은 Theater 의 지운 적 없는 목표만이다.
      // 하나라도 어긋나면 기록에 남기지 않는다. 참조가 없으면 본문의 표식 글자는 지운다 — 브라우저가 이미지 섞인 서식 글을 복사할 때 만들어
      // 내는 글자라(새 세션·그룹 대화에서 붙여 보낸 말) 거절하지 않고, 지운 뒤 비면 빈 메시지와 같이 거절한다. 어느 쪽이든 검증하지
      // 않은 참조는 서지 않는다.
      const text = referenceIds.length ? raw : raw.split(CONVERSATION_REFERENCE_MARK).join("").trim();
      if (!text) throw new CommodoreStoreError("invalid_request");
      if (text.split(CONVERSATION_REFERENCE_MARK).length - 1 !== referenceIds.length || new Set(referenceIds).size !== referenceIds.length) throw new CommodoreStoreError("invalid_request");
      const references = referenceIds.map((id) => {
        const found = hooks.objective?.(id);
        if (!found || found.removed) throw new CommodoreStoreError("unknown_objective");
        if (!(hooks.theaterIds?.(commodoreId) ?? []).includes(found.theaterId)) throw new CommodoreStoreError("objective_theater_mismatch");
        return { id: found.id, title: found.title };
      });
      const messageId = randomUUID();
      if (attachmentIds.length && !ctx.host.attachments) throw new CommodoreStoreError("attachments_unavailable");
      let imageBytes = 0;
      try { imageBytes = attachmentIds.length ? ctx.host.attachments!.claim(commodoreId, messageId, attachmentIds, MAX_COMMODORE_MESSAGE_IMAGE_BYTES) : 0; }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code?.startsWith("attachment_")) throw new CommodoreStoreError(code);
        throw error;
      }
      // 기록 사본 실패는 전달을 막지 않는다 — 그 메시지는 예전처럼 참조 자리로 남는다.
      let preview = false;
      if (attachmentIds.length) {
        try {
          const images = ctx.host.attachments!.read(commodoreId, messageId);
          if (images.length === attachmentIds.length && images.every((image, index) => image.id === attachmentIds[index])) preview = store.images.save(commodoreId, messageId, images);
        } catch { /* 전달용 원본의 수명은 감독자가 그대로 소유한다. */ }
      }
      try {
        return { commodoreId, entry: store.transcriptAppend(commodoreId, { kind: "message", text, ...(attachmentIds.length ? { messageId, attachments: attachmentIds.map((id) => ({ id, ...(preview ? { preview: true as const } : {}) })), imageBytes } : {}), ...(objective ? { objective: { id: objective.id, title: objective.title } } : {}), ...(references.length ? { references } : {}) }) };
      } catch (error) {
        if (preview) { try { store.images.remove(commodoreId, messageId); } catch { /* 다음 정리 때 다시 거둔다. */ } }
        if (attachmentIds.length) ctx.host.attachments!.rollbackClaim(commodoreId, messageId);
        throw error;
      }
    }) },
    // 사령관의 질문에 대한 사람의 답 — 자율 운영이 꺼져 있어도 받는다(답은 상태에 남고, 사령관은 다음에 돌 때 읽는다). 끝난 질문은 다시 답하지 못한다.
    { name: "commodore/ask/answer", method: "POST", summary: "Answer one of the Commodore's open questions to the person: every question at once. The answer is kept with the question, logged, and wakes a running Commodore, which reads it with its asks tool. An answered or withdrawn question cannot be answered again.", handler: json(commodoreRef.extend({ askId: ids, answers: decisionAnswersSchema.shape.answers }).strict(), ({ commodoreId, askId, answers }) => {
      read(commodoreId);
      const { state, ask, repeated } = store.askAnswer(commodoreId, askId, answers);
      return { ...view(commodoreId, state), ask, ...(repeated ? { repeated: true } : {}) };
    }) },
    { name: "commodore/retry", method: "POST", summary: "Retry now instead of waiting for the next scheduled retry after a failed Commodore turn.", handler: json(commodoreRef, async ({ commodoreId }) => {
      read(commodoreId);
      if (!hooks.retry) throw new CommodoreStoreError("commodore_not_retrying");
      await hooks.retry(commodoreId);
      return view(commodoreId, read(commodoreId));
    }) },
    { name: "commodore/clear", method: "POST", summary: "Cancel the current turn, discard the session context and delete the transcript. Keep directives, intel, settings, the board and the stop schedule.", handler: json(commodoreRef.extend({ confirm: z.literal(true) }).strict(), async ({ commodoreId }) => {
      read(commodoreId);
      if (!hooks.clear) throw new CommodoreStoreError("commodore_inactive");
      await hooks.clear(commodoreId);
      return view(commodoreId, read(commodoreId));
    }) },
    // fleet-memory 는 사령관만 쓴다 — 사람 화면은 이 읽기 하나로 목록 전체를 받는다(항목 상한이 작아 쪽 나눔이 없다).
    { name: "commodore/memory", method: "POST", summary: "Read the Commodore's fleet-memory for a Theater: every entry with its branch, topic, text, sources, links and timestamps. Read-only; only the Commodore writes it.", handler: json(commodoreRef, ({ commodoreId }) => {
      read(commodoreId);
      return { commodoreId, entries: store.memory.list(commodoreId) };
    }) },
    { name: "commodore/transcript", method: "POST", summary: "Read a page of the Commodore log, newest last; pass the first entry's seq as before to read older entries.", handler: json(commodoreRef.extend({ limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE).optional(), before: z.number().int().nonnegative().optional() }).strict(), ({ commodoreId, limit, before }) => { read(commodoreId); return { commodoreId, ...store.transcriptRead(commodoreId, { limit, before }) }; }) },
  ];
}

/** 사이드바 Theater DTO 플래그 — 실험 기능이 켜지고 순찰이 안 함이 아닌 자동 운영 상태. */
export const COMMODORE_ACTIVE_FLAG = "commodoreActive";

export function commodoreActive(ctx: CommodoreRouteContext, store: CommodoreStore, commodoreId: string): boolean {
  if (!(ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS).commodore) return false;
  return patrolIntervalMs(store.read(commodoreId)) !== null;
}
