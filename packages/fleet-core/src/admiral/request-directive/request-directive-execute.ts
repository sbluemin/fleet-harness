import type { DirectiveAnswer, DirectiveQuestion, DirectiveResult } from "./types.js";

import { HEADER_MAX_LENGTH } from "./prompts.js";

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

export function formatAnswerResult(answers: DirectiveAnswer[]): string {
  return answers.map((a) => {
    if (a.wasCustom) {
      return `${a.header}: Admiral of the Navy (대원수)'s directive: ${a.values[0]}`;
    }
    const valStr = a.values.join(", ");
    return `${a.header}: Admiral of the Navy (대원수) selected: ${valStr}`;
  }).join("\n");
}
