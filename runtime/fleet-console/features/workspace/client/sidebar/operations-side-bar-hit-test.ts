export interface DropSectionInfo {
  readonly groupId: string | null;
  readonly entryIds: readonly string[];
}

export function dropIndexFromPoint(
  clientY: number,
  orderedIds: readonly string[],
  container: HTMLOListElement | null,
  sourceId?: string,
): number {
  if (!container) return 0;
  const chipElements = Array.from(container.querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"));
  for (const chip of chipElements) {
    const id = chip.dataset.sideBarChipId;
    if (!id || id === sourceId) continue;
    const rect = chip.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) return Math.max(0, orderedIds.indexOf(id));
  }
  return orderedIds.length;
}

export function dropTargetFromPoint(
  clientY: number,
  sections: readonly DropSectionInfo[],
  container: HTMLOListElement | null,
  sourceId?: string,
): { readonly groupId: string | null; readonly index: number } {
  if (!container) return { groupId: null, index: 0 };

  for (const section of sections) {
    const sectionKey = section.groupId ?? "__ungrouped__";
    // 헤더+chips를 감싸는 wrapper([data-drop-zone-group-id])로 hit test한다.
    // collapsed 그룹이나 그룹 헤더 위도 올바른 그룹으로 매핑된다.
    const wrapperEl = container.querySelector<HTMLElement>(`[data-drop-zone-group-id="${sectionKey}"]`);
    if (!wrapperEl) continue;
    const wrapperRect = wrapperEl.getBoundingClientRect();
    if (clientY < wrapperRect.top || clientY > wrapperRect.bottom) continue;

    const chipsEl = wrapperEl.querySelector<HTMLElement>(`[data-group-section-id="${sectionKey}"]`);
    if (!chipsEl || clientY < chipsEl.getBoundingClientRect().top) {
      // 헤더 영역이거나 chips ol이 없는 collapsed 그룹 → 맨 앞에 삽입
      return { groupId: section.groupId, index: 0 };
    }

    const chipEls = Array.from(chipsEl.querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"));
    for (const chipEl of chipEls) {
      const id = chipEl.dataset.sideBarChipId;
      if (!id || id === sourceId) continue;
      const chipRect = chipEl.getBoundingClientRect();
      if (clientY <= chipRect.top + chipRect.height / 2) {
        return { groupId: section.groupId, index: Math.max(0, section.entryIds.indexOf(id)) };
      }
    }
    return { groupId: section.groupId, index: section.entryIds.length };
  }

  const last = sections[sections.length - 1];
  return { groupId: last?.groupId ?? null, index: last?.entryIds.length ?? 0 };
}

export function groupDropIndexFromPoint(
  clientY: number,
  orderedGroupIds: readonly string[],
  container: HTMLOListElement | null,
  sourceGroupId?: string,
): number {
  if (!container) return 0;
  const groupElements = Array.from(container.querySelectorAll<HTMLElement>("[data-drop-zone-group-id]"));
  for (const groupEl of groupElements) {
    const id = groupEl.dataset.dropZoneGroupId;
    if (!id || id === "__ungrouped__" || id === sourceGroupId) continue;
    const index = orderedGroupIds.indexOf(id);
    if (index === -1) continue;
    const rect = groupEl.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) return index;
  }
  return orderedGroupIds.length;
}

export function theaterDropIndexFromPoint(
  clientY: number,
  orderedTheaterIds: readonly string[],
  container: HTMLOListElement | null,
  sourceTheaterId?: string,
): number {
  if (!container) return 0;
  const theaterElements = Array.from(container.querySelectorAll<HTMLElement>("[data-theater-id]"));
  for (const theaterEl of theaterElements) {
    const id = theaterEl.dataset.theaterId;
    if (!id || id === sourceTheaterId) continue;
    const index = orderedTheaterIds.indexOf(id);
    if (index === -1) continue;
    const rect = theaterEl.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) return index;
  }
  return orderedTheaterIds.length;
}

// cross-group 드롭용: sourceId를 allIds에서 제거하고 대상 segment의 dropIndex 위치에 삽입한다.
// dropIndex = source가 없는 대상 entryIds 기준 타깃 슬롯; 보정 없음(source가 segment에 없음).
// sourceId는 segment에 속하지 않으며, segment의 기존 순서는 allIds 내에서의 순서를 따른다.
export function insertIntoSegment(
  allIds: readonly string[],
  sourceId: string,
  dropIndex: number,
  segmentIds: readonly string[],
): string[] {
  const withoutSource = allIds.filter((id) => id !== sourceId);
  const segmentSet = new Set(segmentIds);
  const currentSegment = withoutSource.filter((id) => segmentSet.has(id));
  const bounded = Math.max(0, Math.min(dropIndex, currentSegment.length));
  if (currentSegment.length === 0) return [...withoutSource, sourceId];
  if (bounded < currentSegment.length) {
    const insertIdx = withoutSource.indexOf(currentSegment[bounded]!);
    const result = [...withoutSource];
    result.splice(insertIdx, 0, sourceId);
    return result;
  }
  const lastIdx = withoutSource.indexOf(currentSegment[currentSegment.length - 1]!);
  const result = [...withoutSource];
  result.splice(lastIdx + 1, 0, sourceId);
  return result;
}

// same-section 드롭용: dropIndex = source를 포함한 entryIds 기준 포인터 슬롯; 내부에서 source 제거분 -1 보정.
export function reorderWithinSegment(
  allIds: readonly string[],
  sourceId: string,
  dropIndex: number,
  segmentIds: readonly string[],
): string[] {
  const segmentSet = new Set(segmentIds);
  const currentSegment = allIds.filter((id) => segmentSet.has(id));
  const sourceIndex = currentSegment.indexOf(sourceId);
  const withoutSource = currentSegment.filter((id) => id !== sourceId);
  // dropIndex는 source 포함 entryIds 기준이므로 downward 드래그 시 -1 보정한다.
  const adjusted = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(adjusted, withoutSource.length));
  withoutSource.splice(bounded, 0, sourceId);

  let segIdx = 0;
  return allIds.map((id) => (segmentSet.has(id) ? (withoutSource[segIdx++] ?? id) : id));
}

// keyboard 재배치용: currentOrder(collapsed 포함 전체)에서 visible op 자리만 nextVisibleOrder로 교체하고
// hidden(collapsed) op은 기존 위치를 그대로 유지한다.
// nextVisibleOrder 길이가 visibleOrder와 다르면 매핑이 어긋나 op 손실 — currentOrder 그대로 반환.
export function applyVisibleReorder(
  currentOrder: readonly string[],
  visibleOrder: readonly string[],
  nextVisibleOrder: readonly string[],
): string[] {
  if (nextVisibleOrder.length !== visibleOrder.length) return [...currentOrder];
  const visibleSet = new Set(visibleOrder);
  let visIdx = 0;
  return currentOrder.map((id) =>
    visibleSet.has(id) ? (nextVisibleOrder[visIdx++] ?? id) : id,
  );
}

// group 드롭용: dropIndex = source를 포함한 orderedGroupIds 기준 포인터 슬롯; downward 드래그 시 -1 보정한다.
export function reorderGroupIds(
  orderedGroupIds: readonly string[],
  sourceGroupId: string,
  dropIndex: number,
): string[] {
  const sourceIndex = orderedGroupIds.indexOf(sourceGroupId);
  if (sourceIndex === -1) return [...orderedGroupIds];
  const next = orderedGroupIds.filter((id) => id !== sourceGroupId);
  const adjusted = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(adjusted, next.length));
  next.splice(bounded, 0, sourceGroupId);
  return next;
}

export function reorderTheaterIds(
  orderedTheaterIds: readonly string[],
  sourceTheaterId: string,
  dropIndex: number,
): string[] {
  const sourceIndex = orderedTheaterIds.indexOf(sourceTheaterId);
  if (sourceIndex === -1) return [...orderedTheaterIds];
  const next = orderedTheaterIds.filter((id) => id !== sourceTheaterId);
  const adjusted = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(adjusted, next.length));
  next.splice(bounded, 0, sourceTheaterId);
  return next;
}

// keyboard 이동 전용: targetIndex = source가 제거된 목록 기준 삽입 위치(보정 없음).
// drag drop index(source 포함 기준)와 달리 visibleEntries의 인접 슬롯 번호를 그대로 사용한다.
export function moveByTargetIndex(
  orderedIds: readonly string[],
  sourceId: string,
  targetIndex: number,
): string[] {
  const sourceIdx = orderedIds.indexOf(sourceId);
  if (sourceIdx === -1) return [...orderedIds];
  const next = orderedIds.filter((id) => id !== sourceId);
  const bounded = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(bounded, 0, sourceId);
  return next;
}
