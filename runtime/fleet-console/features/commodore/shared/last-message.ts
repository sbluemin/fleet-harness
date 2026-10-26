import type { CommodoreLastMessage } from "./contracts/theaters.js";
import type { CommodoreTranscriptEntry } from "./contracts/types.js";

/** 미리보기 한 줄의 상한 — 행이 말줄임으로 자르므로 넉넉하면 된다. */
const PREVIEW_CHARS = 160;

/**
 * 기록 한 줄이 대화의 마지막 말이 되는가 — 사람의 메시지(`message`)와 사령관의 답(`text`)만 그렇다.
 * 도구·깨움·세션 같은 운영 줄은 미리보기가 되지 않는다. 코드 울타리(OpenUI 블록 포함)는 빼고 공백을 한 칸으로 접는다.
 */
export function commodoreLastMessage(entry: CommodoreTranscriptEntry): CommodoreLastMessage | null {
  if (entry.kind !== "message" && entry.kind !== "text") return null;
  const text = entry.text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
  if (!text) return null;
  return { at: entry.at, text, from: entry.kind === "message" ? "person" : "commodore" };
}
