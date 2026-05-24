/**
 * protocols/index — Admiral Protocol 표면
 *
 * Fleet Action Protocol은 fleet-harness의 유일·불변 운영 프로토콜이다.
 * 카탈로그·스위칭·레지스트리 추상화는 존재하지 않으며, 본 파일은 단일
 * 프로토콜 본문과 부수 상수를 단순 re-export 한다.
 */

export {
  FLEET_ACTION_LABEL,
  FLEET_ACTION_COLOR,
  FLEET_ACTION_PROMPT,
} from "./fleet-action.js";
