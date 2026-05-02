const TOOL_LABEL_CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;
const TOOL_LABEL_ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function sanitizeChunk(text: string): string {
  return text
    .replace(/\r/g, "")
    // CSI 시퀀스 제거
    .replace(/\x1b\[\d*[ABCDEFGHJKST]/g, "")
    .replace(/\x1b\[\d*;\d*[Hf]/g, "")
    .replace(/\x1b\[(?:\??\d+[hl]|2J|K)/g, "")
    // OSC 시퀀스 제거
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // DCS/APC/PM 시퀀스 제거
    .replace(/\x1b[P_^][\s\S]*?\x1b\\/g, "")
    // 제어 문자 제거
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function sanitizeToolBlockLabel(value: string): string {
  return value
    .replace(TOOL_LABEL_ANSI_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\n\r]/g, "↵")
    .replace(TOOL_LABEL_CONTROL_CHARS, "");
}

export function sanitizeToolLabel(text: string): string {
  return sanitizeToolBlockLabel(sanitizeChunk(text)).replace(/\s+/g, " ").trim() || "(unnamed)";
}
