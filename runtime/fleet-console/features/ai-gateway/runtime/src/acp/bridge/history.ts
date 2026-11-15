import { createHash } from "node:crypto";

import {
  canonicalMessageImages,
  canonicalMessageText,
  type CanonicalInputItem,
  type CanonicalInputMessage,
} from "../../canonical/index.js";
import type { AcpPromptBlock } from "../contract.js";

/**
 * Messages 이력 ↔ agy 세션의 짝짓기(지문)와, 짝이 깨졌을 때 새 세션에 다시 넣을 이력 렌더.
 *
 * Messages는 요청마다 전체 이력을 보내지만 ACP에는 이력을 넣는 방법이 없다. 그래서 세션이 낸 assistant 턴까지의
 * 이력을 해시 체인으로 기억해 두고, 다음 요청의 이력 앞부분이 그 체인과 같으면 같은 세션이 이어 간다.
 */

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** 키를 정렬한 JSON. 도구 입력이 왕복하며 키 순서가 바뀌어도 같은 지문이 나오게 한다. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizedArguments(raw: string): string {
  try { return stableJson(JSON.parse(raw)); } catch { return raw; }
}

function imageDigest(content: CanonicalInputMessage["content"]): string {
  return canonicalMessageImages(content).map((image) => sha(image.image_url)).join(",");
}

/**
 * 항목 하나의 지문. thinking·reasoning 메타데이터는 넣지 않는다 — Claude Code가 이전 턴의 thinking을 빼거나
 * 서명을 바꿀 수 있고, 어느 쪽이든 모델이 한 일의 내용은 아니다.
 */
export function itemDigest(item: CanonicalInputItem): string | undefined {
  switch (item.type) {
    case "message": {
      const text = canonicalMessageText(item.content);
      const body = item.role === "assistant" ? text.trim() : text;
      const images = imageDigest(item.content);
      if (body.length === 0 && images.length === 0) return undefined;
      return `m|${item.role}|${body}|${images}`;
    }
    case "function_call":
      return `c|${item.call_id}|${item.name}|${normalizedArguments(item.arguments)}`;
    case "function_call_output":
      return `o|${item.call_id}|${item.is_error === true ? 1 : 0}|${canonicalMessageText(item.output)}|${imageDigest(item.output)}`;
    default:
      return undefined;
  }
}

export function chainStart(seed: string): string {
  return sha(`seed|${seed}`);
}

export function chainStep(previous: string, digest: string | undefined): string {
  return digest === undefined ? previous : sha(`${previous}|${digest}`);
}

/** `chain[p]` = 시드와 `items[0..p)`의 체인. 길이는 `items.length + 1`이다. */
export function chainOf(seed: string, items: readonly CanonicalInputItem[]): string[] {
  const chain = [chainStart(seed)];
  for (const item of items) chain.push(chainStep(chain[chain.length - 1]!, itemDigest(item)));
  return chain;
}

/** 세션이 낸 assistant 턴(텍스트 + 도구 호출들)을 체인에 이어 붙인 값. */
export function chainAfterAssistant(
  previous: string,
  turn: { readonly text: string; readonly calls: readonly { readonly callId: string; readonly name: string; readonly arguments: string }[] },
): string {
  let chain = previous;
  const text = turn.text.trim();
  if (text.length > 0) chain = chainStep(chain, `m|assistant|${text}|`);
  for (const call of turn.calls) {
    chain = chainStep(chain, `c|${call.callId}|${call.name}|${normalizedArguments(call.arguments)}`);
  }
  return chain;
}

// ── 프롬프트 블록 ───────────────────────────────────────────────────────────

const MAX_IMAGE_BLOCKS = 8;

function imageBlocks(contents: readonly CanonicalInputMessage["content"][]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [];
  for (const content of contents) {
    for (const image of canonicalMessageImages(content)) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.image_url);
      blocks.push(match
        ? { kind: "image", mimeType: match[1]!, data: match[2]! }
        : { kind: "text", text: `[image: ${image.image_url}]` });
    }
  }
  return blocks.slice(-MAX_IMAGE_BLOCKS);
}

function userContents(items: readonly CanonicalInputItem[]): CanonicalInputMessage["content"][] {
  return items.flatMap((item) => (item.type === "message" ? [item.content] : item.type === "function_call_output" ? [item.output] : []));
}

/** 같은 세션의 새 턴: 꼬리의 user 메시지 텍스트와 이미지를 그대로 보낸다. */
export function userTurnBlocks(items: readonly CanonicalInputItem[]): AcpPromptBlock[] {
  const text = items
    .flatMap((item) => (item.type === "message" ? [canonicalMessageText(item.content)] : []))
    .filter((part) => part.length > 0)
    .join("\n\n");
  return [
    { kind: "text", text: text.length > 0 ? text : "(no text)" },
    ...imageBlocks(userContents(items)),
  ];
}

// ── 이력 재주입 ─────────────────────────────────────────────────────────────

/** 세션을 새로 열 때 첫 프롬프트에 넣는 이력 형식. 모델이 이것을 자기 이력으로 취급함을 실측했다(m3-replay). */
export const REPLAY_SYSTEM_NOTE = "You are continuing a conversation that was moved from another session. "
  + "The previous turns are given verbatim in <conversation_history>. Treat them as what already happened; "
  + "do not redo tool calls that already have results.";

const CONTINUE_AFTER_TOOL_RESULTS = "Continue from the last tool result above.";
const TRUNCATION_CAPS: readonly number[] = [Number.POSITIVE_INFINITY, 8_000, 2_000, 400];

function escapeMarkup(text: string): string {
  return text.replace(/<(\/?)(turn|tool_use|tool_result|conversation_history)\b/g, "<​$1$2");
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap * 0.6);
  const tail = cap - head;
  return `${text.slice(0, head)}\n[... ${text.length - cap} characters omitted ...]\n${text.slice(text.length - tail)}`;
}

interface Turn {
  readonly role: "user" | "assistant";
  /** 본문 조각. `clippable`인 것은 용량이 모자라면 줄인다. */
  readonly parts: readonly { readonly text: string; readonly clippable: boolean; readonly open?: string; readonly close?: string }[];
}

function toTurns(items: readonly CanonicalInputItem[]): Turn[] {
  const turns: Turn[] = [];
  const push = (role: Turn["role"], part: Turn["parts"][number]): void => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) { turns[turns.length - 1] = { role, parts: [...last.parts, part] }; return; }
    turns.push({ role, parts: [part] });
  };
  for (const item of items) {
    if (item.type === "message") {
      const text = canonicalMessageText(item.content);
      const images = canonicalMessageImages(item.content).length;
      const body = images > 0 ? `${text}${text.length > 0 ? "\n" : ""}[image omitted]`.trim() : text;
      if (body.length > 0) push(item.role === "assistant" ? "assistant" : "user", { text: body, clippable: false });
    } else if (item.type === "function_call") {
      push("assistant", {
        text: normalizedArguments(item.arguments),
        clippable: true,
        open: `<tool_use id="${item.call_id}" name="${item.name}">`,
        close: "</tool_use>",
      });
    } else if (item.type === "function_call_output") {
      const text = canonicalMessageText(item.output);
      const images = canonicalMessageImages(item.output).length;
      push("user", {
        text: images > 0 ? `${text}${text.length > 0 ? "\n" : ""}[image omitted]` : text,
        clippable: true,
        open: `<tool_result tool_use_id="${item.call_id}"${item.is_error === true ? ' is_error="true"' : ""}>`,
        close: "</tool_result>",
      });
    }
  }
  return turns;
}

function renderTurns(turns: readonly Turn[], cap: number): string[] {
  return turns.map((turn) => {
    const body = turn.parts.map((part) => {
      const text = escapeMarkup(part.clippable ? clip(part.text, cap) : part.text);
      return part.open ? `${part.open}${text}${part.close ?? ""}` : text;
    }).join("");
    return `<turn role="${turn.role}">${body}</turn>`;
  });
}

/** 이력을 예산 안에 넣는다: 오래된 것부터가 아니라 *도구 결과 본문*부터 줄이고, 그래도 넘으면 가장 오래된 턴을 뺀다. */
function fitHistory(turns: readonly Turn[], budgetChars: number): { readonly lines: string[]; readonly omitted: number } {
  for (const cap of TRUNCATION_CAPS) {
    const lines = renderTurns(turns, cap);
    if (lines.reduce((sum, line) => sum + line.length + 1, 0) <= budgetChars) return { lines, omitted: 0 };
  }
  const lines = renderTurns(turns, TRUNCATION_CAPS[TRUNCATION_CAPS.length - 1]!);
  let omitted = 0;
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  // 첫 턴(대화의 목적)은 남기고 그 다음 턴부터 뺀다.
  while (total > budgetChars && lines.length > 2) {
    total -= lines[1]!.length + 1;
    lines.splice(1, 1);
    omitted += 1;
  }
  if (omitted > 0) lines.splice(1, 0, `<turn role="user">[${omitted} earlier turns omitted]</turn>`);
  return { lines, omitted };
}

/** 마지막 assistant 항목 뒤의 user·도구 결과 꼬리의 시작 위치. */
function currentRunStart(items: readonly CanonicalInputItem[]): number {
  let start = items.length;
  while (start > 0) {
    const item = items[start - 1]!;
    const assistant = item.type === "function_call" || (item.type === "message" && item.role === "assistant");
    if (assistant) break;
    start -= 1;
  }
  return start;
}

/**
 * 새 세션의 첫 프롬프트. 이력이 없으면(첫 요청) 재주입 없이 user 텍스트만 보낸다.
 * 마지막 요청이 사용자 메시지면 그 텍스트를 이력 뒤에 그대로 붙이고, 도구 결과면 "이어서 진행하라"를 붙인다.
 */
export function replayBlocks(items: readonly CanonicalInputItem[], budgetChars: number): AcpPromptBlock[] {
  const start = currentRunStart(items);
  if (start === 0) return userTurnBlocks(items);
  const current = items.slice(start);
  const endsWithToolResults = current.some((item) => item.type === "function_call_output");
  // 현재 꼬리가 사용자 메시지뿐이면 이력에서 빼 마지막 질문으로 쓰고, 도구 결과가 있으면 이력에 넣고 이어가라고 한다.
  const historyItems = endsWithToolResults ? items : items.slice(0, start);
  const { lines } = fitHistory(toTurns(historyItems), budgetChars);
  const closing = endsWithToolResults
    ? CONTINUE_AFTER_TOOL_RESULTS
    : userTurnBlocks(current).filter((block) => block.kind === "text").map((block) => (block as { text: string }).text).join("\n\n");
  return [
    { kind: "text", text: `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${closing}` },
    ...imageBlocks(userContents(current)),
  ];
}
