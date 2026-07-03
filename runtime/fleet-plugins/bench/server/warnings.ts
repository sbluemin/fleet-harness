export interface BenchWarning {
  readonly code: "editing_keyword";
  readonly term: string;
}

const EDITING_KEYWORD_RE = /\b(write|edit|modify|rewrite|create|delete|remove|replace|refactor|move|rename)\b/gi;

export function detectEditingKeywords(text: string): BenchWarning[] {
  const matches = text.match(EDITING_KEYWORD_RE);
  if (!matches) return [];
  const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
  return unique.map((term) => ({ code: "editing_keyword", term }));
}
