import { useEffect, useState } from "react";

import type { ConversationWorkLocation } from "../../../shared/pane.js";

import { CONVERSATION_WORKBENCH_API_PATH } from "../../../shared/conversation-workbench.js";

/**
 * 대화의 작업 위치 — 도구 칸이 대화에서 파생하는 유일한 좌표다(시안 v2 규칙 c). 사람이 다시 고르지 않는다.
 *
 * - 사령관(Theater 를 대신하는 플러그인 대화)은 Theater 루트다.
 * - 지휘관(Objective 대화)은 생성 때 고정한 목표 작업 폴더다 — 브라우저 DTO 에는 작업 폴더가 실리지 않으므로(원시 경로 금지)
 *   호스트가 목표 루트 기준 좌표로 접어 준 값을 읽는다. 소실된 위치는 사용할 수 없다.
 *
 * Objective 이 바뀌었다는 신호(`revision` — 그 노드의 갱신 시각)가 오면 다시 읽되, 잦은 활동 갱신에 끌려다니지 않게 짧게 묶는다.
 */

export type WorkLocationTarget =
  | { readonly kind: "objectiveRecord"; readonly objectiveId: string; readonly theaterId: string; readonly theaterLabel: string; readonly revision: number; readonly folder?: string | null }
  | { readonly kind: "theater"; readonly theaterId: string; readonly theaterLabel: string }
  | { readonly kind: "none" };

const REFRESH_MIN_INTERVAL_MS = 1_500;
// 읽지 못하면 짧게 늘려 가며 몇 번만 다시 묻는다 — 그 뒤로는 다음 신호(revision·폴더 변화)를 기다린다.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
// (Objective, 폴더) 한 쌍의 값만 담는다 — 다른 폴더(같은 세션의 옛 폴더 포함)의 값으로 대신하지 않는다.
const cache = new Map<string, { readonly location: ConversationWorkLocation; readonly at: number }>();

/** 쌍의 키 — 폴더 없음(세션의 실행 작업 폴더)과 빈 폴더(Theater 루트로 옮김)는 다른 자리다. */
function pairKey(objectiveId: string, folder: string | null): string {
  return JSON.stringify([objectiveId, folder]);
}

async function fetchLocation(objectiveId: string, folder: string | null): Promise<ConversationWorkLocation | null> {
  try {
    const query = new URLSearchParams({ objectiveId });
    const response = await fetch(`${CONVERSATION_WORKBENCH_API_PATH}/location?${query}`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as { readonly location?: unknown };
    return isLocation(body.location) ? body.location : null;
  } catch {
    return null;
  }
}

function isLocation(value: unknown): value is ConversationWorkLocation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.theaterId === "string" && typeof record.relative === "string" && typeof record.label === "string"
    && (record.kind === "root" || record.kind === "worktree" || record.kind === "directory");
}

function sameLocation(a: ConversationWorkLocation | null, b: ConversationWorkLocation | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.theaterId === b.theaterId && a.relative === b.relative && a.kind === b.kind && a.label === b.label;
}

function rootOf(theaterId: string, label: string): ConversationWorkLocation {
  return { theaterId, relative: "", kind: "root", label };
}

/**
 * 그 대화의 작업 위치. 아직 모르면 null 이다 — 부르는 쪽은 그동안 도구 칸을 세우지 않는다(앞 대화의 위치나 빈 값으로 Shell 이
 * 엉뚱한 자리에 서지 않게). 돌려주는 값은 늘 지금 대화의 것이다: 대화가 바뀌는 렌더에서 앞 대화의 값을 흘리지 않는다.
 */
export function useConversationWorkLocation(target: WorkLocationTarget): ConversationWorkLocation | null {
  const objectiveId = target.kind === "objectiveRecord" ? target.objectiveId : null;
  const revision = target.kind === "objectiveRecord" ? target.revision : 0;
  // 세션이 옮겨 간 폴더(「지금 어디」 투영, Theater 상대) — 있으면 그 자리가 작업 위치다. 없으면 세션의 실행 작업 폴더.
  const folder = null;
  const theaterId = target.kind === "none" ? null : target.theaterId;
  const theaterLabel = target.kind === "none" ? "" : target.theaterLabel;
  const key = objectiveId === null ? null : pairKey(objectiveId, folder);
  const [fetched, setFetched] = useState<{ readonly key: string; readonly location: ConversationWorkLocation } | null>(null);

  useEffect(() => {
    if (objectiveId === null || key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cached = cache.get(key) ?? null;
    const attempt = (failures: number) => {
      void fetchLocation(objectiveId, folder).then((result) => {
        if (result === null) {
          // 읽지 못한 동안은 모른다 — 옛 위치나 Theater 루트로 대신하면 도구 칸이 엉뚱한 자리에 선다(같은 쌍의 캐시는 그대로 쓴다).
          const delay = RETRY_DELAYS_MS[failures];
          if (live && delay !== undefined) timer = setTimeout(() => attempt(failures + 1), delay);
          return;
        }
        cache.set(key, { location: result, at: Date.now() });
        if (live) setFetched((current) => (current?.key === key && sameLocation(current.location, result) ? current : { key, location: result }));
      });
    };
    timer = setTimeout(() => attempt(0), cached === null ? 0 : Math.max(0, REFRESH_MIN_INTERVAL_MS - (Date.now() - cached.at)));
    return () => { live = false; clearTimeout(timer); };
  }, [folder, key, objectiveId, revision]);

  if (objectiveId === null) return theaterId === null ? null : stableRoot(theaterId, theaterLabel);
  // 지금 (Objective, 폴더) 쌍의 값만 — 막 읽은 값, 없으면 이 화면이 전에 그 쌍으로 읽어 둔 값. 둘 다 없으면 아직 모른다(null).
  // 폴더가 바뀐 렌더에서 옛 폴더의 값을 흘리지 않는다 — 부르는 쪽은 null 인 동안 도구 칸을 세우지 않는다.
  if (fetched?.key === key) return fetched.location;
  return cache.get(key!)?.location ?? null;
}

const roots = new Map<string, ConversationWorkLocation>();
function stableRoot(theaterId: string, label: string): ConversationWorkLocation {
  const key = `${theaterId}\n${label}`;
  let root = roots.get(key);
  if (!root) {
    root = rootOf(theaterId, label);
    roots.set(key, root);
  }
  return root;
}
