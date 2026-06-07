const TOML_BASIC_STRING_ESCAPE_PATTERN = /[\u0000-\u001f"\\\u007f]/g;

// 멀티라인 basic string에서는 LF(\n)와 탭(\t)만 리터럴로 보존하고, 그 외 제어문자와
// DEL은 \uXXXX 형태로 이스케이프한다. CR(\r)은 보존하면 bare CR이 표준 TOML parse를
// 깨뜨리고 CRLF가 LF로 정규화되어 원문 round-trip이 어긋나므로 이스케이프 대상에 포함한다.
const TOML_MULTILINE_CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "g");
const TOML_MULTILINE_QUOTE_RUN_PATTERN = /"+/g;

export function escapeTomlBasicString(value: string): string {
  return value.replace(TOML_BASIC_STRING_ESCAPE_PATTERN, (char) => {
    switch (char) {
      case "\b":
        return "\\b";
      case "\t":
        return "\\t";
      case "\n":
        return "\\n";
      case "\f":
        return "\\f";
      case "\r":
        return "\\r";
      case "\"":
        return "\\\"";
      case "\\":
        return "\\\\";
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

// TOML 멀티라인 basic string("""...""") 본문용 이스케이프.
// 줄바꿈을 리터럴로 보존해 doctrine을 사람이 읽기 좋게(pretty) 직렬화한다.
export function escapeTomlMultilineString(value: string): string {
  // 1) 백슬래시를 먼저 이스케이프해 이후 변환과 충돌하지 않도록 한다.
  let result = value.replace(/\\/g, "\\\\");
  // 2) 줄바꿈/탭을 제외한 제어문자와 DEL은 \uXXXX로 이스케이프한다.
  result = result.replace(
    TOML_MULTILINE_CONTROL_PATTERN,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  // 3) 따옴표 처리: 3개 이상 연속되면 종료 구분자(""")와 충돌하고,
  //    문자열 맨 끝의 따옴표는 닫는 """ 앞에서 모호해지므로 그 경우만 이스케이프한다.
  //    중간의 1~2개 연속 따옴표는 안전하므로 그대로 둔다.
  result = result.replace(TOML_MULTILINE_QUOTE_RUN_PATTERN, (run: string, offset: number) => {
    const isTrailingRun = offset + run.length === result.length;
    if (run.length >= 3 || isTrailingRun) {
      return run.replace(/"/g, "\\\"");
    }
    return run;
  });
  return result;
}
