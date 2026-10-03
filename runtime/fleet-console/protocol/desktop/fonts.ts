export interface DesktopFontAxis {
  readonly family: string;
  readonly size: number;
}
/** Console에서 해석한 공개 표현 값만 전달한다. 셸은 설정 파일이나 새 모델을 읽지 않는다. */
export interface DesktopEntryFonts {
  readonly ui: DesktopFontAxis;
  readonly content: DesktopFontAxis;
  readonly code: DesktopFontAxis;
}
export function readDesktopEntryFonts(value: unknown): DesktopEntryFonts | null {
  if (!record(value)) return null;
  const read = (axis: string, min: number, max: number): DesktopFontAxis | null => {
    const candidate = value[axis];
    if (!record(candidate) || typeof candidate.family !== "string" || !candidate.family || candidate.family.length > 1024
      || !/^(?:"(?:[^"\\<>\u0000-\u001f\u007f]|\\(?:["\\]|3[ce] ))+"|-?[A-Za-z][A-Za-z-]*)(?:,\s*(?:"(?:[^"\\<>\u0000-\u001f\u007f]|\\(?:["\\]|3[ce] ))+"|-?[A-Za-z][A-Za-z-]*))*$/u.test(candidate.family)
      || typeof candidate.size !== "number" || !Number.isInteger(candidate.size) || candidate.size < min || candidate.size > max) return null;
    return { family: candidate.family, size: candidate.size };
  };
  const ui = read("ui", 12, 18);
  const content = read("content", 12, 20);
  const code = read("code", 10, 22);
  return ui && content && code ? { ui, content, code } : null;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
