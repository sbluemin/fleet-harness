import type { Objective, ObjectiveMember } from "./types.js";

/**
 * 구성원 하나의 라우팅 판단에 건넬 프롬프트.
 *
 * Gateway 는 목표를 모른다 — 이 문자열이 그 구성원의 일 전부다. 구역은 고정 순서이고, 비어 있는 선택 구역은 뺀다.
 * 전체는 {@link MEMBER_ROUTING_PROMPT_MAX} 자를 넘지 않으며, 넘는 부분은 맨 끝의 목표 노트만 자른다.
 */

/** `routing-assign` 항목 prompt 상한과 같다. */
export const MEMBER_ROUTING_PROMPT_MAX = 16_384;
/** `routing-assign` 한 요청의 항목 수·prompt 합계 상한과 같다. */
export const ROUTING_ASSIGN_MAX_ITEMS = 20;
export const ROUTING_ASSIGN_MAX_PROMPT_SUM = 131_072;

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/** UTF-16 코드 단위로 자른다. 서로게이트 쌍 한가운데서는 한 단위 앞에서 멈춘다. */
const clip = (value: string, max: number): string => {
  if (max <= 0 || value.length === 0) return "";
  if (value.length <= max) return value;
  const split = value.charCodeAt(max - 1);
  const end = split >= 0xd800 && split <= 0xdbff ? max - 1 : max;
  return end > 0 ? value.slice(0, end) : "";
};

export function memberRoutingPrompt(objective: Objective, member: ObjectiveMember, max: number = MEMBER_ROUTING_PROMPT_MAX): string {
  const limit = Math.min(max, MEMBER_ROUTING_PROMPT_MAX);
  const sections = [`Objective: ${oneLine(objective.title)}`, `Role: ${oneLine(member.role)}`];
  const brief = member.brief ? oneLine(member.brief) : "";
  if (brief) sections.push(`Brief: ${brief}`);
  // 지휘관의 모델 제안은 참고 정보다 — 모델은 판단이 정한다.
  if (member.proposal) sections.push(`Commander's proposed model: ${oneLine(member.proposal.model)}${member.proposal.effort ? ` (effort ${oneLine(member.proposal.effort)})` : ""}`);
  const missions = objective.missions
    .filter((mission) => !mission.done && mission.member === member.id)
    .map((mission) => oneLine(mission.text))
    .filter((text) => text.length > 0);
  if (missions.length > 0) sections.push(`Assigned missions:\n${missions.join("\n")}`);
  const criteria = objective.criteria.map((criterion) => oneLine(criterion.text)).filter((text) => text.length > 0);
  if (criteria.length > 0) sections.push(`Success criteria:\n${criteria.join("\n")}`);

  const head = sections.join("\n\n");
  const note = objective.note.trim();
  // 노트를 뺀 앞부분만으로 상한을 넘는 드문 경우도 요청이 거절되지 않도록 끝을 자른다.
  if (!note || head.length >= limit) return clip(head, limit);
  const gap = "\n\n";
  const label = "Objective note:\n";
  const room = limit - head.length - gap.length - label.length;
  const body = clip(note, room);
  return body ? `${head}${gap}${label}${body}` : head;
}
