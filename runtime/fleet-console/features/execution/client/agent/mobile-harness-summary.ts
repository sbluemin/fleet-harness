import { fetchAgentCliState } from "./api.js";

/**
 * 폰의 설정 목록 「하네스」 행의 보조 줄 — 쓸 수 있는 Agent CLI 이름을 「 · 」로 잇는다.
 * 설정 본문의 가용성 카드와 같은 원천(`fetchAgentCliState`)을 첫 구독 때 한 번 읽어 두고 구독자에게 알린다.
 */
let names: readonly string[] | null = null;
let loading = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loading || names !== null) return;
  loading = true;
  void fetchAgentCliState()
    .then((state) => { names = state.clis.filter((cli) => cli.available).map((cli) => cli.displayName); })
    .catch(() => undefined)
    .finally(() => { loading = false; for (const listener of listeners) listener(); });
}

export function subscribeHarnessSummary(listener: () => void): () => void {
  listeners.add(listener);
  load();
  return () => { listeners.delete(listener); };
}

/** 읽기 전·실패면 null(줄을 그리지 않는다), 쓸 수 있는 CLI가 없으면 빈 문자열이 아니라 null. */
export function harnessSummary(): string | null {
  return names === null || names.length === 0 ? null : names.join(" · ");
}
