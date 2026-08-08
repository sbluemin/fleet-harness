/**
 * `fleet://join?code=…`를 OS에서 받아 로컬 Console에 넘기기 위한 최소한의 배관.
 *
 * Desktop은 이 문자열을 해석하지 않는다 — 봉투를 열고 주소·지문·자격을 판정하는 일은 Console
 * 하나가 맡는다. 여기서 하는 일은 "이게 우리 스킴인가"를 가르고 그대로 전달하는 것뿐이다.
 * 그래서 argv에 섞여 들어온 잡다한 인자를 링크로 착각하지 않는 것이 이 파일의 유일한 책임이다.
 */
export const FLEET_PROTOCOL = "fleet";

const LINK_PREFIX = "fleet://";
const MAX_LINK_LENGTH = 4096;

export function isFleetProtocolLink(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LINK_LENGTH) return false;
  if (!value.toLowerCase().startsWith(LINK_PREFIX)) return false;
  // 공백과 제어문자가 섞인 값은 링크가 아니라 잘못 이어 붙은 인자다.
  return !/[\u0000-\u001f\u007f\s]/u.test(value);
}

/**
 * 실행 인자 중 링크 하나를 고른다. 여러 개가 오면 첫 번째만 쓴다 — 창은 하나뿐이고, 한 번의
 * 실행이 여러 콘솔을 여는 동선은 없다.
 */
export function findAccessLinkArgument(argv: readonly string[]): string | null {
  return argv.find((entry) => isFleetProtocolLink(entry)) ?? null;
}
