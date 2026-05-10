/**
 * hud/layout.ts — 반응형 레이아웃 엔진
 *
 * 세그먼트들을 터미널 너비에 맞게 top bar와 secondary row로 분배하는 순수 함수들.
 */

import { visibleWidth } from "@sbluemin/fleet-tui";

import type { SegmentContext, StatusLineSegmentId } from "./types.js";
import { getPreset, getSeparator, ansi, getFgAnsiCode } from "./theme.js";
import { renderSegment } from "./segments.js";

/** 단일 세그먼트를 렌더링하고 너비 정보와 함께 반환 */
export function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext,
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** 렌더링된 세그먼트 배열을 구분자로 이어 붙여 문자열로 조합 */
export function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>,
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset + " ";
}

/**
 * 반응형 세그먼트 레이아웃 — top bar에 맞는 만큼 배치하고 나머지를 secondary row로 overflow.
 * 터미널이 넓으면 secondary 세그먼트도 top bar로 올라가고,
 * 좁으면 top bar 세그먼트가 secondary row로 내려간다.
 */
export function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2;

  // primary + secondary 순서로 모든 세그먼트 수집
  const primaryIds = [...presetDef.leftSegments, ...presetDef.rightSegments];
  const secondaryIds = presetDef.secondarySegments ?? [];
  const allSegmentIds = [...primaryIds, ...secondaryIds];

  // 모든 세그먼트 렌더링
  const renderedSegments: { content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ content, width });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  // top bar에 들어갈 수 있는 세그먼트 수 계산
  const baseOverhead = 2; // 앞뒤 공백
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let overflowSegments: { content: string; width: number }[] = [];
  let overflow = false;

  for (const seg of renderedSegments) {
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);

    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(seg);
    }
  }

  // overflow 세그먼트를 secondary row에 배치 (같은 너비 제약)
  let secondaryWidth = baseOverhead;
  let secondarySegments: string[] = [];

  for (const seg of overflowSegments) {
    const neededWidth = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth <= availableWidth) {
      secondarySegments.push(seg.content);
      secondaryWidth += neededWidth;
    } else {
      break;
    }
  }

  return {
    topContent: buildContentFromParts(topSegments, presetDef),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef),
  };
}
