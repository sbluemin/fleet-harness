/**
 * dispatch/prompt.ts — 캐리어 시스템 프롬프트 조립 및 request-block 검증
 *
 * buildCarrierSystemPrompt는 캐리어 시스템 프롬프트 조립 SSoT입니다.
 * tool-spec.ts와 taskforce.ts가 단방향으로 참조합니다.
 */

import type { AuthEnvResolver } from "@dotobokuri/core-agent";
import type { WorkspaceChangeScanner } from "../jobs/workspace-manifest.js";
import type { CarrierMetadata, CarrierRequest, RequestBlock } from "./types.js";

/** 검증 성공 결과 */
export interface RequiredBlockValidationOk {
  ok: true;
}

/** 검증 실패 결과 */
export interface RequiredBlockValidationFail {
  ok: false;
  missing: string[];
  error: string;
}

export type RequiredBlockValidationResult =
  | RequiredBlockValidationOk
  | RequiredBlockValidationFail;

export interface CarrierToolSpecDeps {
  readonly authEnvResolver: AuthEnvResolver;
  readonly reservedExternalMcpServerIds?: readonly string[];
  readonly workspaceChangeScanner?: WorkspaceChangeScanner;
}

const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

// 모든 캐리어 공통 응답 프로토콜 — metadata 유무와 무관하게 항상 주입한다.
const COMMON_RESPONSE_PROTOCOL = `<response_protocol>
Keep progress narration concise — at most one line per meaningful step. No verbose play-by-play or step-by-step essays (short streaming lines are acceptable for the live observation channel).

When the mission is complete, wrap the entire final output in a <report>...</report> tag and emit it exactly once, at the very end. The Admiral retrieves only the report block, so everything you need to convey — results, evidence, file paths, caveats — must be inside it. Your persona's output_format structure applies inside the report block as usual.

Do not mention or demonstrate the literal opening and closing report tag anywhere in the body outside that final block.
</response_protocol>`;

// ═════════════════════════════════════════════════════════
// 캐리어 시스템 프롬프트 (Tier 2)
// ═════════════════════════════════════════════════════════

export function buildCarrierSystemPrompt(metadata?: CarrierMetadata): string {
  const parts: string[] = [CARRIER_FLEET_BACKGROUND, COMMON_RESPONSE_PROTOCOL];

  if (metadata) {
    parts.push(`<your_identity>\n${metadata.title}\n${metadata.summary}\n</your_identity>`);

    if (metadata.permissions.length > 0) {
      const body = metadata.permissions.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_permissions>\n${body}\n</your_permissions>`);
    }

    const principles = metadata.principles ?? [];
    if (principles.length > 0) {
      const body = principles.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_principles>\n${body}\n</your_principles>`);
    }

    if (metadata.outputFormat) {
      parts.push(`<output_format>\n${metadata.outputFormat.trim()}\n</output_format>`);
    }
  }

  return parts.join("\n\n");
}

/**
 * 필수 requestBlock이 request 텍스트에 정상적으로 존재하는지 검사합니다.
 *
 * opening tag, closing tag, 비어 있지 않은 본문을 모두 확인합니다.
 * 속성이 포함된 태그도 허용합니다: `<task_refs source="host">...</task_refs>`
 *
 * @param meta carrier 메타데이터
 * @param request 사용자 요청 텍스트
 * @param carrierId 검증 실패 시 에러 메시지에 포함할 carrier 식별자
 */
export function validateRequiredRequestBlocks(
  meta: CarrierMetadata,
  request: string,
  carrierId: string,
): RequiredBlockValidationResult {
  return validateParsedRequiredRequestBlocks(meta, parseCarrierRequest(meta, request), carrierId);
}

/** Validate a request structure already parsed by the dispatch path. */
export function validateParsedRequiredRequestBlocks(
  meta: CarrierMetadata,
  parsed: CarrierRequest,
  carrierId: string,
): RequiredBlockValidationResult {
  const required = meta.requestBlocks.filter((b) => b.required);
  if (required.length === 0) return { ok: true };

  const missing: string[] = [];
  const details: string[] = [];

  const parsedByTag = new Map(parsed.blocks.map((block) => [block.tag, block]));
  for (const block of required) {
    const observed = parsedByTag.get(block.tag);
    if (!observed?.present) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (missing closing tag)`);
    } else if (!observed.body.trim()) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (empty body)`);
    }
  }

  if (missing.length === 0) return { ok: true };

  // 자기회복 폴백: 거절 에러가 해당 캐리어의 블록 계약 전문을 되돌려줘,
  // 호출자가 계약을 미리 로드하지 않았어도 로컬 왕복 1회로 재작성할 수 있게 한다.
  return {
    ok: false,
    missing,
    error:
      `Missing required request block(s) for carrier "${carrierId}": ${details.join(", ")}.` +
      ` Compose the request with this carrier's request-block contract and resubmit:\n` +
      formatRequestBlocksGuide(meta).join("\n"),
  };
}

/** 캐리어 request-block 계약을 로스터/스킬/에러 공용 가이드 라인 목록으로 렌더한다. */
export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  const allBlocks: RequestBlock[] = [...meta.requestBlocks];
  if (allBlocks.length === 0) return [];
  return allBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}

/**
 * Produce the observer request structure without modifying the executor input.
 * Only the first balanced top-level instance of each configured tag is selected.
 */
export function parseCarrierRequest(meta: CarrierMetadata | undefined, request: string): CarrierRequest {
  const selected = new Map<string, ParsedBlock>();
  const candidates: ParsedBlockCandidate[] = [];
  const configured = new Set(meta?.requestBlocks.map((block) => block.tag) ?? []);
  const stack: OpenTag[] = [];
  const openedTags: OpenTag[] = [];
  let capture: OpenConfiguredTag | undefined;

  for (let cursor = 0; cursor < request.length;) {
    const read = readTag(request, cursor);
    cursor = read.next;
    const token = read.token;
    if (!token) continue;

    if (capture) {
      // Once a top-level configured block starts, all other tags are literal body text.
      // Only same-name nesting changes the boundary of that block.
      if (token.name === capture.name && !token.selfClosing) {
        if (token.closing) {
          capture.depth--;
          if (capture.depth === 0) {
            candidates.push({
              name: token.name,
              start: capture.start,
              end: token.end,
              body: request.slice(capture.contentStart, token.start),
              ancestor: capture.ancestor,
            });
            capture = undefined;
          }
        } else {
          capture.depth++;
        }
      }
      continue;
    }

    if (token.selfClosing) continue;
    if (!token.closing) {
      if (configured.has(token.name)) {
        capture = {
          name: token.name,
          start: token.start,
          contentStart: token.end,
          depth: 1,
          ancestor: stack.at(-1),
        };
      } else {
        const opened: OpenTag = {
          name: token.name,
          parent: stack.at(-1),
          balanced: false,
          insideBalanced: false,
        };
        openedTags.push(opened);
        stack.push(opened);
      }
      continue;
    }
    const opened = stack.at(-1);
    if (!opened || opened.name !== token.name) continue;
    opened.balanced = true;
    stack.pop();
  }

  // 실제로 닫힌 비설정 래퍼에 감싸지 않은 설정 블록은 최상위로 취급한다.
  // 부모 링크를 사용해 잘못된 긴 접두사와 후보가 많아도 2차 순회를 선형으로 유지한다.
  for (const opened of openedTags) {
    opened.insideBalanced = opened.balanced || (opened.parent?.insideBalanced ?? false);
  }
  for (const candidate of candidates) {
    if (candidate.ancestor?.insideBalanced || selected.has(candidate.name)) continue;
    selected.set(candidate.name, candidate);
  }

  const blocks = (meta?.requestBlocks ?? []).map((block) => {
    const parsed = selected.get(block.tag);
    return { ...block, present: parsed !== undefined, body: parsed?.body ?? "" };
  });
  const ranges = [...selected.values()].sort((left, right) => left.start - right.start);
  let additional = "";
  let cursor = 0;
  for (const range of ranges) {
    additional += request.slice(cursor, range.start);
    cursor = range.end;
  }
  additional += request.slice(cursor);
  return { blocks, additional };
}

interface ParsedBlock {
  start: number;
  end: number;
  body: string;
}

interface ParsedBlockCandidate extends ParsedBlock {
  name: string;
  ancestor: OpenTag | undefined;
}

interface OpenTag {
  name: string;
  parent: OpenTag | undefined;
  balanced: boolean;
  insideBalanced: boolean;
}

interface OpenConfiguredTag {
  name: string;
  start: number;
  contentStart: number;
  depth: number;
  ancestor: OpenTag | undefined;
}

interface RequestTag {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

interface ReadTagResult {
  token: RequestTag | undefined;
  next: number;
}

/** Read a permissive XML-like tag while preserving every non-selected character verbatim. */
function readTag(source: string, start: number): ReadTagResult {
  if (source[start] !== "<") return { token: undefined, next: start + 1 };
  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === "/") {
    closing = true;
    cursor++;
  }
  const nameStart = cursor;
  while (cursor < source.length && /[A-Za-z0-9_.:-]/.test(source[cursor]!)) cursor++;
  if (cursor === nameStart) return { token: undefined, next: start + 1 };
  const name = source.slice(nameStart, cursor);
  let quote: string | undefined;
  for (; cursor < source.length; cursor++) {
    const character = source[cursor]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      const beforeClose = source.slice(start, cursor).trimEnd();
      return { token: { name, start, end: cursor + 1, closing, selfClosing: !closing && beforeClose.endsWith("/") }, next: cursor + 1 };
    }
    if (character === "<") {
      // A later tag-like prefix terminates this malformed opener. Resume at it so
      // repeated unterminated prefixes each scan only their own span.
      return { token: undefined, next: cursor };
    }
  }
  // No later prefix remains, so the inspected suffix cannot yield another tag.
  return { token: undefined, next: source.length };
}
