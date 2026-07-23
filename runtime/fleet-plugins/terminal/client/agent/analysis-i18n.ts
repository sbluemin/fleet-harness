export type AnalysisLanguage = "en" | "ko";

const KOREAN_COPY = {
  "Walk me through how this session unfolded": "이 세션이 어떻게 진행됐는지 정리해 줘",
  "What is the agent doing right now?": "에이전트가 지금 무엇을 하고 있어?",
  "Flag anything I should review": "내가 검토해야 할 항목을 짚어 줘",
  "Draft a handoff brief": "인수인계 브리프 초안을 작성해 줘",
  "Draft a handoff brief and publish it as an artifact.": "인수인계 브리프 초안을 작성하고 아티팩트로 발행해 줘.",
  "Flag anything I should review before this work continues.": "이 작업을 계속하기 전에 내가 검토해야 할 항목을 짚어 줘.",
  "Walk me through how this session unfolded.": "이 세션이 어떻게 진행됐는지 정리해 줘",
  "Go deeper on the last answer": "이전 답변 더 깊게 파기",
  "Go deeper on your previous answer with more evidence citations.": "이전 답변을 근거 인용을 늘려 더 깊게 분석해 줘.",
  "Check for intent drift": "의도 드리프트 점검",
  "Review this session for intent drift against my stated goals.": "내가 정한 목표와 비교해 이 세션의 의도 드리프트를 검토해 줘.",
  "Turn this into an artifact": "아티팩트로 만들기",
  "Turn your previous answer into a published artifact.": "이전 답변을 아티팩트로 발행해 줘.",
  "What is the agent doing now?": "에이전트 현재 상태",
  "Current state — what the agent is doing right now": "현재 상태 — 에이전트가 지금 하고 있는 일",
  "Intent drift review against settled goals": "확정된 목표 대비 의도 드리프트 검토",
  "Handoff brief as an artifact": "아티팩트로 남기는 인수인계 브리프",
  "Flag anything that needs review": "검토가 필요한 항목 표시",
  "How the session unfolded, end to end": "세션 진행 경과 전체 타임라인",
  "Session Analyst chat": "Session Analyst 채팅",
  "Hide Artifacts": "아티팩트 닫기",
  "Open Artifacts": "아티팩트 열기",
  "The analyst is authoring an artifact…": "분석가가 아티팩트를 작성하는 중…",
  "Artifacts the analyst publishes appear here": "분석가가 발행한 아티팩트가 여기에 표시됩니다",
  "ARTIFACTS": "아티팩트",
  "Session Analyst": "Session Analyst",
  "Read-only intelligence for this operation": "이 오퍼레이션의 읽기 전용 인텔리전스",
  "Reset": "초기화",
  "Reset Session Analyst": "Session Analyst 초기화",
  "Ask about this session": "이 세션에 대해 물어보세요",
  "Review, explain, and summarize this session — without affecting the host agent.": "호스트 에이전트에 영향을 주지 않고 세션을 검토·설명·요약합니다.",
  "Publishing an artifact": "아티팩트 발행 중",
  "The analyst is authoring artifact content. It opens in Artifacts when it lands.": "분석가가 아티팩트 내용을 작성하고 있습니다. 완료되면 아티팩트에서 열립니다.",
  "Artifact published — {title}": "아티팩트 발행됨 — {title}",
  "Open in Artifacts": "아티팩트에서 열기",
  "Stopped · last confirmed: {activity} · {elapsed}": "중지됨 · 마지막 확인: {activity} · {elapsed}",
  "Last confirmed activity only": "마지막으로 확인된 활동만 표시",
  "Starting analyst": "분석가 시작 중",
  "Analyst connection confirmed": "분석가 연결 확인됨",
  "Starting a new analysis session": "새 분석 세션 시작 중",
  "Reasoning over session": "세션 분석 추론 중",
  "Thought event received · content hidden": "사고 이벤트 수신 · 내용 숨김",
  "Using {title}": "{title} 사용 중",
  "Tool status: {status}": "도구 상태: {status}",
  "Writing answer": "답변 작성 중",
  "Answer chunk received": "답변 청크 수신",
  "Needs attention": "확인 필요",
  "Analyzing": "분석 중",
  "Complete": "완료",
  "Stopped": "중지됨",
  "Ready": "준비됨",
  "QUEUED": "대기 중",
  "Cancel queued question {index + 1}": "대기 중인 질문 {index + 1} 취소",
  "FOLLOW UP": "후속 질문",
  "Analysis commands": "분석 명령",
  "Initial analysis settings": "초기 분석 설정",
  "Analysis CLI": "분석 CLI",
  "Analysis model": "분석 모델",
  "Analysis effort": "분석 Effort",
  "n/a": "n/a",
  "Ask about the session… (/ for commands)": "세션에 대해 질문하기… (/ 명령)",
  "Stop": "중지",
  "Queue question": "질문 대기열 추가",
  "Send": "보내기",
  "Enter queues the question — it fires when the analyst is ready": "Enter로 질문을 대기시킵니다 — 분석가가 준비되면 실행됩니다",
  "Copied": "복사됨",
  "Artifacts": "아티팩트",
  "Visual outputs from this analysis": "이 분석의 시각적 결과물",
  "Hide artifacts ({count} {item/items})": "아티팩트 닫기({count}개)",
  "Show artifacts ({count} {item/items})": "아티팩트 보기({count}개)",
  "Published artifacts": "발행된 아티팩트",
  "Clear": "지우기",
  "No artifacts yet": "아직 아티팩트 없음",
  "Artifacts the analyst publishes will appear here.": "분석가가 발행한 아티팩트가 여기에 표시됩니다.",
  "Selected artifact preview": "선택한 아티팩트 미리보기",
  "Unknown time": "시간 알 수 없음",
  "Exit Session Analyst": "Session Analyst 닫기",
  "Open Session Analyst": "Session Analyst 열기",
  "Send a message in this session first": "먼저 이 세션에서 메시지를 보내세요",
  "EXIT": "닫기",
  "ANALYZE": "분석",
  "Analysis response timed out.": "분석 응답 시간이 초과됐습니다.",
  "Analysis session ended — send again to restart.": "분석 세션이 종료됐습니다 — 다시 보내면 재시작합니다.",
  "Stop failed: {message}": "중지 실패: {message}",
  "Reset failed: {message}": "초기화 실패: {message}",
  "Analysis is unavailable.": "분석을 사용할 수 없습니다.",
  "Saved": "저장됨",
} as const;

export type AnalysisCopyKey = keyof typeof KOREAN_COPY;

const ENGLISH_COPY = Object.fromEntries(
  Object.keys(KOREAN_COPY).map((key) => [key, key]),
) as Record<AnalysisCopyKey, string>;

export const ANALYSIS_COPY: Readonly<Record<AnalysisLanguage, Readonly<Record<AnalysisCopyKey, string>>>> = {
  en: ENGLISH_COPY,
  ko: KOREAN_COPY,
};

export function analysisCopy(
  language: AnalysisLanguage,
  key: AnalysisCopyKey,
  placeholders: Readonly<Record<string, string | number>> = {},
): string {
  return ANALYSIS_COPY[language][key].replace(/{([^{}]+)}/g, (match, placeholder: string) => (
    Object.hasOwn(placeholders, placeholder) ? String(placeholders[placeholder]) : match
  ));
}

export function translateAnalysisText(language: AnalysisLanguage, message: string): string {
  if (message.startsWith("Stop failed: ")) {
    return analysisCopy(language, "Stop failed: {message}", { message: message.slice("Stop failed: ".length) });
  }
  if (message.startsWith("Reset failed: ")) {
    return analysisCopy(language, "Reset failed: {message}", { message: message.slice("Reset failed: ".length) });
  }
  if (Object.hasOwn(KOREAN_COPY, message)) return analysisCopy(language, message as AnalysisCopyKey);
  return message;
}
