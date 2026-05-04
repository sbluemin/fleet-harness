import { Type } from "@sinclair/typebox";

import type { ToolPromptManifest } from "../../infra/tool-registry/index.js";

import type { DirectiveOption, DirectiveQuestion } from "./types.js";

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
