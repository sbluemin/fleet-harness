import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, isExperimentModelId, type ExperimentAideSelection } from "@fleet-console/sdk/settings";
import { z } from "zod";

import { ObjectiveStoreError } from "../store.js";
import type { CommodoreStore } from "./store.js";
import { COMMODORE_EFFORTS, commodoreSourceSchema, EMPTY_RUN_TOTALS, MAX_DIRECTIVE, MAX_INTEL_TEXT, MAX_SOURCES, MAX_TRANSCRIPT_PAGE, MAX_TRANSCRIPT_TEXT, type CommodoreRunStatus, type CommodoreState } from "./types.js";

/**
 * 「사령관 기록」 서랍이 부르는 라우트 — 전부 POST + JSON, 같은 origin 의 Console 만 지난다. 화면은 응답이 아니라
 * `objectives:commodore` 사건으로 갱신되므로 응답은 확인용이다.
 *
 * 실험 기능 「자율 운영」이 꺼져 있어도 지시·정보는 읽고 쓸 수 있다(데이터는 사람의 것이다). 꺼진 채로 자율 운영을 켜는
 * 것만 거절한다 — 켜져 보이는데 돌지 않는 상태를 만들지 않는다.
 */

export interface CommodoreRoute {
  readonly name: string;
  readonly method: "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

export interface CommodoreStateView {
  readonly theaterId: string;
  readonly state: CommodoreState;
  /** 실험 기능 「자율 운영」. 꺼져 있으면 사령관 줄·서랍이 서지 않는다. */
  readonly enabled: boolean;
  /** 실험 기능 행의 모델·강도 — Theater 별 값이 없을 때의 좌표. */
  readonly defaults: ExperimentAideSelection;
  /** 실험 기능과 자율 운영이 모두 켜져 있다 — 사이드바 Theater 플래그와 같은 값. */
  readonly active: boolean;
  /** 감독자가 말하는 지금 — 감독자가 없는 호스트에서는 `off`/`idle` 과 저장된 누적 셈뿐이다. */
  readonly run: CommodoreRunStatus;
}

/** 감독자가 라우트에 꽂는 손 — 없으면 상태 읽기만 가능하고 메시지는 기록에만 남는다. */
export interface CommodoreRouteHooks {
  readonly run?: (theaterId: string) => Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기(`retrying`·`error`)를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying` 을 던진다. */
  readonly retry?: (theaterId: string) => Promise<void> | void;
}

const ids = z.string().min(1).max(128);
const theaterRef = z.object({ theaterId: ids });

export function createCommodoreRoutes(ctx: FleetPluginServerContext, store: CommodoreStore, hooks: CommodoreRouteHooks = {}): readonly CommodoreRoute[] {
  const experiments = () => ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
  const view = (theaterId: string, state: CommodoreState): CommodoreStateView => {
    const settings = experiments();
    const active = settings.commodore && state.autonomy;
    const run = hooks.run?.(theaterId) ?? { phase: active ? "idle" : "off" };
    return { theaterId, state, enabled: settings.commodore, defaults: experimentAideSelection(settings, "commodore"), active, run: { ...run, totals: state.run ?? EMPTY_RUN_TOTALS } };
  };
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
    if (error instanceof ObjectiveStoreError) {
      const status = error.code === "theater_unavailable" || error.code === "unknown_intel" ? 404 : error.code === "invalid_request" ? 400 : 409;
      ctx.host.http.writeJson(res, status, { error: error.code });
      return;
    }
    const code = error instanceof Error ? error.message : "commodore_failed";
    ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "commodore_failed" });
  };
  const read = (theaterId: string): CommodoreState => {
    const state = store.read(theaterId);
    if (!state) throw new ObjectiveStoreError("theater_unavailable");
    return state;
  };

  return [
    { name: "commodore/state", method: "POST", summary: "Read a Theater's Commodore state: autonomy, directive, intel, sources and model coordinates.", handler: json(theaterRef, ({ theaterId }) => view(theaterId, read(theaterId))) },
    { name: "commodore/autonomy", method: "POST", summary: "Turn a Theater's autonomous operation on or off (the Commodore row glyph).", handler: json(theaterRef.extend({ autonomy: z.boolean() }).strict(), ({ theaterId, autonomy }) => {
      read(theaterId);
      if (autonomy && !experiments().commodore) throw new ObjectiveStoreError("commodore_disabled");
      return view(theaterId, store.setAutonomy(theaterId, autonomy));
    }) },
    { name: "commodore/directive", method: "POST", summary: "Set the person's standing directive for a Theater's Commodore; a changed text raises its revision.", handler: json(theaterRef.extend({ text: z.string().max(MAX_DIRECTIVE) }).strict(), ({ theaterId, text }) => { read(theaterId); return view(theaterId, store.setDirective(theaterId, text)); }) },
    { name: "commodore/intel/add", method: "POST", summary: "Add an intel item from the person to a Theater's Commodore.", handler: json(theaterRef.extend({ text: z.string().trim().min(1).max(MAX_INTEL_TEXT) }).strict(), ({ theaterId, text }) => { read(theaterId); const { state, item } = store.addIntel(theaterId, { text, source: "person" }); return { ...view(theaterId, state), item }; }) },
    { name: "commodore/intel/remove", method: "POST", summary: "Remove an intel item from a Theater's Commodore.", handler: json(theaterRef.extend({ intelId: ids }).strict(), ({ theaterId, intelId }) => { read(theaterId); return view(theaterId, store.removeIntel(theaterId, intelId)); }) },
    { name: "commodore/sources", method: "POST", summary: "Replace the list of intel sources the Commodore reads on patrol.", handler: json(theaterRef.extend({ sources: z.array(commodoreSourceSchema.omit({ id: true })).max(MAX_SOURCES) }).strict(), ({ theaterId, sources }) => { read(theaterId); return view(theaterId, store.setSources(theaterId, sources)); }) },
    { name: "commodore/coordinates", method: "POST", summary: "Set or clear a Theater's Commodore model and effort; cleared falls back to the experiment defaults. Applies from the next turn.", handler: json(theaterRef.extend({ model: z.string().refine(isExperimentModelId).nullable(), effort: z.enum(COMMODORE_EFFORTS).nullable() }).strict(), ({ theaterId, model, effort }) => {
      read(theaterId);
      if ((model === null) !== (effort === null)) throw new ObjectiveStoreError("invalid_request");
      return view(theaterId, store.setCoordinates(theaterId, model !== null && effort !== null ? { model, effort } : null));
    }) },
    { name: "commodore/message", method: "POST", summary: "Send the person's message to a Theater's Commodore; it is kept in the log and wakes the next turn.", handler: json(theaterRef.extend({ text: z.string().trim().min(1).max(MAX_TRANSCRIPT_TEXT) }).strict(), ({ theaterId, text }) => { read(theaterId); return { theaterId, entry: store.transcriptAppend(theaterId, { kind: "message", text }) }; }) },
    { name: "commodore/retry", method: "POST", summary: "Retry now instead of waiting for the next scheduled retry after a failed Commodore turn.", handler: json(theaterRef, async ({ theaterId }) => {
      read(theaterId);
      if (!hooks.retry) throw new ObjectiveStoreError("commodore_not_retrying");
      await hooks.retry(theaterId);
      return view(theaterId, read(theaterId));
    }) },
    { name: "commodore/transcript", method: "POST", summary: "Read a page of the Commodore log, newest last; pass the first entry's seq as before to read older entries.", handler: json(theaterRef.extend({ limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE).optional(), before: z.number().int().nonnegative().optional() }).strict(), ({ theaterId, limit, before }) => { read(theaterId); return { theaterId, ...store.transcriptRead(theaterId, { limit, before }) }; }) },
  ];
}

/** 사이드바 Theater DTO 에 싣는 플래그 — 실험 기능과 자율 운영이 모두 켜진 Theater. */
export const COMMODORE_ACTIVE_FLAG = "commodoreActive";

export function commodoreActive(ctx: FleetPluginServerContext, store: CommodoreStore, theaterId: string): boolean {
  if (!(ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS).commodore) return false;
  return store.read(theaterId)?.autonomy === true;
}
