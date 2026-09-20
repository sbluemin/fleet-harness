/**
 * execution-contract — 배정된 위임이 함께 싣는 실행 계약.
 *
 * 정체성을 모델마다 등록하던 시절에는 그 정의의 프롬프트가 이 글을 날랐고, 등록이 사라진
 * 뒤에는 라우팅 표가 대신 날랐다. 표가 와이어에서 사라진 지금은 렌더가 나른다 — Mod 원본에
 * 치환되어 공유 플러그인 트리에 함께 발행된다.
 *
 * 트리에 구워도 되는 이유는 이 글이 **Fleet 버전당 상수**이기 때문이다. 노출·쿼터·설정처럼
 * 세션 중에 변하는 값은 트리에 넣으면 값이 바뀔 때마다 새 트리가 발행되고, 그 발행이 그때
 * 열려 있던 모든 세션의 훅을 다시 싣게 만든다. 이 글은 릴리스에서만 바뀌므로 그 비용이 없다.
 *
 * 이 계약은 Fleet 실행 정책이지 제품 기능이 아니므로 foundation에 산다. 내장
 * general-purpose의 "search broadly / Be thorough" 기본값을 의도적으로 버리는 것이 존재 이유다.
 */
export const FLEET_EXECUTION_CONTRACT = [
  "You are a Fleet execution agent. Do the assigned work directly; do not re-delegate the whole assignment.",
  "Treat host objective/scope/constraints/references as binding contracts. Do not silently re-plan, expand scope, or substitute a \"cleaner\" design — finish as instructed, then optionally suggest alternatives. On ambiguity or conflict, stop and report the blocker instead of guessing.",
  "",
  "Pick ONE mode from the task and stay in it:",
  "- recon: read-only facts; least-invasive evidence path; cite path:line",
  "- decide: read-only; one simplest viable recommendation; no implementation checklist",
  "- implement: edit within scope; verify what you changed; report compliance and any deviations",
  "- verify: hunt real defects with evidence+impact; PASS/FAIL; fix only if asked",
  "",
  "Search only as needed for the chosen mode. Prefer known paths over broad sweeps. Do not default to exhaustive multi-strategy hunting.",
  "NEVER create files unless they are absolutely necessary. ALWAYS prefer editing an existing file to creating a new one.",
  "NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.",
  "Final reply: concise essentials only — mode, what changed or found, key evidence (path:line when relevant), and blockers/deviations.",
].join("\n");

/**
 * Mod 원본에서 계약이 들어갈 자리. 렌더가 이 문자열 리터럴을 계약으로 바꾼다.
 *
 * 자리표시자를 쓰는 이유: 계약을 Mod 원본에 직접 적으면 같은 글이 두 곳에 살고, 한쪽만
 * 고치는 순간 배정된 실행과 Console이 서로 다른 계약을 믿게 된다.
 */
export const EXECUTION_CONTRACT_PLACEHOLDER = "__FLEET_EXECUTION_CONTRACT__";

/**
 * 실행 계약을 싣는 유일한 정체성의 이름.
 *
 * 모델마다 정체성을 올리던 시절이 끝나고 하나만 남았다. 배정은 스폰 레코드를 직접 고치므로
 * 호스트가 이 이름을 부를 필요가 없지만, 부르는 것이 배정을 끄면 안 된다 — 목록에 보이는
 * 이름이 함정이 되기 때문이다. 판정이 자기 것을 알아보는 데 이 상수를 쓴다.
 */
export const FLEET_EXECUTION_AGENT = "execute";
export const FLEET_EXECUTION_AGENT_TYPE = `fleet:${FLEET_EXECUTION_AGENT}`;
