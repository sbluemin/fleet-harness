const TOML_BASIC_STRING_ESCAPE_PATTERN = /[\u0000-\u001f"\\\u007f]/g;

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
