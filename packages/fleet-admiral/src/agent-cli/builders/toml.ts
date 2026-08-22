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

function buildPosixShellCommand(values: readonly string[]): string {
  return values.map(posixShellQuote).join(" ");
}

export function buildHostShellCommand(values: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return values.map(windowsShellQuote).join(" ");
  return buildPosixShellCommand(values);
}

export function buildPowerShellCommand(values: readonly string[]): string {
  return `& ${values.map(powerShellQuote).join(" ")}`;
}

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsShellQuote(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
