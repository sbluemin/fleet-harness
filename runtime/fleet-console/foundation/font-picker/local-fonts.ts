import { normalizeSystemFonts, type SystemFontFace } from "./classify.js";
import { quoteFontFamily } from "./resolve.js";
import type { SystemFontRecord } from "./system-fonts.js";

/**
 * 이 화면을 그리는 기기의 서체 목록(Local Font Access API). 호스트 목록은 Console이 도는 기기의
 * 것이라, 둘이 다른 기기면 렌더러만 무엇을 그릴 수 있는지 안다.
 *
 * 이 목록은 핑거프린팅 표면이다. 여기서 돌려준 값은 호출자의 메모리에만 머물러야 한다 — 서버로
 * 보내거나, 설정·브라우저 저장소에 남기거나, 로그에 쓰지 않는다. 이 모듈도 아무것도 기억하지 않는다.
 */
export type LocalFontsPermission = "granted" | "prompt" | "denied" | "unknown";

export type LocalFontsResult =
  | { readonly status: "loaded"; readonly fonts: readonly SystemFontRecord[] }
  | { readonly status: "denied" }
  | { readonly status: "failed" };

export interface LocalFontsOptions {
  readonly window?: Window;
}

interface LocalFontData {
  readonly family: string;
  readonly style: string;
}

type LocalFontsWindow = Window & { queryLocalFonts?: () => Promise<readonly LocalFontData[]> };

const MONOSPACE_PROBE_NARROW = "iiiiiiiiii";
const MONOSPACE_PROBE_WIDE = "MMMMMMMMMM";
const MONOSPACE_THRESHOLD_PX = 0.5;

export function localFontsSupported(options: LocalFontsOptions = {}): boolean {
  return typeof localFontsWindow(options)?.queryLocalFonts === "function";
}

export async function localFontsPermission(options: LocalFontsOptions = {}): Promise<LocalFontsPermission> {
  const permissions = localFontsWindow(options)?.navigator.permissions;
  if (!permissions) return "unknown";
  try {
    // 이 권한 이름은 아직 DOM 타입에 없다. 모르는 브라우저는 TypeError로 답한다.
    return (await permissions.query({ name: "local-fonts" as PermissionName })).state;
  } catch {
    return "unknown";
  }
}

/** 사용자 제스처 안에서 부른다. 권한이 거부돼 있으면 열거를 시도하지 않는다. */
export async function queryLocalFontFamilies(options: LocalFontsOptions = {}): Promise<LocalFontsResult> {
  const target = localFontsWindow(options);
  if (typeof target?.queryLocalFonts !== "function") return { status: "failed" };
  if (await localFontsPermission(options) === "denied") return { status: "denied" };
  let fonts: readonly LocalFontData[];
  try {
    fonts = await target.queryLocalFonts();
  } catch {
    // Edge는 보이지 않는 페이지에 SecurityError, 거절에는 NotAllowedError를 던진다.
    return await afterRefusal(options);
  }
  // 로컬 서체가 하나도 없는 OS는 없다. 빈 목록은 권한이 없다는 조용한 답이다(Chrome 미허용, Desktop 정책 거부).
  if (fonts.length === 0) return await afterRefusal(options);
  const records = normalizeSystemFonts(toFaces(fonts, target.document));
  return records.length ? { status: "loaded", fonts: records } : { status: "failed" };
}

async function afterRefusal(options: LocalFontsOptions): Promise<LocalFontsResult> {
  return await localFontsPermission(options) === "denied" ? { status: "denied" } : { status: "failed" };
}

function toFaces(fonts: readonly LocalFontData[], documentRef: Document): readonly SystemFontFace[] {
  const context = documentRef.createElement("canvas").getContext("2d");
  const monospaceByFamily = new Map<string, boolean>();
  return fonts.flatMap((font) => {
    if (typeof font.family !== "string" || typeof font.style !== "string") return [];
    let monospace = monospaceByFamily.get(font.family);
    if (monospace === undefined) {
      monospace = context ? measuresMonospace(context, font.family) : false;
      monospaceByFamily.set(font.family, monospace);
    }
    return [{ familyName: font.family, style: font.style, monospace }];
  });
}

/* 등폭 판정은 family마다 좁은 글자와 넓은 글자의 폭을 견준다. face마다 post 테이블을 읽는 길
   (FontData.blob)은 수백 face를 통째로 읽어야 한다. 폴백을 serif로 두는 까닭은 라틴이 없는 서체가
   폴백의 폭으로 "등폭"이 되지 않게 하기 위해서다. */
function measuresMonospace(context: CanvasRenderingContext2D, family: string): boolean {
  context.font = `20px ${quoteFontFamily(family)}, serif`;
  return Math.abs(context.measureText(MONOSPACE_PROBE_NARROW).width - context.measureText(MONOSPACE_PROBE_WIDE).width) < MONOSPACE_THRESHOLD_PX;
}

function localFontsWindow(options: LocalFontsOptions): LocalFontsWindow | undefined {
  return (options.window ?? (typeof window === "undefined" ? undefined : window)) as LocalFontsWindow | undefined;
}
