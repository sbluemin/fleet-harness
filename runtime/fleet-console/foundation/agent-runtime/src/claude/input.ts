import type { ClaudeGatewayInput } from "./contracts.js";

/** 사용자 입력만 받는다 — URL·파일 경로·vendor 객체는 이 경계를 넘지 않는다. */
export function assertClaudeGatewayInput(input: unknown): asserts input is ClaudeGatewayInput {
  if (typeof input === "string" && input.trim()) return;
  if (Array.isArray(input) && input.length > 0 && input.every((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string" && Object.keys(block).every((key) => key === "type" || key === "text");
    const source = block.source;
    return block.type === "image" && Object.keys(block).every((key) => key === "type" || key === "source")
      && source && source.type === "base64" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)
      && Object.keys(source).every((key) => ["type", "media_type", "data"].includes(key))
      && typeof source.data === "string" && source.data.length > 0 && source.data.length % 4 === 0
      && /^[A-Za-z0-9+/]+={0,2}$/.test(source.data);
  }) && input.some((block) => block.type === "image" || block.text.trim())) return;
  throw new TypeError("Message required: a non-empty string or text/base64 image blocks.");
}
