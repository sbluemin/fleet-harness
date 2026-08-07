// 런치 프롬프트는 PTY가 아니라 argv 위치 인자로 나간다. NUL과 제어문자는 인자 경계·로깅을
// 오염시키므로 제거하되, 줄바꿈과 탭은 프롬프트의 의미라 보존한다.
export function sanitizeLaunchPrompt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  // 길이 상한은 여기서 자르거나 던지지 않는다. MAX_LAUNCH_PROMPT_CHARS는 호스트 라우트가 강제하는 계약이다.
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  const trimmed = normalized.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
