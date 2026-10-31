import type { ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import { commodoreSidebarCommandSchema } from "../shared/contracts/sidebar-layout.js";
import type { createCommodoreSidebar } from "./sidebar-layout.js";
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
import { normalizeCommodoreAlias } from "../shared/alias.js";

import { CommodoreStoreError } from "./errors.js";
import { commodorePluginSetSchema, effectiveCommodorePlugins, effectivePluginsQuerySchema, globalPluginSetSchema, pluginAuthActionSchema, pluginAuthCallbackSchema, pluginAuthStatusSchema, pluginKeySetSchema, marketplaceAddSchema, marketplaceEnableSchema, marketplaceNameRefSchema, marketplaceUpdateSchema, MAX_COMMODORE_PLUGINS, pluginIconQuerySchema, pluginInspectSchema, pluginUpdateSchema } from "../shared/contracts/plugins.js";
import type { EffectiveCommodorePluginsView, GlobalPluginsView } from "../shared/contracts/plugins.js";
import { decisionAnswersSchema } from "../shared/contracts/questions.js";
import type { CommodoreStore } from "./store.js";
import { COMMODORE_EFFORTS, EMPTY_RUN_TOTALS, MAX_COMMODORE_REFERENCES, MAX_DESCRIPTION, MAX_INTEL_TEXT, MAX_TRANSCRIPT_PAGE, MAX_TRANSCRIPT_TEXT, type CommodoreRunStatus, type CommodoreState } from "../shared/contracts/types.js";

/**
 * 「사령관 기록」 서랍이 부르는 라우트 — 이미지 사본 읽기만 GET이고 나머지는 POST + JSON, 같은 origin 의 Console 만 지난다. 화면은 응답이 아니라
 * `commodore` 사건으로 갱신되므로 응답은 확인용이다.
 *
 * 설명·정보는 실행 여부와 무관하게 읽고 쓸 수 있다. 사람 메시지는
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
  /** 마켓플레이스 등록부와 카탈로그. 없으면 플러그인 라우트는 commodore_unavailable 로 거절한다. */
  readonly plugins?: import("./plugins.js").CommodorePlugins;
  /** 플러그인 MCP 인증. 없으면 인증 라우트는 commodore_unavailable 로 거절한다. */
  readonly pluginAuth?: import("./plugin-auth.js").CommodorePluginAuth;
  /** 키·토큰이 바뀐 플러그인 — 그 플러그인을 고른 사령관의 다음 턴이 새 세션으로 이어진다. */
  readonly pluginsChanged?: (pluginIds: readonly string[]) => void;
  /** 전역 설치 목록이 바뀌었다 — 모든 사령관의 다음 턴이 새 세션으로 이어지고 `global-plugins` 사건이 난다. */
  readonly globalPluginsChanged?: (plugins: readonly string[]) => void;
  readonly deletion?: ReturnType<typeof import("./deletion.js").createCommodoreDeletion>;
  readonly knowledgeFolder?: ReturnType<typeof import("./knowledge-folder.js").createKnowledgeFolderAction>;
  readonly assertWritable?: (commodoreId: string) => void;
  readonly create?: (alias: string) => string;
  readonly list?: () => readonly ConsoleCommodoreSummary[];
  readonly sidebar?: ReturnType<typeof createCommodoreSidebar>;
  readonly setOrder?: (commodoreIds: readonly string[]) => void;
  readonly summary?: (id: string) => ConsoleCommodoreSummary;
  readonly addTheater?: (id: string, folderGrantId: string, claudeTrustConsent: boolean) => Promise<string>;
  readonly removeTheater?: (id: string, theaterId: string) => void;
  readonly createForAlias?: (theaterId: string) => string;
  readonly theaterIds?: (commodoreId: string) => readonly string[];
  /** 사람 메시지 한 턴을 받을 수 있는가. */
  readonly acceptsMessage?: (commodoreId: string) => boolean;
  readonly run?: (commodoreId: string) => Omit<CommodoreRunStatus, "totals"> | null;
  /** 재시도 대기(`retrying`·`error`)를 지금 깨운다. 그 상태가 아니면 `commodore_not_retrying` 을 던진다. */
  readonly retry?: (commodoreId: string) => Promise<void> | void;
  readonly clear?: (commodoreId: string) => Promise<void>;
  readonly objective?: (objectiveId: string) => { readonly id: string; readonly commodoreId: string; readonly title: string; readonly removed?: unknown } | null;
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
    const active = settings.commodore && boardReady;
    const run = hooks.run?.(commodoreId) ?? { phase: active ? "idle" : "off" };
    const asks = state.asks ?? [];
    const objectives = Object.fromEntries([...new Set(asks.flatMap((ask) => (ask.objectiveId ? [ask.objectiveId] : [])))].map((id) => {
      const found = hooks.objective?.(id);
      return [id, found && found.commodoreId === commodoreId ? { title: found.title } : null];
    }));
    return { commodoreId, theaterIds: hooks.theaterIds?.(commodoreId) ?? [], state, boardReady, enabled: settings.commodore, defaults: experimentAideSelection(settings, "commodore"), active, run: { ...run, totals: state.run ?? EMPTY_RUN_TOTALS }, asks: { open: asks.filter((ask) => !ask.settled).length, objectives } };
  };
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>) => Promise<unknown> | unknown, persistLanguage = true): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const { commodoreId, language } = parsed.data as { readonly commodoreId?: string; readonly language?: "en" | "ko" };
      if (commodoreId) hooks.assertWritable?.(commodoreId);
      if (persistLanguage && commodoreId && language && store.read(commodoreId)) store.setLanguage(commodoreId, language);
      const value = await run(parsed.data);
      ctx.host.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) { fail(res, error); }
    return true;
  };
  const fail = (res: http.ServerResponse, error: unknown) => {
    if (error instanceof CommodoreStoreError) {
      const status = error.code === "unknown_commodore" || error.code === "theater_unavailable" || error.code === "unknown_intel" || error.code === "unknown_routine" || error.code === "unknown_ask" || error.code === "unknown_memory" ? 404 : error.code === "invalid_request" || error.code === "invalid_folder_grant" || error.code === "invalid_ref" || error.code.startsWith("attachment_") ? 400 : 409;
      ctx.host.http.writeJson(res, status, error.details ? { error: error.code, details: error.details } : { error: error.code });
      return;
    }
    const code = error instanceof Error ? error.message : "commodore_failed";
    ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "commodore_failed" });
  };
  const plugins = () => { if (!hooks.plugins) throw new CommodoreStoreError("commodore_unavailable"); return hooks.plugins; };
  const pluginAuth = () => { if (!hooks.pluginAuth) throw new CommodoreStoreError("commodore_unavailable"); return hooks.pluginAuth; };
  const read = (commodoreId: string): CommodoreState => {
    const state = store.read(commodoreId);
    if (!state) throw new CommodoreStoreError("theater_unavailable");
    return state;
  };
  /**
   * 전역 목록 읽기 — 그 id를 직접 설치한 사령관과 함께. 파일 경로는 싣지 않는다. `installedBy`는 사령관이 직접
   * 설치한 모든 플러그인 id를 가리킨다(전역 팔레트의 카탈로그 힌트가 읽는다). `state`(change `plugins`)와
   * `global-plugins` 사건이 오면 다시 읽는다.
   */
  const globalView = (): GlobalPluginsView => {
    const list = plugins().listGlobal();
    const installedBy: Record<string, { readonly commodoreId: string; readonly alias?: string }[]> = {};
    for (const commodoreId of store.availableCommodores()) {
      const state = store.read(commodoreId);
      if (!state?.plugins?.length) continue;
      for (const pluginId of state.plugins) {
        const rows = installedBy[pluginId] ??= [];
        rows.push(state.alias ? { commodoreId, alias: state.alias } : { commodoreId });
      }
    }
    return { plugins: list, installedBy };
  };
  /** 그 사령관의 실제 로드 id — 전역 먼저, 대체된 사령관 항목은 뺀다. 모든 적재 지점이 같은 계산을 쓴다. */
  const effectiveIds = (commodoreId: string): readonly string[] =>
    effectiveCommodorePlugins(plugins().listGlobal(), read(commodoreId).plugins ?? []).effective;

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
  /**
   * 플러그인 아이콘 — 제3자 저장소의 파일이다. 화면은 `<img>` 로만 읽고, 주소를 문서로 직접 열어도 svg 안의 스크립트·외부 읽기가
   * 돌지 않게 CSP sandbox 를 함께 보낸다.
   */
  const pluginIcon: RouteHandler = ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const parsed = pluginIconQuerySchema.safeParse(Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams));
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    const found = hooks.plugins?.icon(parsed.data.pluginId) ?? null;
    if (!found) { ctx.host.http.writeJson(res, 404, { error: "icon_not_found" }); return true; }
    res.writeHead(200, {
      "Content-Type": found.mime,
      "Content-Length": found.bytes.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(found.bytes);
    return true;
  };

  return [
    { name: "commodore/knowledge-folder", method: "POST", summary: "Open existing Commodore documents on the host, or show their location in the mobile layout.", handler: json(commodoreRef.extend({ action: z.enum(["display", "open"]) }).strict(), ({ commodoreId, action }) => {
      if (!hooks.knowledgeFolder) throw new CommodoreStoreError("commodore_unavailable");
      return hooks.knowledgeFolder(commodoreId, action);
    }, false) },
    { name: "commodore/delete-preview", method: "POST", summary: "Preview the impact of permanently deleting a Commodore; Theaters are preserved.", handler: json(commodoreRef.strict(), ({ commodoreId, language }) => {
      if (!hooks.deletion) throw new CommodoreStoreError("commodore_unavailable");
      return hooks.deletion.preview(commodoreId, language);
    }, false) },
    { name: "commodore/delete", method: "POST", summary: "Permanently delete a Commodore after explicit confirmation and an exact alias match.", handler: json(commodoreRef.extend({ confirm: z.literal(true), alias: z.string() }).strict(), ({ commodoreId, alias, language }) => {
      if (!hooks.deletion) throw new CommodoreStoreError("commodore_unavailable");
      return hooks.deletion.remove(commodoreId, alias, language);
    }, false) },
    { name: "commodore/alias", method: "POST", summary: "Set or clear a Commodore alias by UUID, independently of autonomous work.", handler: json(commodoreRef.extend({ alias: z.union([z.string(), z.null()]).transform(normalizeCommodoreAlias).pipe(z.string().nullable()) }).strict(), ({ commodoreId, alias }) => { read(commodoreId); return view(commodoreId, store.setAlias(commodoreId, alias)); }) },
    { name: "commodore/list", method: "POST", summary: "List Commodores independently of registered Theaters.", handler: json(z.object({}).strict(), () => ({ commodores: hooks.list?.() ?? [], sidebarLayout: hooks.sidebar?.read() })) },
    { name: "commodore/sidebar", method: "POST", summary: "Manage shared sidebar sections without changing Commodore ownership.", handler: json(commodoreSidebarCommandSchema, (command) => {
      if (!hooks.sidebar) throw new CommodoreStoreError("commodore_unavailable");
      const result = hooks.sidebar.update(command);
      return { ...result, commodores: hooks.list?.() ?? [], sidebarLayout: hooks.sidebar.read() };
    }, false) },
    { name: "commodore/order", method: "POST", summary: "Save the display order of Commodore sections.", handler: json(z.object({ commodoreIds: z.array(ids) }).strict(), ({ commodoreIds }) => {
      if (!hooks.setOrder || !hooks.list) throw new CommodoreStoreError("commodore_unavailable");
      hooks.setOrder(commodoreIds);
      return { commodores: hooks.list() };
    }) },
    { name: "commodore/create", method: "POST", summary: "Create a Commodore with no Theaters.", handler: json(z.object({ alias: z.string().transform(normalizeCommodoreAlias).pipe(z.string().min(1)) }).strict(), ({ alias }) => {
      if (!hooks.create || !hooks.summary) throw new CommodoreStoreError("commodore_unavailable");
      const commodoreId = hooks.create(alias);
      return { commodoreId, commodore: hooks.summary(commodoreId) };
    }) },
    { name: "commodore/theaters/add", method: "POST", summary: "Add a granted folder to this Commodore's Theater list.", handler: json(commodoreRef.extend({ folderGrantId: ids, claudeTrustConsent: z.boolean().optional() }).strict(), async ({ commodoreId, folderGrantId, claudeTrustConsent }) => {
      read(commodoreId);
      if (!hooks.addTheater || !hooks.summary) throw new CommodoreStoreError("commodore_unavailable");
      const theaterId = await hooks.addTheater(commodoreId, folderGrantId, claudeTrustConsent === true);
      return { commodore: hooks.summary(commodoreId), theaterId };
    }, false) },
    { name: "commodore/theaters/remove", method: "POST", summary: "Remove a folder only from this Commodore's Theater list.", handler: json(commodoreRef.extend({ theaterId: ids }).strict(), ({ commodoreId, theaterId }) => {
      read(commodoreId);
      if (!hooks.removeTheater || !hooks.summary) throw new CommodoreStoreError("commodore_unavailable");
      hooks.removeTheater(commodoreId, theaterId);
      return { commodore: hooks.summary(commodoreId) };
    }, false) },
    { name: "commodore/marketplaces/list", method: "POST", summary: "List marketplaces and the plugin catalog of enabled ones; registers the Anthropic presets in the background.", handler: json(z.object({}).strict(), () => plugins().catalog()) },
    { name: "commodore/marketplaces/add", method: "POST", summary: "Add a custom marketplace from a GitHub owner/repo, a git https or ssh address, or a marketplace.json URL.", handler: json(marketplaceAddSchema, async ({ source, ref }) => ({ marketplace: await plugins().add(source, ref) })) },
    { name: "commodore/marketplaces/update", method: "POST", summary: "Fetch one marketplace again, or all when no name is given.", handler: json(marketplaceUpdateSchema, ({ name }) => plugins().refresh(name)) },
    { name: "commodore/marketplaces/enable", method: "POST", summary: "Turn a marketplace on or off; off hides its plugins and blocks new installs, installed ones stay.", handler: json(marketplaceEnableSchema, ({ name, enabled }) => plugins().enable(name, enabled)) },
    { name: "commodore/marketplaces/remove", method: "POST", summary: "Remove a custom marketplace; presets can only be turned off.", handler: json(marketplaceNameRefSchema, ({ name }) => plugins().remove(name)) },
    { name: "commodore/plugins/inspect", method: "POST", summary: "Fetch a plugin into Console's plugin home and report its components and the commands it would run.", handler: json(pluginInspectSchema, async ({ pluginId }) => ({ plugin: await plugins().inspect(pluginId) })) },
    { name: "commodore/plugins/detail", method: "POST", summary: "Read a plugin's component names, run commands and README from inside its folder without executing plugin code.", handler: json(pluginInspectSchema, async ({ pluginId }) => ({ plugin: await plugins().detail(pluginId) })) },
    { name: "commodore/plugins/set", method: "POST", summary: "Install or remove a plugin for one Commodore; applies from its next turn and to its objectives' next sessions.", handler: json(commodorePluginSetSchema, async ({ commodoreId, pluginId, installed, trusted }) => {
      const selected = () => read(commodoreId).plugins ?? [];
      if (installed) {
        const before = selected();
        if (!before.includes(pluginId) && before.length >= MAX_COMMODORE_PLUGINS) throw new CommodoreStoreError("limit");
        await plugins().prepareInstall(pluginId, trusted === true);
        // 받는 동안 같은 사령관의 다른 설치·제거가 끝났을 수 있다 — 저장 직전의 목록에 더한다.
        const latest = selected();
        if (!latest.includes(pluginId) && latest.length >= MAX_COMMODORE_PLUGINS) throw new CommodoreStoreError("limit");
        return view(commodoreId, store.setPlugins(commodoreId, [...latest, pluginId]));
      }
      return view(commodoreId, store.setPlugins(commodoreId, selected().filter((id) => id !== pluginId)));
    }) },
    { name: "commodore/plugins/global/list", method: "POST", summary: "Read the global plugin installs with the Commodores that installed each id directly.", handler: json(z.object({}).strict(), () => globalView(), false) },
    { name: "commodore/plugins/global/set", method: "POST", summary: "Install (fetching like a Commodore install, then adding to the list) or remove a global plugin; applies from every Commodore's next session.", handler: json(globalPluginSetSchema, async ({ pluginId, installed, trusted }) => {
      if (installed) {
        const before = plugins().listGlobal();
        if (!before.includes(pluginId) && before.length >= MAX_COMMODORE_PLUGINS) throw new CommodoreStoreError("limit");
        await plugins().prepareInstall(pluginId, trusted === true);
        // 받는 동안 다른 전역 설치·제거가 끝났을 수 있다 — 저장 직전의 목록에 더한다.
        const latest = plugins().listGlobal();
        if (!latest.includes(pluginId) && latest.length >= MAX_COMMODORE_PLUGINS) throw new CommodoreStoreError("limit");
      }
      const next = plugins().setGlobal(pluginId, installed);
      // 목록이 그대로면 쓰지도 알리지도 않았다 — 세션을 헛되이 교체하지 않는다.
      if (next.changed) hooks.globalPluginsChanged?.(next.plugins);
      return globalView();
    }, false) },
    { name: "commodore/plugins/effective", method: "POST", summary: "Read one Commodore's actual plugin load: the global list, the effective ids, and the replaced entries.", handler: json(effectivePluginsQuerySchema, ({ commodoreId }): EffectiveCommodorePluginsView => {
      const state = read(commodoreId);
      const global = plugins().listGlobal();
      const { effective, replaced } = effectiveCommodorePlugins(global, state.plugins ?? []);
      return { global, effective, replaced };
    }, false) },
    { name: "commodore/plugins/update", method: "POST", summary: "Update one plugin with the Claude Code CLI; applies from its next session and reports the old and new versions with the refreshed catalog.", handler: json(pluginUpdateSchema, async ({ pluginId, trusted, version, runs }) => {
      const result = await plugins().updatePlugin(pluginId, trusted === true, version, runs);
      // 인증 캐시를 버리고, 그 플러그인을 고른 모든 사령관에 알린다. 적용은 다음 세션부터다.
      hooks.pluginAuth?.invalidate();
      hooks.pluginsChanged?.([pluginId]);
      return result;
    }, false) },
    { name: "commodore/plugins/auth/status", method: "POST", summary: "Read whether this Commodore's plugin MCP servers need a sign-in or a key; checks through a Claude Code child that sends no model turn.", handler: json(pluginAuthStatusSchema, ({ commodoreId, refresh }) => pluginAuth().status(commodoreId, effectiveIds(commodoreId), refresh === true), false) },
    { name: "commodore/plugins/auth/action", method: "POST", summary: "Start, cancel or clear Claude Code's MCP OAuth sign-in for one plugin server; start returns the address to open in a browser.", handler: json(pluginAuthActionSchema, async ({ commodoreId, pluginId, server, action }) => {
      const selected = effectiveIds(commodoreId);
      if (action === "start") return await pluginAuth().start(commodoreId, selected, pluginId, server);
      return { view: action === "cancel" ? await pluginAuth().cancel(commodoreId, selected, pluginId, server) : await pluginAuth().clear(commodoreId, selected, pluginId, server) };
    }, false) },
    { name: "commodore/plugins/auth/callback", method: "POST", summary: "Hand an OAuth callback address copied from another device's browser to the sign-in waiting on this computer.", handler: json(pluginAuthCallbackSchema, async ({ commodoreId, pluginId, server, callbackUrl }) => ({ view: await pluginAuth().callback(commodoreId, effectiveIds(commodoreId), pluginId, server, callbackUrl) }), false) },
    { name: "commodore/plugins/key", method: "POST", summary: "Store or clear a key a plugin's MCP declaration asks for with ${VAR}; the value is never returned.", handler: json(pluginKeySetSchema, async ({ commodoreId, pluginId, name, value }) => {
      if (!effectiveIds(commodoreId).includes(pluginId)) throw new CommodoreStoreError("plugin_not_found");
      plugins().setKey(pluginId, name, value);
      pluginAuth().invalidate();
      hooks.pluginsChanged?.([pluginId]);
      return { view: await pluginAuth().status(commodoreId, effectiveIds(commodoreId), true) };
    }, false) },
    { name: "commodore/attachment", method: "GET", summary: "Read a preserved Commodore message image by Theater, message and attachment id.", handler: image },
    { name: "commodore/plugins/icon", method: "GET", summary: "Read a plugin's icon image declared in its plugin.json; only image files inside the plugin folder are served.", handler: pluginIcon },
    { name: "commodore/state", method: "POST", summary: "Read a Commodore's state: routines, description, intel, sources and model coordinates.", handler: json(commodoreRef, ({ commodoreId }) => view(commodoreId, read(commodoreId))) },
    { name: "commodore/description", method: "POST", summary: "Set the person's standing description of a Commodore; a changed text raises its revision.", handler: json(commodoreRef.extend({ text: z.string().max(MAX_DESCRIPTION) }).strict(), ({ commodoreId, text }) => { read(commodoreId); return view(commodoreId, store.setDescription(commodoreId, text)); }) },
    { name: "commodore/intel/add", method: "POST", summary: "Add an intel item from the person to a Commodore.", handler: json(commodoreRef.extend({ text: z.string().trim().min(1).max(MAX_INTEL_TEXT) }).strict(), ({ commodoreId, text }) => { read(commodoreId); const { state, item } = store.addIntel(commodoreId, { text, source: "person" }); return { ...view(commodoreId, state), item }; }) },
    { name: "commodore/intel/edit", method: "POST", summary: "Edit the text of an intel item in place; its id, source and position stay. Unchanged text is a no-op.", handler: json(commodoreRef.extend({ intelId: ids, text: z.string().trim().min(1).max(MAX_INTEL_TEXT) }).strict(), ({ commodoreId, intelId, text }) => { read(commodoreId); const { state, item } = store.editIntel(commodoreId, intelId, text); return { ...view(commodoreId, state), item }; }) },
    { name: "commodore/intel/remove", method: "POST", summary: "Remove an intel item from a Commodore.", handler: json(commodoreRef.extend({ intelId: ids }).strict(), ({ commodoreId, intelId }) => { read(commodoreId); return view(commodoreId, store.removeIntel(commodoreId, intelId)); }) },
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
    { name: "commodore/routine-toggle", method: "POST", summary: "Enable or pause a routine as the person.", handler: json(commodoreRef.extend({ routineId: ids, enabled: z.boolean() }).strict(), ({ commodoreId, routineId, enabled }) => {
      read(commodoreId);
      return view(commodoreId, store.routineUpdate(commodoreId, routineId, { enabled }, "person"));
    }) },
    { name: "commodore/routine-remove", method: "POST", summary: "Remove a routine as the person without waking the Commodore; notify its next turn.", handler: json(commodoreRef.extend({ routineId: ids }).strict(), ({ commodoreId, routineId }) => {
      read(commodoreId);
      return view(commodoreId, store.routineRemove(commodoreId, routineId, "person"));
    }) },
    { name: "commodore/message", method: "POST", summary: "Send the person's message to this Commodore. Inline U+FFFC references name owned objectives (id strings) or ready peer Commodores ({kind: commodore, id}); the current Commodore decides what to relay. Refused while the experiment or board is unavailable.", handler: json(commodoreRef.extend({ text: z.string().trim().min(1).max(MAX_TRANSCRIPT_TEXT), objectiveId: ids.optional(), references: z.array(z.union([ids, z.object({ kind: z.literal("commodore"), id: ids }).strict()])).min(1).max(MAX_COMMODORE_REFERENCES).optional(), attachmentIds: z.array(ids).max(4).optional() }).strict(), ({ commodoreId, text: raw, objectiveId, references: referenceIds = [], attachmentIds = [] }) => {
      read(commodoreId);
      // 서버가 권위다 — 종료·Clear 중이거나 보드가 없으면 기록에 남기기 전에 거절한다.
      if (!experiments().commodore) throw new CommodoreStoreError("commodore_disabled");
      if (!(hooks.acceptsMessage?.(commodoreId) ?? !!hooks.run?.(commodoreId))) throw new CommodoreStoreError("commodore_inactive");
      const objective = objectiveId ? hooks.objective?.(objectiveId) : null;
      if (objectiveId && !objective) throw new CommodoreStoreError("unknown_objective");
      if (objective && objective.commodoreId !== commodoreId) throw new CommodoreStoreError("objective_owner_mismatch");
      // 본문 속 참조 — 참조가 있으면 표식 글자 수와 참조 수가 같아야 하고, 한 목표는 한 번만, 그리고 같은 Theater 의 지운 적 없는 목표만이다.
      // 하나라도 어긋나면 기록에 남기지 않는다. 참조가 없으면 본문의 표식 글자는 지운다 — 브라우저가 이미지 섞인 서식 글을 복사할 때 만들어
      // 내는 글자라(새 세션·그룹 대화에서 붙여 보낸 말) 거절하지 않고, 지운 뒤 비면 빈 메시지와 같이 거절한다. 어느 쪽이든 검증하지
      // 않은 참조는 서지 않는다.
      const text = referenceIds.length ? raw : raw.split(CONVERSATION_REFERENCE_MARK).join("").trim();
      if (!text) throw new CommodoreStoreError("invalid_request");
      if (text.split(CONVERSATION_REFERENCE_MARK).length - 1 !== referenceIds.length || new Set(referenceIds.map((ref) => typeof ref === "string" ? `objective:${ref}` : `commodore:${ref.id}`)).size !== referenceIds.length) throw new CommodoreStoreError("invalid_request");
      const references = referenceIds.map((id) => {
        if (typeof id !== "string") {
          if (id.id === commodoreId) throw new CommodoreStoreError("self_target");
          const peer = store.read(id.id);
          if (!peer) throw new CommodoreStoreError("unknown_commodore");
          if (!hooks.acceptsMessage?.(id.id)) throw new CommodoreStoreError("commodore_unavailable");
          return { kind: "commodore" as const, id: id.id, title: peer.alias ?? "Commodore" };
        }
        const found = hooks.objective?.(id);
        if (!found || found.removed) throw new CommodoreStoreError("unknown_objective");
        if (found.commodoreId !== commodoreId) throw new CommodoreStoreError("objective_owner_mismatch");
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
    { name: "commodore/clear", method: "POST", summary: "Cancel the current turn, discard the session context and delete the transcript. Keep the description, intel, settings, the board and routines.", handler: json(commodoreRef.extend({ confirm: z.literal(true) }).strict(), async ({ commodoreId }) => {
      read(commodoreId);
      if (!hooks.clear) throw new CommodoreStoreError("commodore_inactive");
      await hooks.clear(commodoreId);
      return view(commodoreId, read(commodoreId));
    }) },
    // fleet-memory 는 사령관만 쓴다 — 사람 화면은 이 읽기 하나로 목록 전체를 받는다(항목 상한이 작아 쪽 나눔이 없다).
    { name: "commodore/memory", method: "POST", summary: "Read a Commodore's fleet-memory: every entry with its branch, topic, text, sources, links and timestamps. Read-only; only the Commodore writes it.", handler: json(commodoreRef, ({ commodoreId }) => {
      read(commodoreId);
      return { commodoreId, entries: store.memory.list(commodoreId) };
    }) },
    { name: "commodore/transcript", method: "POST", summary: "Read a page of the Commodore log, newest last; pass the first entry's seq as before to read older entries.", handler: json(commodoreRef.extend({ limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE).optional(), before: z.number().int().nonnegative().optional() }).strict(), ({ commodoreId, limit, before }) => { read(commodoreId); return { commodoreId, ...store.transcriptRead(commodoreId, { limit, before }) }; }) },
  ];
}

export function commodoreActive(ctx: CommodoreRouteContext, store: CommodoreStore, commodoreId: string): boolean {
  if (!(ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS).commodore) return false;
  return store.read(commodoreId) !== null;
}
