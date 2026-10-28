import { inputIssues } from "../../console-use/shared/tools.js";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

import type { ObjectivesFeatureDeps } from "./deps.js";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { z } from "zod";

import { createObjectiveActions } from "./actions.js";
import { attachmentName, imageInfo, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import type { PrStatusService } from "./pr-status.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { SHARED_FOLDER_LIMITS, type SharedFolderEntry, type SharedFolderKind, type SharedFolderList } from "../shared/shared-folder.js";
import { ObjectiveArchiveError } from "../../workspace/host/objective-archive-storage.js";
import { createObjectiveSchema, decisionAnswersSchema, followupSelectionSchema, criterionAddSchema, criterionPatchSchema, MAX_CONTEXT, memberAddSchema, memberPatchSchema, memberBatchLaunchSchema, patchObjectiveSchema, planSchema, missionAddSchema, missionPatchSchema, PERSON_HOLD_TARGETS, type Objective } from "../shared/types.js";

/**
 * 브라우저가 부르는 라우트. 전부 POST + JSON, 같은 origin 의 Console 만 지난다(`isTerminalAuthorized`).
 * 응답은 바뀐 항목 하나 — 화면은 응답이 아니라 `objectives:objective` 사건으로 갱신되므로 응답은 확인용이다.
 */

export interface ObjectiveRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

/** shared/ 바깥을 가리키는 읽기는 404 로 — 본문에 바깥 경로나 실제 경로를 넣지 않는다. */
class UnknownSharedFile extends Error {}

const insideShared = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const sameSharedFile = (a: fs.BigIntStats, b: fs.BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** shared/ 기준 상대 경로의 어휘 검사 — 비었거나 절대·역참조·역슬래시·제어 문자는 받기 전에 막는다. */
const isUnsafeSharedPath = (raw: string) => {
  if (!raw || raw.length > 1024 || raw.includes("\\")) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return true;
  if (raw.startsWith("/")) return true;
  return raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
};

/** RFC 5987 filename* 값 — 구분자·제어 문자가 없는 basename 이 들어온다. */
const encodeSharedFilename = (name: string) => encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** 엄격한 UTF-8 이고 NUL 바이트가 없으면 텍스트다. */
const isSharedText = (data: Buffer) => {
  if (data.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; }
  catch { return false; }
};

/**
 * 읽은 바이트로 다시 판정 — 목록의 kind 를 믿지 않는다. imageInfo 가 잡는 머리만 이미지이고,
 * SVG·HTML 은 텍스트(또는 file)로만 나가 image/svg+xml·text/html 을 절대 내보내지 않는다.
 */
const kindOfSharedData = (data: Buffer, size: number): SharedFolderKind => {
  if (imageInfo(data)) return "image";
  if (size <= SHARED_FOLDER_LIMITS.textBytes && isSharedText(data)) return "text";
  return "file";
};

/** 목록용 겉핥기 판정 — 1 MiB 이하는 전부, 그 위는 머리(64 KiB)만 읽는다. 실패하면 내려받기 전용으로 둔다. */
const classifySharedEntry = async (file: string, stat: fs.Stats): Promise<SharedFolderKind> => {
  try {
    const stop = stat.size <= SHARED_FOLDER_LIMITS.textBytes ? stat.size : 65536;
    const head = Math.min(stat.size, stop);
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return "file";
      const data = Buffer.alloc(head);
      let offset = 0;
      while (offset < head) {
        const { bytesRead } = await handle.read(data, offset, head - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return kindOfSharedData(data.subarray(0, offset), stat.size);
    } finally { await handle.close(); }
  } catch { return "file"; }
};

/** shared/ 재귀 목록 — lstat 기준이라 링크를 따라가지 않고, 링크·특수 파일은 빼고 일반 파일만 담는다. */
const listSharedFolder = async (root: string): Promise<SharedFolderList> => {
  const entries: SharedFolderEntry[] = [];
  let truncated = false;
  let stopped = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (stopped) return;
    let names: string[];
    try { names = await fs.promises.readdir(dir); }
    catch { return; }
    names.sort();
    for (const name of names) {
      if (stopped) return;
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(file); }
      catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth + 1 > SHARED_FOLDER_LIMITS.depth) {
          // 깊이 한도 — 안에 든 것이 있으면 잘라낸 것으로 본다.
          try { if ((await fs.promises.readdir(file)).length > 0) truncated = true; }
          catch { /* 읽을 수 없으면 건너뛴다 */ }
          continue;
        }
        await walk(file, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (depth + 1 > SHARED_FOLDER_LIMITS.depth) { truncated = true; continue; }
      if (entries.length >= SHARED_FOLDER_LIMITS.entries) { truncated = true; stopped = true; return; }
      entries.push({ path: path.relative(root, file).split(path.sep).join("/"), bytes: stat.size, modifiedAt: Math.floor(stat.mtimeMs), kind: await classifySharedEntry(file, stat) });
    }
  };
  await walk(root, 0);
  entries.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
};

/** shared/ 안의 한 자리 검사 — 어느 단계의 심볼릭 링크도 따라가지 않고 실경로가 shared/ 안인지 확인한다. */
const inspectShared = async (root: string, segments: readonly string[]) => {
  try {
    if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new UnknownSharedFile();
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new UnknownSharedFile();
    }
    if (!insideShared(root, await fs.promises.realpath(current))) throw new UnknownSharedFile();
    const stat = await fs.promises.lstat(current, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new UnknownSharedFile();
    if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) throw new UnknownSharedFile();
    return { current, stat };
  } catch (error) {
    if (error instanceof UnknownSharedFile) throw error;
    throw new UnknownSharedFile();
  }
};

/** 텍스트 한도를 넘는 파일은 이만큼의 머리만 읽어 이미지 여부를 가린다 — 나머지는 메모리에 올리지 않고 흘려보낸다. */
const SHARED_HEAD_BYTES = 64 * 1024;

/**
 * shared/ 파일 하나를 연다 — 확인-열기 사이 바꿔치기를 막으려고 O_NOFOLLOW 로 열고
 * fstat(dev/ino)이 lstat 과 같은지, 머리를 읽은 뒤에도 같은지 확인한다(evidence.ts 의 방식).
 * 텍스트 한도 이하는 통째로(`whole`), 그보다 크면 머리만 읽고 열린 핸들을 돌려준다 — 큰 파일을 버퍼 하나로 잡지 않는다.
 * 돌려받은 쪽이 핸들을 닫는다.
 */
const openSharedFile = async (root: string, raw: string) => {
  const segments = raw.split("/");
  const before = await inspectShared(root, segments);
  const handle = await fs.promises.open(before.current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") throw new UnknownSharedFile();
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameSharedFile(before.stat, opened)) throw new UnknownSharedFile();
    const size = Number(opened.size);
    const whole = size <= SHARED_FOLDER_LIMITS.textBytes;
    const head = Buffer.alloc(whole ? size : SHARED_HEAD_BYTES);
    let offset = 0;
    while (offset < head.length) {
      const { bytesRead } = await handle.read(head, offset, head.length - offset, offset);
      if (bytesRead === 0) throw new UnknownSharedFile();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await inspectShared(root, segments);
    if (!sameSharedFile(opened, after) || !sameSharedFile(after, named.stat)) throw new UnknownSharedFile();
    return { handle, size, head, whole, name: segments[segments.length - 1]! };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const ids = z.string().min(1).max(128);
const language = z.enum(["en", "ko"]).optional();
const objectiveRef = z.object({ objectiveId: ids, language });
const missionRef = z.object({ objectiveId: ids, missionId: ids, language });
/** 사람이 지휘관에게 덧붙이는 말 — 구상·개시·스티어링이 같은 상한을 쓴다. */
const context = z.string().max(MAX_CONTEXT).optional();
/** 그룹 — 사이드바 그룹 그 자체. 색은 정체성 톤 키여야 영속 상태에 남는다(목록 밖 색의 그룹은 불러올 때 버려진다). */

export function createObjectiveRoutes(ctx: ObjectivesFeatureDeps, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store), prStatus?: PrStatusService): readonly ObjectiveRoute[] {
  const actions = createObjectiveActions(ctx, store, launch, "human");
  const { unlessBusy, steerable, edited } = actions;
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>, req: http.IncomingMessage) => Promise<unknown> | unknown): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.http.writeJson(res, 400, { error: "invalid_request", issues: inputIssues(parsed.error.issues) }); return true; }
    try {
      const value = await run(parsed.data, req);
      ctx.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) { fail(res, error); }
    return true;
  };
  const fail = (res: http.ServerResponse, error: unknown) => {
    if (error instanceof ObjectiveStoreError) { ctx.http.writeJson(res, ["unknown_objective", "unknown_mission", "unknown_member", "unknown_attachment", "unknown_criterion", "unknown_proposal", "unknown_group", "unknown_followup", "unknown_evidence", "unknown_result"].includes(error.code) ? 404 : 409, { error: error.code }); return; }
    if (error instanceof ObjectiveArchiveError) { ctx.http.writeJson(res, error.status, { error: error.message }); return; }
    const code = error instanceof Error ? error.message : "objective_failed";
    ctx.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "objective_failed" });
  };
  const query = (req: http.IncomingMessage) => new URL(req.url ?? "/", "http://localhost").searchParams;
  /** 이미지 바이트를 한도까지 읽는다 — 넘으면 나머지는 흘려보내고 null. JSON 본문 한도(1MB)를 피하려고 원시 본문으로 받는다. */
  const readBytes = (req: http.IncomingMessage, limit: number): Promise<Buffer | null> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => { total += chunk.length; if (total > limit) { over = true; chunks.length = 0; return; } if (!over) chunks.push(chunk); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });

  // 메모 첨부 — 올리기(원시 이미지 바이트, 형식은 머리 바이트로 판정)·받기(id 로, 경로는 브라우저에 나가지 않는다)·지우기.
  const attachmentAdd: RouteHandler = async ({ req, res }) => {
    if (req.method !== "POST") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    const objectiveId = params.get("objectiveId");
    if (!objectiveId || objectiveId.length > 128) { ctx.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const data = await readBytes(req, MAX_ATTACHMENT_BYTES);
      if (!data) { ctx.http.writeJson(res, 413, { error: "attachment_too_large" }); return true; }
      const info = imageInfo(data);
      if (!info) { ctx.http.writeJson(res, 415, { error: "attachment_type" }); return true; }
      // 첨부는 메모의 일부다 — 지휘관이 일하는 동안에도 받고, 지휘관이 있으면 「메모」 편집으로 쌓인다.
      const add = steerable(() => true, ({ objectiveId: target }: { objectiveId: string }) => store.attachmentAdd(target, { name: attachmentName(params.get("name"), info.type), type: info.type, data, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) }));
      const result = await add({ objectiveId });
      ctx.http.writeJson(res, 200, { objective: actions.markEdited(objectiveId, ["note"]), attachmentId: result.attachment.id });
    } catch (error) { fail(res, error); }
    return true;
  };
  const attachmentFile: RouteHandler = async ({ req, res }) => {
    if (req.method !== "GET") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    const found = store.find(params.get("objectiveId") ?? "");
    const attachment = found?.attachments?.find((entry) => entry.id === params.get("attachmentId"));
    if (!found || !attachment) { ctx.http.writeJson(res, 404, { error: "unknown_attachment" }); return true; }
    try {
      const data = await fs.promises.readFile(store.attachmentPath(found, attachment));
      res.writeHead(200, { "Content-Type": attachment.type, "Content-Length": data.length, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'" });
      res.end(data);
    } catch { ctx.http.writeJson(res, 404, { error: "unknown_attachment" }); }
    return true;
  };

  const resultFile: RouteHandler = async ({ req, res }) => {
    if (req.method !== "GET") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    try {
      const { data, metadata } = await store.evidenceRead(params.get("objectiveId") ?? "", params.get("resultId") ?? "");
      res.writeHead(200, { "Content-Type": metadata.mediaType === "text/plain" ? "text/plain; charset=utf-8" : metadata.mediaType, "Content-Length": data.length, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'" });
      res.end(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") ctx.http.writeJson(res, 404, { error: "unknown_evidence" });
      else fail(res, error);
    }
    return true;
  };

  // 사람이 브라우저에서 보는 읽기 전용 경로 — 지휘관·구성원이 함께 쓰는 shared/ 폴더를 목록·파일로 연다. 쓰기 경로 없음.
  const sharedList: RouteHandler = async ({ req, res }) => {
    if (req.method !== "GET") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    try {
      const found = store.find(params.get("objectiveId") ?? "");
      if (!found) { ctx.http.writeJson(res, 404, { error: "unknown_objective" }); return true; }
      // shared/ 가 아직 없으면 만들지 말고 빈 목록 — 목록 조회가 디렉터리를 만들지 않는다.
      const root = store.sharedPath(found.commodoreId, found.id);
      ctx.http.writeJson(res, 200, root ? await listSharedFolder(root) : { entries: [], truncated: false } satisfies SharedFolderList);
    } catch (error) { fail(res, error); }
    return true;
  };

  const sharedFile: RouteHandler = async ({ req, res }) => {
    if (req.method !== "GET") { ctx.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.security.isTerminalAuthorized(req)) { ctx.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    try {
      const found = store.find(params.get("objectiveId") ?? "");
      if (!found) { ctx.http.writeJson(res, 404, { error: "unknown_objective" }); return true; }
      const raw = params.get("path") ?? "";
      if (isUnsafeSharedPath(raw)) { ctx.http.writeJson(res, 400, { error: "unsafe_path" }); return true; }
      const root = store.sharedPath(found.commodoreId, found.id);
      if (!root) { ctx.http.writeJson(res, 404, { error: "unknown_shared_file" }); return true; }
      const download = params.get("download") === "1";
      const file = await openSharedFile(root, raw);
      let streaming = false;
      try {
        const headers: Record<string, string | number> = {
          "Content-Length": file.size,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'",
        };
        const image = imageInfo(file.head);
        // 목록의 kind 를 믿지 말고 읽은 바이트로 다시 판정 — 1 MiB 을 넘는 텍스트도 내려받기로만 나간다.
        if (image && !download) {
          headers["Content-Type"] = image.type;
          headers["Content-Disposition"] = "inline";
        } else if (!download && file.whole && isSharedText(file.head)) {
          headers["Content-Type"] = "text/plain; charset=utf-8";
          headers["Content-Disposition"] = "inline";
        } else {
          headers["Content-Type"] = "application/octet-stream";
          headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeSharedFilename(file.name)}`;
        }
        res.writeHead(200, headers);
        if (file.whole) { res.end(file.head); return true; }
        // 큰 파일은 같은 열린 핸들에서 조금씩 흘려보낸다 — 경로를 다시 열지 않으므로 확인한 그 파일만 나간다.
        streaming = true;
        await pipeline(file.handle.createReadStream({ start: 0, end: file.size - 1, highWaterMark: SHARED_HEAD_BYTES, autoClose: true }), res).catch(() => res.destroy());
      } finally {
        if (!streaming) await file.handle.close();
      }
    } catch (error) {
      if (error instanceof UnknownSharedFile) ctx.http.writeJson(res, 404, { error: "unknown_shared_file" });
      else fail(res, error);
    }
    return true;
  };

  const groupsOf = (commodoreId: string) => ctx.objectiveRecords.groups?.list(commodoreId) ?? [];
  const objective = (value: Objective) => ({ objective: value });
  const syncSidebarOrder = async (moved: Objective) => {
    const reorder = ctx.objectiveRecords.reorder;
    if (!reorder) return;
    // 사람이 옮긴 미완료 목표의 Objective 자리만 명시적으로 되찾는다. 완료 기록의 순서 변경은 깨우지 않는다.
    if (!moved.done && !store.pending(moved.id)) await ctx.objectiveRecords.access?.(moved.id, "ensure-active");
    moved = store.find(moved.id) ?? moved;
    const members = ctx.objectiveRecords.list().filter((node) => node.commodoreId === moved.commodoreId && node.theaterId === moved.theaterId && (node.groupId ?? null) === moved.groupId);
    const memberIds = new Set(members.map((node) => node.id));
    const boardIds = store.list(moved.commodoreId).filter((entry) => entry.groupId === moved.groupId && memberIds.has(entry.id)).map((entry) => entry.id);
    const objectives = new Set(boardIds);
    // 목표가 차지한 자리만 재배열한다. 터미널·담당 Objective 은 기존 자리에 그대로 둔다.
    const slots = members.map((node) => node.id);
    let index = 0;
    const desired = slots.map((id) => objectives.has(id) ? boardIds[index++]! : id);
    if (desired.every((id, at) => id === slots[at])) return;
    // 호스트 포트는 한 덩어리를 삽입하므로 앞에서부터 목표 하나씩 제자리로 옮긴다.
    // 앞 멤버를 anchor 로 쓰면 이미 정렬된 접두부와 비목표 Objective 의 자리를 보존한다.
    const current = [...slots];
    for (let at = 0; at < desired.length; at += 1) {
      const id = desired[at]!;
      if (!objectives.has(id) || current[at] === id) continue;
      reorder({ commodoreId: moved.commodoreId, theaterId: moved.theaterId, groupId: moved.groupId, objectiveIds: [id], position: at === 0 ? "first" : { after: desired[at - 1]! } });
      current.splice(current.indexOf(id), 1);
      current.splice(at, 0, id);
    }
  };

  return [
    { name: "state", method: "POST", summary: "Read the objectives and groups of a Commodore.", handler: json(z.object({ commodoreId: ids, language }), ({ commodoreId }) => { prStatus?.refresh(); return { objectives: store.list(commodoreId), groups: groupsOf(commodoreId), launch: launch.describe() }; }) },
    // 완료는 보관하지 않는다 — 완료 목표 중 사람이 따로 보관해 /state 에서 빠진 것만 담는다. 폰 지휘관 목록 끝의 「보관한 완료 N」 접기가 그 목표들을 읽기 전용으로 다시 연다.
    { name: "finished", method: "POST", summary: "Read the completed objectives of a Commodore that a person archived (completion itself does not archive), most recent first (the phone's archived completed section).", handler: json(z.object({ commodoreId: ids, language }), ({ commodoreId }) => ({ objectives: store.all().filter((item) => item.commodoreId === commodoreId && item.archived === true && !!item.done && !item.removed && item.recorded !== false).sort((a, b) => (b.done?.at ?? 0) - (a.done?.at ?? 0)) })) },
    // 따로 만든 Objective 도 목표다 — 화면이 처음 보는 에이전트 Objective 을 목표 모양으로 받아 간다.
    { name: "objective/get", method: "POST", summary: "Read one objective (any agent Objective of the Theater).", handler: json(objectiveRef, ({ objectiveId }) => { prStatus?.refresh(objectiveId); const found = store.find(objectiveId); if (!found) throw new ObjectiveStoreError("unknown_objective"); return objective(found); }) },
    // 목표 레코드만 만든다 — 같은 ID의 지휘관 Objective은 첫 「구상」·「시작」 때 선다.
    { name: "objective/create", method: "POST", summary: "Create an objective without launching its Commander session.", handler: json(createObjectiveSchema, async ({ language, commodoreId, theaterId, title, groupId, note, dueDate, today, missions, viewMode }) => objective(await launch.create({ commodoreId, theaterId, theaterIdSpecified: theaterId !== "", title, groupId: groupId ?? null, note, dueDate, today, missions, viewMode }, { language }))) },
    // 라우팅 확인 스위치는 사람의 개시 방식이라 지휘관이 일하는 동안에도 받고, 지휘관에게 알릴 편집도 아니다.
    { name: "objective/patch", method: "POST", summary: "Edit an objective (its title and group are its Commander Objective's).", handler: json(objectiveRef.extend({ patch: patchObjectiveSchema }), actions.patch) },
    // 순서는 내용이 아니다 — 지휘관이 일하는 동안에도 사람이 목록을 정리할 수 있게 busy 잠금을 지나지 않는다.
    { name: "objective/move", method: "POST", summary: "Reorder an objective before or after another objective of the same Theater.", handler: json(objectiveRef.extend({ beforeId: ids.optional(), afterId: ids.optional() }).refine((body) => (body.beforeId === undefined) !== (body.afterId === undefined)), async ({ objectiveId, beforeId, afterId }) => {
      const moved = store.move(objectiveId, beforeId !== undefined ? { beforeId } : { afterId: afterId! });
      // 보드의 저장은 이미 끝났다. 호스트 동기화 실패가 성공한 카드 이동을 실패로 보이게 해서는 안 된다.
      try { await syncSidebarOrder(moved); } catch (error) { console.warn(`[objectives] sidebar reorder failed: ${error instanceof Error ? error.message : String(error)}`); }
      return objective(store.find(moved.id) ?? moved);
    }) },
    // 목표를 지우면 지휘관 Objective 이 닫힌다(삭제 유예 동안 복원할 수 있고, 담당도 함께 닫힌다).
    // 운영 주체 — 사람만 바꾼다. 사령관 보드 도구에는 이 쓰기가 없고, 사령관은 조회의 operator 로 읽기만 한다.
    { name: "objective/operator", method: "POST", summary: "Hand an objective to the Theater's Commodore (commodore true) or take it back (false). Only the person sets it; the change is kept in the objective's actions. The Commodore is woken by an objective's board changes only while it operates it.", handler: json(objectiveRef.extend({ commodore: z.boolean() }), ({ objectiveId, commodore }) => objective(store.setCommodoreOperated(objectiveId, commodore, "human"))) },
    // 사령관에게 돌려주기 — 사령관이 사람에게 넘긴 항목을 사람이 되돌린다. 넘김은 「돌려줌」으로 남고 사령관이 깨어나 그 항목을 다시 맡는다.
    { name: "person-hold/return", method: "POST", summary: "Return an item the Commodore handed to the person (decision, criteria, review or followup) to the Commodore; it can answer it again and is woken.", handler: json(objectiveRef.extend({ target: z.enum(PERSON_HOLD_TARGETS) }), actions.returnToCommodore) },
    { name: "objective/restore", method: "POST", summary: "Restore the archived Commander conversation live and idle without starting an SDK child, preserving the objective's completion and records.", handler: json(objectiveRef, async ({ objectiveId }) => objective(await launch.restore(objectiveId))) },
    // 옛 페이지의 restorable 필드는 받아 두되, 값과 기동 여부에 관계없이 복원 가능한 보관만 한다.
    { name: "objective/archive", method: "POST", summary: "Archive the Commander conversation restorably, including never-launched objectives. Permanent deletion is available only through archived-objective purge with its undo grace period.", handler: json(objectiveRef.extend({ restorable: z.boolean().optional() }), ({ objectiveId }) => launch.archive(objectiveId)) },
    // 후속 후보를 고른 완료는 새 경계다 — 검토 대기·스티어링 우선·제안 대기를 서버가 원자적으로 다시 따진다. 고른 것이 없으면 지금 완료 그대로.
    { name: "objective/complete", method: "POST", summary: "Complete an objective (its Commander Objective stays where it is; archiving is a separate action), or reopen it with undone. With followups, the chosen candidates become dormant objectives; batchId is an optional retry key.", handler: json(objectiveRef.extend({ undone: z.boolean().optional(), batchId: followupSelectionSchema.shape.batchId.optional(), followups: followupSelectionSchema.shape.followups.optional() }), actions.complete) },
    { name: "objective/extend", method: "POST", summary: "Extend a completed or review-ready objective in place: restore its Commander when archived, preserve the previous hand-off, and open a new planning round with criterion proposals.", handler: json(objectiveRef.extend({ context: z.string().trim().min(1).max(MAX_CONTEXT) }).strict(), actions.extend) },
    // 사람의 넘기기 — 지휘관이 넘기지 않은 인계 대기를 회고 없이 검토 대기로. 사람이 넘겼다는 사실이 인계 기록에 남는다.
    { name: "objective/hand-off", method: "POST", summary: "Hand an objective awaiting hand-off to review without a retrospective; the record says the person handed it off.", handler: json(objectiveRef, actions.handOff) },
    // 후속 후보에 대한 사람의 판단 — 지휘관이 알아야 할 보드 편집이 아니므로 edited 를 쌓지 않는다(기준 제안의 거절과 같다).
    { name: "followup/discard", method: "POST", summary: "Discard an open follow-up candidate; its title and summary stay as a trace.", handler: json(objectiveRef.extend({ candidateId: ids }), actions.followupDiscard) },
    { name: "followup/retry", method: "POST", summary: "Re-check or re-create a failed or unconfirmed follow-up with the same snapshot and key.", handler: json(objectiveRef.extend({ batchId: ids, candidateId: ids }), actions.followupRetry) },
    { name: "followup/abandon", method: "POST", summary: "Give up a failed follow-up; the candidate returns to open.", handler: json(objectiveRef.extend({ batchId: ids, candidateId: ids }), actions.followupAbandon) },
    { name: "member/add", method: "POST", summary: "Add a member to the roster.", handler: json(objectiveRef.extend({ member: memberAddSchema }), actions.memberAdd) },
    // 띄운 구성원의 모델만 바꾸면 그 세션의 좌표 변경이다(곧바로 또는 이번 턴 뒤) — 지휘관의 일과 무관한 값이라 편집으로 쌓지 않는다.
    { name: "member/patch", method: "POST", summary: "Edit a member's role, brief, launch selection, or subagent opt-in. For a member whose session exists, a launch selection switches that session's model now (dormant or idle) or after its current turn (working).", handler: json(objectiveRef.extend({ memberId: ids, patch: memberPatchSchema }), actions.memberPatch) },
    { name: "member/next-cancel", method: "POST", summary: "Cancel a member's after-turn model reservation (or dismiss its failure): the session keeps its running model and the earlier selection returns.", handler: json(objectiveRef.extend({ memberId: ids }), steerable(() => true, async ({ objectiveId, memberId }) => objective(await launch.memberNextCancel(objectiveId, memberId)))) },
    // 판단 한 번의 비용이 든다 — 같은 설명·같은 대상이면 10분 동안 다시 판단하지 않고, 개시가 그 결과를 그대로 쓴다.
    { name: "routing/preview", method: "POST", summary: "Judge (or reuse, within 10 minutes and unchanged roles) the AI Gateway model for each member Commence would newly launch by routing; rejudge forces one new judgment.", handler: json(objectiveRef.extend({ rejudge: z.boolean().optional() }), unlessBusy(async ({ objectiveId, rejudge }) => ({ preview: await launch.routingPreview(objectiveId, { rejudge }) }))) },
    { name: "member/batch-launch", method: "POST", summary: "Set all eligible members' launch selection to same or route, preserving custom models.", handler: json(objectiveRef.merge(memberBatchLaunchSchema), actions.memberBatchLaunch) },
    { name: "member/remove", method: "POST", summary: "Remove a member and return its mission ids for undo.", handler: json(objectiveRef.extend({ memberId: ids }), actions.memberRemove) },
    { name: "mission/add", method: "POST", summary: "Add a mission.", handler: json(objectiveRef.extend({ mission: missionAddSchema }), actions.missionAdd) },
    { name: "mission/patch", method: "POST", summary: "Edit a mission (text, done, dependencies, member).", handler: json(missionRef.extend({ patch: missionPatchSchema }), actions.missionPatch) },
    // 읽음은 편집이 아니다 — 지휘관이 일하는 동안에도 받고, 지휘관에게 알릴 것도 없다.
    { name: "mission/seen", method: "POST", summary: "Mark every record of a mission as read by the person.", handler: json(missionRef, ({ objectiveId, missionId }) => objective(store.missionSeen(objectiveId, missionId))) },
    { name: "mission/remove", method: "POST", summary: "Remove a mission.", handler: json(missionRef, actions.missionRemove) },
    { name: "edge/toggle", method: "POST", summary: "Link or unlink two missions in the lineup.", handler: json(objectiveRef.extend({ from: ids, to: ids, linked: z.boolean().optional() }), actions.edge) },
    { name: "plan/request", method: "POST", summary: "Ask the Commander to plan the objective (starts one when missing): it lays out missions, prerequisites and delegation; nothing runs until Commence. Optional context travels with the request and is kept on the objective.", handler: json(objectiveRef.extend({ context }), actions.plan) },
    { name: "commander/compact", method: "POST", summary: "Send /compact to the Commander and every member Objective of an objective through the normal delivery path; returns per-target outcomes.", handler: json(objectiveRef, actions.compact) },
    { name: "commander/stop", method: "POST", summary: "Interrupt the Commander and every member Objective of an objective (roster stays).", handler: json(objectiveRef, actions.stop) },
    { name: "commander/start", method: "POST", summary: "Commence: launch or resume every member before sending the Commander's first turn. Optional context from the person is quoted under it once. routing \"preview\" launches routed members with the judgment the person just reviewed. Members the host refused are listed in failed.", handler: json(objectiveRef.extend({ context, routing: z.literal("preview").optional() }), actions.commence) },
    // 결정 요청에 대한 사람의 답 — 보드 편집이 아니다(edited 를 쌓지 않는다). 지휘관이 일하는 중에도 받고, 기준 제안이 남아도 보낸다.
    { name: "decision/answer", method: "POST", summary: "Answer the Commander's current decision request: every question at once. The answers reach the same Commander conversation (starting an SDK child only when needed); once delivered they stay as decisions and the request clears.", handler: json(decisionAnswersSchema.extend({ objectiveId: ids, language }), actions.answer) },
    // 「결정 안 함」 닫기 — 요청 전체를 선택·입력 없이 닫는다. 답과 같은 전달·잠금·중복 규칙을 쓰고, 결정에는 질문마다 「결정 안 함」 표시가 남는다.
    { name: "decision/decline", method: "POST", summary: "Close the Commander's current decision request without deciding: no option chosen, nothing handed to the Commander, nothing deferred. Recorded per question as declined and the request clears.", handler: json(objectiveRef.extend({ requestId: ids }), actions.decline) },
    { name: "commander/message", method: "POST", summary: "Send the person's words verbatim to the Commander or one member session, with the images the person attached (attachmentIds from the Console attachment upload) riding only that one session; text may be empty only when attachmentIds are present; a member message is also quoted to the Commander in one line.", handler: json(objectiveRef.extend({ memberId: ids.nullable().optional(), text: z.string().trim().max(MAX_CONTEXT), attachmentIds: z.array(z.string().min(1).max(128)).min(1).max(4).optional() })
      // 문면이 비어도 첨부가 있으면 보낼 말이다 — 둘 다 없으면 문면 길이 위반으로 거절한다.
      .superRefine((body, issue) => {
        if (!body.text && !body.attachmentIds?.length) issue.addIssue({ code: "too_small", origin: "string", minimum: 1, inclusive: true, path: ["text"], message: "text is required without attachmentIds" });
      }), actions.message) },
    { name: "conversation/broadcast", method: "POST", summary: "Send the person's words to the live Commander and members concurrently, including idle or restored chats, but skipping dormant terminals.", handler: json(objectiveRef.extend({ text: z.string().trim().min(1).max(MAX_CONTEXT) }).strict(), ({ objectiveId, text }) => launch.broadcast(objectiveId, text)) },
    { name: "commander/steer", method: "POST", summary: "Tell the Commander (working or awaiting review) the person changed the board (one line, with the person's optional context quoted), clear the pending changes and the criteria it had judged met.", handler: json(objectiveRef.extend({ context }), actions.steer) },
    { name: "palette-search", method: "POST", summary: "Search objectives by title for the command palette: open ones first, then completed ones, archived or not.", handler: json(z.object({ commodoreId: ids, language, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }), ({ commodoreId, query, limit }) => {
      const needle = query.toLowerCase();
      const matches = (candidate: Objective) => !candidate.removed && candidate.title.toLowerCase().includes(needle);
      // 끝나지 않은 목표가 먼저, 그다음 보관 여부와 무관한 완료 목표 — 완료는 보관하지 않으므로 아직 보관하지 않은 완료도 찾아 보관할 수 있어야 한다.
      const open = store.list(commodoreId).filter((candidate) => !candidate.done && matches(candidate));
      const done = store.all().filter((candidate) => candidate.commodoreId === commodoreId && !!candidate.done && candidate.recorded !== false && matches(candidate)).sort((a, b) => (b.done?.at ?? 0) - (a.done?.at ?? 0));
      const hits = [...open, ...done].slice(0, limit ?? 20);
      return { objectives: hits.map((candidate) => ({ id: candidate.id, title: candidate.title, groupId: candidate.groupId, ...(candidate.done ? { done: true } : {}) })) };
    }) },
    // 달성 기준 — 브리핑처럼 지휘관이 일하는 동안에도 받고, 지휘관이 있으면 「달성 기준」 편집으로 쌓여 스티어링이 알린다.
    { name: "criterion/add", method: "POST", summary: "Add a success criterion below the missions.", handler: json(objectiveRef.extend({ criterion: criterionAddSchema }), actions.criterionAdd) },
    { name: "criterion/patch", method: "POST", summary: "Edit a success criterion.", handler: json(objectiveRef.extend({ criterionId: ids, patch: criterionPatchSchema }), actions.criterionPatch) },
    { name: "criterion/remove", method: "POST", summary: "Remove a success criterion.", handler: json(objectiveRef.extend({ criterionId: ids }), actions.criterionRemove) },
    // 제안에 대한 사람의 판단·어노테이션은 지휘관 자신의 제안에 대한 답이라 edited 종류를 쌓지 않는다.
    { name: "criterion/approve", method: "POST", summary: "Approve one proposed success criterion change.", handler: json(objectiveRef.extend({ proposalId: ids }), actions.approve) },
    { name: "criterion/approve-all", method: "POST", summary: "Approve all proposed success criterion changes.", handler: json(objectiveRef, actions.approveAll) },
    { name: "criterion/reject", method: "POST", summary: "Reject one proposed success criterion change.", handler: json(objectiveRef.extend({ proposalId: ids }), actions.reject) },
    { name: "criterion/annotate", method: "POST", summary: "Annotate a proposed success criterion change (empty text removes the annotation).", handler: json(objectiveRef.extend({ proposalId: ids, annotation: z.string().max(300) }), actions.annotate) },
    { name: "result/file", method: "GET", summary: "Read preserved evidence by objectiveId and resultId; images are inline and documents are plain UTF-8 text.", handler: resultFile },
    { name: "attachment/add", method: "POST", summary: "Attach an image to an objective's brief (raw PNG/JPEG/WebP/GIF body, up to 10 MB, 20 per objective).", handler: attachmentAdd },
    { name: "attachment/file", method: "GET", summary: "Read an attached image by id.", handler: attachmentFile },
    { name: "shared/list", method: "GET", summary: "Read an objective's shared folder file list (read-only).", handler: sharedList },
    { name: "shared/file", method: "GET", summary: "Read one file from an objective's shared folder by relative path (read-only).", handler: sharedFile },
    { name: "attachment/remove", method: "POST", summary: "Remove an image from an objective's brief.", handler: json(objectiveRef.extend({ attachmentId: ids }), steerable(() => true, ({ objectiveId, attachmentId }) => edited(objectiveId, ["note"], () => store.attachmentRemove(objectiveId, attachmentId)))) },
    { name: "plan/apply", method: "POST", summary: "Replace the unassigned missions with a plan (Commander tool path; also used by tests).", handler: json(objectiveRef.extend({ plan: planSchema.omit({ criteria: true }) }), ({ objectiveId, plan }) => objective(launch.planApplied(objectiveId, plan))) },
  ];
}
