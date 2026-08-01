/**
 * Conservative token estimate for providers that do not always report usage.
 */

const DEFAULT_CHARS_PER_TOKEN = 4;
const CODE_MODEL_CHARS_PER_TOKEN = 3.5;
const CJK_CHARS_PER_TOKEN = 2.5;
const CJK_RATIO_THRESHOLD = 0.3;
const CODE_MODEL_PREFIXES = ["kiro", "claude", "deepseek", "minimax", "glm", "qwen"];
const CJK_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF]/;

export function estimateTokens(text: string, modelId?: string): number {
  if (text.length === 0) return 0;
  let charsPerToken = modelCharsPerToken(modelId);
  if (cjkRatio(text) > CJK_RATIO_THRESHOLD) {
    charsPerToken = Math.min(charsPerToken, CJK_CHARS_PER_TOKEN);
  }
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

function modelCharsPerToken(modelId: string | undefined): number {
  const normalized = modelId?.toLowerCase();
  return normalized && CODE_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? CODE_MODEL_CHARS_PER_TOKEN
    : DEFAULT_CHARS_PER_TOKEN;
}

function cjkRatio(text: string): number {
  const stride = text.length > 2_048 ? Math.ceil(text.length / 2_048) : 1;
  let cjk = 0;
  let sampled = 0;
  for (let index = 0; index < text.length; index += stride) {
    sampled += 1;
    if (CJK_RE.test(text[index] ?? "")) cjk += 1;
  }
  return sampled === 0 ? 0 : cjk / sampled;
}
