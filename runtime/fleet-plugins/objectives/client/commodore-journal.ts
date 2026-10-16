import type { CommodoreStateView } from "../server/commodore/routes.js";
import type { CommodoreEvent, CommodoreLiveEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";

export interface TheaterCommodore {
  readonly view: CommodoreStateView | null;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly hasMore: boolean;
  readonly transcriptLoaded: boolean;
  readonly clearedThrough: number;
  readonly live: readonly CommodoreLiveEvent[];
}

export const EMPTY_COMMODORE: TheaterCommodore = { view: null, entries: [], hasMore: false, transcriptLoaded: false, clearedThrough: 0, live: [] };

/** 로컬과 host별 factory가 같은 지우기 좌표·저널 규칙을 사용한다. 상태 저장은 호출자 소유다. */
export function patchCommodoreJournal(current: TheaterCommodore, patch: Partial<TheaterCommodore>): TheaterCommodore {
  if (patch.view && (patch.view.state.transcriptClearedThrough ?? 0) < current.clearedThrough) return current;
  const clearedThrough = Math.max(current.clearedThrough, patch.clearedThrough ?? 0, patch.view?.state.transcriptClearedThrough ?? 0);
  const cleared = clearedThrough > current.clearedThrough;
  const next = { ...current, ...patch, clearedThrough };
  if (cleared) { next.entries = []; next.live = []; next.hasMore = false; }
  if (patch.entries || cleared) next.entries = (patch.entries ?? next.entries).filter((entry) => entry.seq > clearedThrough);
  return next;
}

export function applyCommodoreJournal(current: TheaterCommodore, event: CommodoreEvent): TheaterCommodore {
  if (event.op === "state" && event.change === "clear") current = patchCommodoreJournal(current, { clearedThrough: event.state.transcriptClearedThrough ?? 0 });
  if (event.op === "transcript") {
    if (!current.transcriptLoaded || current.entries.some((entry) => entry.seq === event.entry.seq)) return current;
    return patchCommodoreJournal(current, { entries: [...current.entries, event.entry].slice(-2000), live: settleLive(current.live, event.entry) });
  }
  if (event.op === "live") return current.transcriptLoaded ? patchCommodoreJournal(current, { live: appendLive(current.live, event.live) }) : current;
  if (!current.view) return current;
  if (event.op === "state") return patchCommodoreJournal(current, { view: { ...current.view, state: event.state, active: current.view.enabled && event.state.autonomy } });
  if (event.op === "run") return patchCommodoreJournal(current, { view: { ...current.view, run: event.run } });
  return current;
}

function settleLive(live: readonly CommodoreLiveEvent[], entry: CommodoreTranscriptEntry): readonly CommodoreLiveEvent[] {
  if (live.length === 0) return live;
  if (entry.kind === "text" || entry.kind === "thinking") return live.filter((event) => event.kind !== "text-delta");
  if (entry.kind === "tool") {
    const index = live.findIndex((event) => event.kind === "tool-start" && event.name === entry.name);
    return index < 0 ? live : [...live.slice(0, index), ...live.slice(index + 1)];
  }
  if (entry.kind === "message") return live;
  return [];
}

function appendLive(live: readonly CommodoreLiveEvent[], event: CommodoreLiveEvent): readonly CommodoreLiveEvent[] {
  const last = live.at(-1);
  if (last?.kind === "text-delta" && event.kind === "text-delta") return [...live.slice(0, -1), { kind: "text-delta", text: (last.text + event.text).slice(0, 60_000) }];
  return [...live, event];
}
