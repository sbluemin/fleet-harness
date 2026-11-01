/**
 * 사령관 전용 도구 Shell의 키 — (사령관, Theater)마다 하나씩 산다.
 *
 * 대화 키(`session:commodore:commodore:…`)는 대화를 옮기면 바뀌므로 Theater별 세션을
 * 가리킬 수 없다. 도구 Shell 키는 주인·Theater를 그대로 싣는다 — 서버는 불투명 문자열로만
 * 다루고, 입장 허가(`canUseShellKey`)가 앞부분을 읽어 쓰기 가능한 사령관인지 본다.
 * 런타임 의존성이 없으므로 호스트·클라이언트·테스트가 함께 쓴다.
 */

const TOOL_SHELL_PREFIX = "tool-shell:commodore:";
const THEATER_SEGMENT = ":theater:";

/** 도구 Shell 키를 짓는다. id에 제어 문자가 섞이면 null — 서버의 키 검사가 막는다. */
export function toolShellKey(commodoreId: string, theaterId: string): string | null {
  if (!commodoreId || !theaterId) return null;
  if (/[\u0000-\u001f]/.test(commodoreId) || /[\u0000-\u001f]/.test(theaterId)) return null;
  const key = `${TOOL_SHELL_PREFIX}${commodoreId}${THEATER_SEGMENT}${theaterId}`;
  return key.length <= 320 ? key : null;
}

/** 도구 Shell 키면 주인·Theater를 돌려준다. 아니면 null. */
export function parseToolShellKey(key: string): { readonly commodoreId: string; readonly theaterId: string } | null {
  if (!key.startsWith(TOOL_SHELL_PREFIX)) return null;
  const rest = key.slice(TOOL_SHELL_PREFIX.length);
  const at = rest.indexOf(THEATER_SEGMENT);
  if (at < 0) return null;
  const commodoreId = rest.slice(0, at);
  const theaterId = rest.slice(at + THEATER_SEGMENT.length);
  if (!commodoreId || !theaterId) return null;
  return { commodoreId, theaterId };
}
