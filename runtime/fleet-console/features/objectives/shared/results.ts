import { z } from "zod";

/** 결과물 계약 — 서버 저장과 공개 DTO가 공유한다. 절대 경로와 실행 세션 식별자는 담지 않는다. */
export const RESULT_LIMITS = {
  count: 40,
  evidenceCount: 20,
  imageBytes: 10 * 1024 * 1024,
  textBytes: 1024 * 1024,
  totalEvidenceBytes: 100 * 1024 * 1024,
  pendingEvidence: 20,
  pendingEvidenceTtlMs: 24 * 60 * 60 * 1000,
  evidenceGcMs: 60 * 60 * 1000,
  label: 120,
  note: 300,
  url: 2048,
  sourcePath: 4096,
  prRefreshMs: 60 * 1000,
  prSettledRefreshMs: 15 * 60 * 1000,
  prTimeoutMs: 15 * 1000,
  prResponseBytes: 1024 * 1024,
  prTitle: 200,
  prConcurrency: 2,
  prBackoffMs: [60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000],
} as const;

const id = z.string().uuid();
const missionId = z.string().min(1).max(128);
const label = z.string().trim().min(1).max(RESULT_LIMITS.label);
const note = z.string().trim().min(1).max(RESULT_LIMITS.note).regex(/^[^\r\n]*$/);
const completionCommon = { label: label.optional(), note: note.optional() };
const commonInput = { ...completionCommon, sourceMissionId: missionId.optional() };
const url = z.string().trim().min(1).max(RESULT_LIMITS.url);

export const completionResultInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), ...completionCommon, url }).strict(),
  z.object({ kind: z.literal("evidence"), ...completionCommon, evidenceId: id }).strict(),
  z.object({ kind: z.literal("artifact"), ...completionCommon, url }).strict(),
]);
export const completionResultsSchema = z.array(completionResultInputSchema).max(RESULT_LIMITS.count);
export type CompletionResultInput = z.output<typeof completionResultInputSchema>;

export const resultInputSchema = z.discriminatedUnion("kind", [
  completionResultInputSchema.options[0].extend({ sourceMissionId: missionId.optional() }),
  completionResultInputSchema.options[1].extend({ sourceMissionId: missionId.optional() }),
  completionResultInputSchema.options[2].extend({ sourceMissionId: missionId.optional() }),
]);
export type ResultInput = z.output<typeof resultInputSchema>;

/** kind 는 바뀌지 않는다. null 은 선택 필드만 지우고, 없는 필드는 유지한다. */
export const resultPatchSchema = z.object({
  label: label.nullable().optional(), note: note.nullable().optional(), sourceMissionId: missionId.nullable().optional(),
  url: z.string().trim().min(1).max(RESULT_LIMITS.url).optional(), evidenceId: id.optional(),
}).strict();
export type ResultPatch = z.output<typeof resultPatchSchema>;

export const prErrorSchema = z.enum(["gh_unavailable", "auth_required", "forbidden", "not_found_or_forbidden", "rate_limited", "timeout", "network", "invalid_response", "lookup_failed"]);
const prState = z.enum(["open", "merged", "closed"]);
const timestamp = z.number().finite().nonnegative();
const lastSuccess = z.object({ state: prState, checkedAt: timestamp }).strict();
const prTitle = z.string().min(1).max(RESULT_LIMITS.prTitle).regex(/^[^\u0000-\u001f\u007f]+$/).optional();
export const prObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unchecked"), checkedAt: z.null(), stale: z.boolean(), title: prTitle, lastSuccess: lastSuccess.optional() }).strict(),
  z.object({ state: prState, checkedAt: timestamp, stale: z.boolean(), title: prTitle, lastSuccess: lastSuccess.optional(), }).strict(),
  z.object({ state: z.literal("error"), checkedAt: timestamp, stale: z.boolean(), title: prTitle, lastSuccess: lastSuccess.optional(), error: z.object({ code: prErrorSchema }).strict() }).strict(),
]);
export type PrObservation = z.output<typeof prObservationSchema>;

/** 파일 형식·크기는 seal 서비스가 확인한 값만 저장한다. 원본 경로는 없다. */
export const evidenceMetadataSchema = z.object({
  evidenceId: id,
  name: z.string().min(1).max(RESULT_LIMITS.label).regex(/^[^/\\\u0000-\u001f\u007f]+$/),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"]),
  bytes: z.number().int().positive().max(RESULT_LIMITS.imageBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  capturedAt: timestamp,
}).strict().refine((value) => value.mediaType !== "text/plain" || value.bytes <= RESULT_LIMITS.textBytes);
export type EvidenceMetadata = z.output<typeof evidenceMetadataSchema>;
/** 미첨부 증거도 목표가 보존한다. 소유 Operation은 서버 manifest에만 남는다. */
export const storedEvidenceSchema = evidenceMetadataSchema.safeExtend({ ownerOperationId: z.string().min(1).max(128) });
export type StoredEvidence = z.output<typeof storedEvidenceSchema>;

export class ResultValidationError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function prTarget(raw: string) {
  // URL 정규화로 '..' 나 인코딩을 지운 뒤 허용하지 않는다. 입력 모양 자체를 검사한다.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/i.exec(raw);
  if (!match || match[2] === "." || match[2] === ".." || !Number.isSafeInteger(Number(match[3]))) {
    let host: string | undefined;
    try { host = new URL(raw).hostname.toLowerCase(); } catch { /* 형식 오류 */ }
    throw new ResultValidationError(host && host !== "github.com" ? "unsupported_pr_host" : "invalid_pr_url");
  }
  const owner = match[1]!.toLowerCase();
  const repo = match[2]!.toLowerCase();
  const number = Number(match[3]);
  return { url: `https://github.com/${owner}/${repo}/pull/${number}`, host: "github.com" as const, owner, repo, number };
}

export function artifactTarget(raw: string) {
  // 정규화 전에 주소 전체를 검사한다 — 포트·userinfo·query·fragment는 참조 계약 밖이다.
  const match = /^(https):\/\/([^/]+)(\/artifact\/[A-Za-z0-9_-]{1,64}|\/code\/artifact\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\/?$/.exec(raw.replace(/^https:/i, "https:"));
  if (!match || match[2]!.toLowerCase() !== "claude.ai") {
    let host: string | undefined;
    try { host = new URL(raw).hostname.toLowerCase(); } catch { /* 형식 오류 */ }
    throw new ResultValidationError(host && host !== "claude.ai" ? "unsupported_artifact_host" : "invalid_artifact_url");
  }
  const pathname = match[3]!;
  return { url: `https://claude.ai${pathname.startsWith("/code/artifact/") ? pathname.toLowerCase() : pathname}` };
}

export function checkedResultInput(raw: unknown): ResultInput {
  const parsed = resultInputSchema.safeParse(raw);
  if (!parsed.success) throw new ResultValidationError("invalid_arguments");
  const input = parsed.data;
  switch (input.kind) {
    case "pr": return { ...input, url: prTarget(input.url).url };
    case "artifact": return { ...input, url: artifactTarget(input.url).url };
    case "evidence": return input;
  }
}

const savedCommon = { id, ...commonInput, createdAt: timestamp, updatedAt: timestamp };
export const storedResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), ...savedCommon, url: z.string().max(RESULT_LIMITS.url), host: z.literal("github.com"), owner: z.string(), repo: z.string(), number: z.number().int().positive(), observation: prObservationSchema }).strict().refine((value) => {
    try { const target = prTarget(value.url); return target.url === value.url && target.owner === value.owner && target.repo === value.repo && target.number === value.number; }
    catch { return false; }
  }),
  evidenceMetadataSchema.safeExtend({ kind: z.literal("evidence"), ...savedCommon }),
  z.object({ kind: z.literal("artifact"), ...savedCommon, url: z.string().max(RESULT_LIMITS.url) }).strict().refine((value) => {
    try { return artifactTarget(value.url).url === value.url; }
    catch { return false; }
  }),
]);
export type ObjectiveResult = z.output<typeof storedResultSchema>;

/** 결과물의 실체가 같으면 label·note 와 무관하게 한 줄이다. */
export function resultIdentity(result: ResultInput | ObjectiveResult): string {
  return result.kind === "evidence" ? `evidence:${result.evidenceId}` : `${result.kind}:${result.url}`;
}

export const storedResultsSchema = z.array(storedResultSchema).max(RESULT_LIMITS.count).refine((results) => {
  const evidence = results.filter((result) => result.kind === "evidence");
  return new Set(results.map((result) => result.id)).size === results.length
    && new Set(results.map(resultIdentity)).size === results.length
    && evidence.length <= RESULT_LIMITS.evidenceCount
    && evidence.reduce((total, item) => total + item.bytes, 0) <= RESULT_LIMITS.totalEvidenceBytes;
});

/** 같은 kind 에 해당하는 필드만 수정한다. 관측값·파일 metadata 는 호출자가 쓸 수 없다. */
export function patchedResultInput(result: ObjectiveResult, raw: ResultPatch): ResultInput {
  const parsed = resultPatchSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) throw new ResultValidationError("invalid_arguments");
  const patch = parsed.data;
  const fields = ["label", "note", "sourceMissionId", result.kind === "evidence" ? "evidenceId" : "url"];
  if (Object.keys(patch).some((key) => !fields.includes(key))) throw new ResultValidationError("invalid_arguments");
  const input: Record<string, unknown> = { kind: result.kind };
  for (const field of fields) {
    const value = field in patch ? (patch as Record<string, unknown>)[field] : (result as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) input[field] = value;
  }
  return checkedResultInput(input);
}
