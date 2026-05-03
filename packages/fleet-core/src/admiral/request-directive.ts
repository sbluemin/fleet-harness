/**
 * request_directive — pure manifest and parameter schema.
 */

import { Type } from "@sinclair/typebox";

import type { ToolPromptManifest } from "../infra/tool-registry/index.js";

export interface DirectiveOption {
  label: string;
  description: string;
  preview?: string;
}

export interface DirectiveQuestion {
  question: string;
  header: string;
  options: DirectiveOption[];
  multiSelect?: boolean;
}

export interface DirectiveAnswer {
  question: string;
  header: string;
  values: string[];
  wasCustom: boolean;
}

export interface DirectiveResult {
  questions: DirectiveQuestion[];
  answers: DirectiveAnswer[];
  cancelled: boolean;
}

export type RenderOption = DirectiveOption & { isOther?: boolean; selected?: boolean };

export const HEADER_MAX_LENGTH = 12;

export const DirectiveOptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    description: "선택지 표시 텍스트. 간결하게 1-5단어.",
  }),
  description: Type.String({
    minLength: 1,
    description: "선택지 설명. 트레이드오프나 영향을 설명.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "포커스 시 하단에 표시되는 프리뷰 텍스트. ASCII 목업, 코드 스니펫, 설정 예시 등에 사용. 단일 선택 질문에서만 지원.",
    }),
  ),
});

export const DirectiveQuestionSchema = Type.Object({
  question: Type.String({
    minLength: 1,
    description:
      'Admiral of the Navy (대원수)에게 제시할 질문. 명확하고 구체적으로, 물음표로 끝낼 것. 예: "어떤 인증 방식을 사용할까요?"',
  }),
  header: Type.String({
    minLength: 1,
    maxLength: HEADER_MAX_LENGTH,
    description: `탭 바에 표시되는 짧은 라벨 (최대 ${HEADER_MAX_LENGTH}자). 예: "인증 방식", "Library", "Scope"`,
  }),
  options: Type.Array(DirectiveOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "선택지 목록 (2-4개). 각각 명확히 구별되는 선택이어야 함. 'Other' 옵션은 자동 제공되므로 포함하지 말 것.",
  }),
  multiSelect: Type.Optional(Type.Boolean({
    default: false,
    description: "복수 선택 허용 여부. 상호 배타적이지 않은 선택지에 사용.",
  })),
});

export const RequestDirectiveParams = Type.Object({
  questions: Type.Array(DirectiveQuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "Admiral of the Navy (대원수)에게 요청할 질문 목록 (1-4개)",
  }),
});

export const REQUEST_DIRECTIVE_MANIFEST: ToolPromptManifest = {
  id: "request_directive",
  tag: "request_directive",
  title: "request_directive Tool Guidelines",
  description:
    "Use `request_directive` when you need the Admiral of the Navy (대원수)'s judgment to proceed. This tool is for **strategic decisions**, not routine confirmations.",
  promptSnippet:
    "request_directive — Ask the Admiral of the Navy (대원수) for strategic directives when judgment is required.",
  whenToUse: [
    "1. **Ambiguity resolution** — The Admiral of the Navy (대원수)'s orders contain unclear or conflicting requirements.",
    "2. **Direction selection** — Multiple viable approaches exist, each with meaningful trade-offs.",
    "3. **Scope confirmation** — The mission scope needs clarification before committing resources.",
    "4. **Preference gathering** — Implementation details that depend on the Admiral of the Navy (대원수)'s priorities.",
  ],
  whenNotToUse: [
    'Routine status confirmations ("Should I proceed?", "Is this okay?").',
    "Questions you can answer by reading code or documentation.",
    "Asking for approval on something you've already decided — just do it.",
    "Rephrasing your analysis as a question to appear thorough.",
  ],
  usageGuidelines: [
    `Users will always see an "직접 입력" (type your own) option — do not include an "Other" choice in your options.`,
    `Use \`multiSelect: true\` when choices are not mutually exclusive.`,
    "Question texts must be unique, and option labels must be unique within each question.",
    `If \`multiSelect\` is true, do not attach \`preview\` fields to its options.`,
    `If you recommend a specific option, make it the first in the list and append "(Recommended)" to its label.`,
    "Keep headers concise (max 12 chars) — they appear as tab labels.",
    `Use the optional \`preview\` field when presenting concrete artifacts that the Admiral of the Navy (대원수) needs to visually compare (ASCII mockups, code snippets, config examples). Previews are only supported for single-select questions.`,
  ],
  guardrails: [
    `In plan mode, use \`request_directive\` to clarify requirements or choose between approaches **before** finalizing a plan. Do **not** use it to ask "Is the plan ready?" or "Should I execute?" — that is what plan approval is for.`,
  ],
};

export function errorResult(
  message: string,
  questions: DirectiveQuestion[] = [],
): { content: { type: "text"; text: string }[]; details: DirectiveResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export function clampHeader(header: string): string {
  if (header.length <= HEADER_MAX_LENGTH) return header;
  return header.slice(0, HEADER_MAX_LENGTH - 1) + "…";
}

export function hasPreview(q: DirectiveQuestion): boolean {
  return !q.multiSelect && q.options.some((o) => o.preview);
}

export function validateQuestions(questions: DirectiveQuestion[]): string | null {
  const seenQuestions = new Set<string>();

  for (const q of questions) {
    const normalizedQuestion = q.question.trim();
    if (!normalizedQuestion) {
      return "Error: 빈 질문은 허용되지 않습니다";
    }

    if (seenQuestions.has(normalizedQuestion)) {
      return `Error: 중복 질문이 있습니다: "${normalizedQuestion}"`;
    }
    seenQuestions.add(normalizedQuestion);

    const normalizedHeader = q.header.trim();
    if (!normalizedHeader) {
      return "Error: 빈 header는 허용되지 않습니다";
    }

    if (q.options.length < 2 || q.options.length > 4) {
      return `Error: "${normalizedHeader}" 질문의 선택지는 2-4개여야 합니다`;
    }

    const seenLabels = new Set<string>();
    for (const option of q.options) {
      const normalizedLabel = option.label.trim();
      if (!normalizedLabel) {
        return `Error: "${normalizedHeader}" 질문에 빈 선택지 라벨이 있습니다`;
      }
      if (seenLabels.has(normalizedLabel)) {
        return `Error: "${normalizedHeader}" 질문에 중복 선택지 라벨이 있습니다: "${normalizedLabel}"`;
      }
      seenLabels.add(normalizedLabel);
    }

    if (q.multiSelect && q.options.some((option) => option.preview)) {
      return `Error: "${normalizedHeader}" 질문은 multiSelect=true 이므로 preview를 사용할 수 없습니다`;
    }
  }

  return null;
}
