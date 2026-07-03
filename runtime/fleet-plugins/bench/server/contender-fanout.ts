import type { BenchContender, BenchRubricItem } from "./bench-store.js";

// durable-state의 VALID_GROUP_COLOR_KEYS 화이트리스트와 동일한 16색 named key만 허용된다 —
// hex 값은 라이브 생성은 통과하지만 재시작 sanitize에서 그룹이 제거된다.
const ACCENT_PALETTE = [
  "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo",
  "violet", "purple", "magenta", "rose",
] as const;

export interface FanoutResult {
  readonly groupId: string;
  readonly benchOpId: string;
  readonly participants: readonly BenchContender[];
}

export interface FanoutInput {
  readonly theaterId: string;
  readonly initialPrompt: string;
  readonly contenders: ReadonlyArray<{ readonly cliId: string }>;
  readonly rubric: readonly BenchRubricItem[];
  readonly serverPort: number;
}

export async function runContenderFanout(input: FanoutInput): Promise<FanoutResult> {
  const base = `http://127.0.0.1:${input.serverPort}`;
  const promptHash = simpleHash(input.initialPrompt);
  const accent = ACCENT_PALETTE[promptHash % ACCENT_PALETTE.length]!;
  const promptPreview = input.initialPrompt.slice(0, 8).replace(/\s+/g, " ").trim();

  // 1. group 생성
  const groupRes = await fetch(`${base}/api/v1/operations/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId: input.theaterId, name: `Bench: ${promptPreview}`, color: accent }),
  });
  if (!groupRes.ok) throw new Error(`group_create_failed:${groupRes.status}`);
  const groupData = (await groupRes.json()) as { group: { id: string } };
  const groupId = groupData.group.id;

  // 2. 참전자 순차 spawn + group 편입 (롤백 가능하도록 순차)
  const participants: BenchContender[] = [];
  for (const contender of input.contenders) {
    let opId: string;
    let sessionId: string | undefined;
    try {
      const sessionRes = await fetch(`${base}/plugins/terminal/agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: input.theaterId, cliId: contender.cliId, initialInput: input.initialPrompt }),
      });
      if (!sessionRes.ok) throw new Error(`session_create_failed:${sessionRes.status}`);
      const sessionData = (await sessionRes.json()) as { sessionId: string };
      opId = sessionData.sessionId;
      sessionId = sessionData.sessionId;
    } catch (err) {
      // 롤백: 이미 spawn된 참전자 op 삭제
      for (const p of participants) {
        await fetch(`${base}/plugins/terminal/agent/sessions/${p.opId}`, { method: "DELETE" }).catch(() => {});
      }
      await fetch(`${base}/api/v1/operations/groups/${groupId}`, { method: "DELETE" }).catch(() => {});
      throw err;
    }
    // 참전자 op group 편입
    await fetch(`${base}/api/v1/operations/${opId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    }).catch(() => {});
    participants.push({ cliId: contender.cliId, opId, sessionId });
  }

  // 3. bench Operation 생성 (groupId는 POST 지원 안 함 → 생성 후 PATCH)
  const benchOpRes = await fetch(`${base}/api/v1/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      theaterId: input.theaterId,
      type: "bench",
      pluginId: "bench",
      title: `Bench: ${promptPreview}`,
      payload: {
        rubric: input.rubric,
        groupId,
        participantOpIds: participants.map((p) => p.opId),
        participantSessionIds: participants.map((p) => p.sessionId),
      },
    }),
  });
  if (!benchOpRes.ok) {
    for (const p of participants) {
      await fetch(`${base}/plugins/terminal/agent/sessions/${p.opId}`, { method: "DELETE" }).catch(() => {});
    }
    await fetch(`${base}/api/v1/operations/groups/${groupId}`, { method: "DELETE" }).catch(() => {});
    throw new Error(`bench_op_create_failed:${benchOpRes.status}`);
  }
  const benchOpData = (await benchOpRes.json()) as { operation: { id: string } };
  const benchOpId = benchOpData.operation.id;

  // bench op도 같은 group에 편입
  await fetch(`${base}/api/v1/operations/${benchOpId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId }),
  }).catch(() => {});

  return { groupId, benchOpId, participants };
}

export async function deleteFanout(participantOpIds: readonly string[], benchOpId: string, groupId: string, serverPort: number): Promise<void> {
  const base = `http://127.0.0.1:${serverPort}`;
  // 삭제 순서: 참전자 op → bench op → group
  for (const opId of participantOpIds) {
    await fetch(`${base}/plugins/terminal/agent/sessions/${opId}`, { method: "DELETE" }).catch(() => {});
  }
  await fetch(`${base}/api/v1/operations/${benchOpId}`, { method: "DELETE" }).catch(() => {});
  await fetch(`${base}/api/v1/operations/groups/${groupId}`, { method: "DELETE" }).catch(() => {});
}

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
