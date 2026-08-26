import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useConsoleState } from "./use-store.js";
import { openRailPanel } from "../rail/rail-store.js";
import { closeCodexReader, collapseCodexReader, expandCodexReader, openCodexReader, setActiveTheater } from "../store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ENTRY_PARAM = "codex";
const VIEW_PARAM = "codexView";
const THEATER_PARAM = "codexTheater";
const VIEW_FULL = "full";

interface ReaderTarget {
  readonly entryId: string;
  readonly expanded: boolean;
  /**
   * 문서가 사는 Theater. 항목 id는 Theater 안에서만 뜻이 있으므로, 이것이 없으면
   * 링크를 받은 쪽의 활성 Theater에서 같은 id를 찾다가 없는 문서를 보여주게 된다.
   */
  readonly theaterId: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * 읽고 있는 문서와 화면 모드를 주소에 싣는다.
 *
 * 주소가 없으면 새로고침은 읽던 문서를 잃고, 링크로 건넬 방법도, 브라우저 뒤로가기로
 * 되돌아올 방법도 없다. 문서 전환은 push로 쌓아 뒤로가기가 리더 안의 이동을 거슬러
 * 올라가게 하고, 같은 문서의 확대/축소는 replace로 히스토리를 더럽히지 않는다.
 *
 * 부팅에는 순서가 있다: Theater가 확정되기 전 Codex 패널은 리더를 한 번 닫는다. 그
 * 닫힘을 주소에 그대로 쓰면 링크로 들어온 문서가 지워지므로, 주소가 지목한 문서를
 * 목표로 들고 있다가 Theater가 준비된 뒤 적용하고, 그때까지는 주소를 쓰지 않는다.
 */
export function useCodexReaderUrlSync(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    codexReader: reader,
    codexReaderExpanded: expanded,
    activeTheaterId: theaterId,
    theaters,
  } = useConsoleState();

  // 주소가 요구한 목표. 리더가 그 상태에 도달할 때까지 살아 있다.
  const targetRef = useRef<ReaderTarget | null>(readTarget(window.location.search));
  // 자기가 쓴 주소를 다시 읽어 되돌리는 왕복을 막는다.
  const writtenRef = useRef<string | null>(null);

  // 주소 → 목표
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const entryId = params.get(ENTRY_PARAM);
    const wantExpanded = params.get(VIEW_PARAM) === VIEW_FULL;
    const wantTheater = params.get(THEATER_PARAM);
    const signature = `${entryId ?? ""}|${wantExpanded ? VIEW_FULL : ""}|${wantTheater ?? ""}`;
    // 자기가 방금 쓴 주소는 한 번만 흘려보낸다 — 계속 물고 있으면 같은 주소로 되돌아오는
    // 앞으로가기가 영영 무시된다.
    if (signature === writtenRef.current) {
      writtenRef.current = null;
      return;
    }

    if (!entryId) {
      // 리더 문서가 주소에서 사라졌다 = 뒤로가기로 리더를 열기 전 상태에 도달했다.
      // 여기서 확대만 접으면 리더는 같은 문서를 그대로 들고 있어, 반대 방향 effect가
      // 그 문서를 주소에 다시 밀어 넣는다 — 뒤로가기가 리더 앞으로 나갈 수 없게 된다.
      targetRef.current = null;
      if (reader !== null) closeCodexReader();
      return;
    }
    targetRef.current = { entryId, expanded: wantExpanded, theaterId: wantTheater };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 주소 변화에만 반응한다
  }, [location.search]);

  // 목표 → 리더 (Theater가 준비된 뒤에만)
  useEffect(() => {
    const target = targetRef.current;
    if (!target || !theaterId) return;
    if (target.theaterId && target.theaterId !== theaterId) {
      // 링크가 다른 Theater의 문서를 가리키면 그 Theater로 옮겨서 연다.
      if (theaters.some((entry) => entry.id === target.theaterId)) {
        setActiveTheater(target.theaterId);
        return;
      }
      // 이 콘솔이 모르는 Theater다. 지금 Theater에서 같은 id를 찾으면 링크가 약속한
      // 문서가 아닌 것을 보여주게 되므로 열지 않고, 목표도 버려 매 렌더 재시도를 끊는다.
      targetRef.current = null;
      return;
    }
    // 주소로 직접 들어오면 Codex 패널이 아직 워크스페이스를 해석하지 않았다 —
    // 패널을 먼저 세워야 리더 fetch가 workspace id를 얻는다.
    openRailPanel("codex");
    if (reader?.kind !== "entry" || reader.entryId !== target.entryId) {
      openCodexReader({ kind: "entry", entryId: target.entryId });
      if (target.expanded) expandCodexReader();
      return;
    }
    if (target.expanded && !expanded) {
      expandCodexReader();
      return;
    }
    if (!target.expanded && expanded) {
      collapseCodexReader();
      return;
    }
    targetRef.current = null;
    // location.search를 함께 물어야 뒤로가기가 세운 새 목표가 이 effect를 깨운다 —
    // ref 갱신만으로는 리렌더도 재실행도 일어나지 않는다.
  }, [theaterId, theaters, reader, expanded, location.search]);

  // 리더 → 주소
  useEffect(() => {
    if (!theaterId || targetRef.current) return;
    const params = new URLSearchParams(location.search);
    const currentEntry = params.get(ENTRY_PARAM);
    const currentView = params.get(VIEW_PARAM);
    const currentTheater = params.get(THEATER_PARAM);
    const nextEntry = reader?.kind === "entry" ? reader.entryId : null;
    const nextView = nextEntry && expanded ? VIEW_FULL : null;
    const nextTheater = nextEntry ? theaterId : null;
    if (currentEntry === nextEntry && currentView === nextView && currentTheater === nextTheater) return;

    if (nextEntry) params.set(ENTRY_PARAM, nextEntry);
    else params.delete(ENTRY_PARAM);
    if (nextView) params.set(VIEW_PARAM, nextView);
    else params.delete(VIEW_PARAM);
    if (nextTheater) params.set(THEATER_PARAM, nextTheater);
    else params.delete(THEATER_PARAM);

    writtenRef.current = `${nextEntry ?? ""}|${nextView ?? ""}|${nextTheater ?? ""}`;
    const search = params.toString();
    // 문서가 바뀌면 한 걸음 쌓고(뒤로가기로 돌아올 수 있게), 같은 문서의 표시 모드
    // 변화는 그 자리를 갈아 끼운다.
    const documentChanged = currentEntry !== nextEntry;
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: !documentChanged });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 리더 상태 변화에만 반응한다
  }, [reader, expanded, theaterId]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readTarget(search: string): ReaderTarget | null {
  const params = new URLSearchParams(search);
  const entryId = params.get(ENTRY_PARAM);
  if (!entryId) return null;
  return {
    entryId,
    expanded: params.get(VIEW_PARAM) === VIEW_FULL,
    theaterId: params.get(THEATER_PARAM),
  };
}
