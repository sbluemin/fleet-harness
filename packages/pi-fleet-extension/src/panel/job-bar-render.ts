/**
 * fleet — Job Bar 렌더러
 *
 * Editor 하단(belowEditor)에 활성 PanelJob을 타일 형태로 렌더링합니다.
 * 가상 포커스 모드에서 ←→로 탐색하고 Enter로 확장합니다.
 * 확장 시 해당 job의 위치에서 바로 아래로 펼쳐집니다.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	ANSI_RESET,
	PANEL_DIM_COLOR,
	PANEL_RGB,
	SPINNER_FRAMES,
	SYM_INDICATOR,
	CLI_DISPLAY_NAMES,
} from "@sbluemin/fleet-core/constants";
import { buildPanelViewModel } from "./view-model.js";
import type { PanelJobViewModel, PanelTrackViewModel } from "./view-model.js";
import { resolveCarrierColor, resolveCarrierRgb } from "../tools.js";
import { getActiveJobs, getPanelRuns, getState } from "./state.js";
import { renderBlockLines } from "./message-render.js";
import { waveText } from "./panel-render.js";

// ─── 상수 ────────────────────────────────────────────────

const MAX_EXPANDED_STREAM_LINES = 1;
const MAX_EXPANDED_TOTAL_LINES = 8;
const TILE_SEPARATOR = ` ${PANEL_DIM_COLOR}│${ANSI_RESET} `;
const SEPARATOR_VIS_W = 3;
const COLOR_DONE = "\x1b[38;2;80;200;120m";
const COLOR_ERROR = "\x1b[38;2;255;80;80m";
const STREAM_PREFIX = "  ";
const STREAM_INLINE_COLOR = "\x1b[38;2;100;210;245m";
const FOCUS_BG_FACTOR = 0.12;
const FOCUS_BG_BASE = 12;

const KIND_LABELS: Record<string, string> = {
	sortie: "Sortie",
	squadron: "Squadron",
	taskforce: "Taskforce",
};

// ─── 메인 진입점 ─────────────────────────────────────────

export function renderJobBar(width: number, frame: number): string[] {
	const jobs = getActiveJobs();
	if (jobs.length === 0) return [];

	const s = getState();
	const vmJobs = buildPanelViewModel(jobs, getPanelRuns(), { maxTrackBlocks: MAX_EXPANDED_STREAM_LINES });
	const cursor = Math.min(s.jobBarCursor, vmJobs.length - 1);

	if (s.jobBarExpandedJobId && vmJobs.some((j) => j.jobId === s.jobBarExpandedJobId)) {
		return renderJobBarExpanded(width, vmJobs, cursor, s.jobBarExpandedJobId, frame);
	}

	return renderJobBarStrip(width, vmJobs, cursor, frame);
}

// ─── 축소 모드 (1줄) ─────────────────────────────────────

function renderJobBarStrip(
	width: number,
	jobs: PanelJobViewModel[],
	cursor: number,
	frame: number,
): string[] {
	const tiles = jobs.map((job, i) => formatJobTile(job, i === cursor, frame));
	const line = tiles.join(TILE_SEPARATOR);
	return [truncateToWidth(line, width)];
}

// ─── 확장 모드 ────────────────────────────────────────────

function renderJobBarExpanded(
	width: number,
	jobs: PanelJobViewModel[],
	cursor: number,
	expandedJobId: string,
	frame: number,
): string[] {
	const expandedIdx = jobs.findIndex((j) => j.jobId === expandedJobId);
	if (expandedIdx < 0) return renderJobBarStrip(width, jobs, cursor, frame);

	const expandedJob = jobs[expandedIdx];
	if (!expandedJob) return [];

	const tiles = jobs.map((job, i) => formatJobTile(job, i === cursor, frame));
	const offsets = computeTileOffsets(tiles);

	// 모든 kind가 동일하게 트리 뎁스를 표시
	const indent = " ".repeat(offsets[expandedIdx] ?? 0);
	const lines: string[] = [tiles.join(TILE_SEPARATOR)];
	appendTrackTree(lines, width, expandedJob, indent, frame);
	return lines.map((line) => truncateToWidth(line, width));
}

// ─── 멀티 트랙 트리 렌더링 ──────────────────────────────

function appendTrackTree(
	lines: string[],
	width: number,
	job: PanelJobViewModel,
	indent: string,
	frame: number,
): void {
	const budget = MAX_EXPANDED_TOTAL_LINES - 1;
	const fallbackColor = resolveCarrierColor(job.ownerCarrierId);
	let remaining = budget;

	for (let i = 0; i < job.tracks.length && remaining > 0; i++) {
		const track = job.tracks[i];
		if (!track) continue;
		const isLast = i === job.tracks.length - 1;
		const branch = isLast ? "└─" : "├─";

		const trackColor = resolveCarrierColor(track.displayCli) ?? fallbackColor;
		const icon = trackStatusIcon(track, frame, trackColor);
		const name = `${trackColor}${trackDisplayName(track)}${ANSI_RESET}`;

		// 활성 트랙의 최신 스트리밍 인라인
		const inline = !track.isComplete ? trackInlineBlock(track) : "";

		lines.push(truncateToWidth(
			`${indent}${STREAM_PREFIX}${PANEL_DIM_COLOR}${branch}${ANSI_RESET} ${icon} ${name}${inline}`,
			width,
		));
		remaining--;
	}
}

// ─── 인라인 스트리밍 헬퍼 ──────────────────────────────────

/** 트랙의 최신 블록을 인라인 문자열로 반환 (· 구분자 포함) */
function trackInlineBlock(track: PanelTrackViewModel): string {
	if (track.blocks.length === 0) return "";
	const rendered = renderBlockLines(track.blocks).filter((bl) => bl.text.trim());
	const latest = rendered[rendered.length - 1];
	if (!latest) return "";
	return ` ${PANEL_DIM_COLOR}·${ANSI_RESET} ${STREAM_INLINE_COLOR}${latest.text.trim()}${ANSI_RESET}`;
}

// ─── offset 계산 ─────────────────────────────────────────

function computeTileOffsets(tiles: string[]): number[] {
	const offsets: number[] = [];
	let pos = 0;
	for (let i = 0; i < tiles.length; i++) {
		offsets.push(pos);
		pos += visibleWidth(tiles[i]);
		if (i < tiles.length - 1) pos += SEPARATOR_VIS_W;
	}
	return offsets;
}

// ─── 포맷팅 헬퍼 ─────────────────────────────────────────

function carrierDisplayName(carrierId: string): string {
	return CLI_DISPLAY_NAMES[carrierId] ?? capitalize(carrierId);
}

function kindDisplayName(kind: string): string {
	return KIND_LABELS[kind] ?? capitalize(kind);
}

function capitalize(text: string): string {
	if (!text) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 캐리어 RGB를 배경색 ANSI 이스케이프로 변환 */
function carrierBgEscape(rgb: readonly [number, number, number]): string {
	const r = Math.round(rgb[0] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
	const g = Math.round(rgb[1] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
	const b = Math.round(rgb[2] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** ANSI 리셋 후 배경색 재적용 */
function reapplyBg(text: string, bg: string): string {
	return text.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
}

function formatJobTile(
	job: PanelJobViewModel,
	focused: boolean,
	frame: number,
): string {
	const carrierColor = resolveCarrierColor(job.ownerCarrierId);
	const icon = jobIcon(job.status, frame, carrierColor);
	const kind = kindDisplayName(job.kind);
	const trackCount = job.tracks.length > 1 ? `:${job.tracks.length}` : "";
	const carrierName = carrierDisplayName(job.ownerCarrierId);
	const label = `${carrierName}·${kind}${trackCount}`;

	if (focused) {
		const rgb = resolveCarrierRgb(job.ownerCarrierId) ?? PANEL_RGB;
		const bg = carrierBgEscape(rgb);
		const focusedLabel = waveText(label, rgb, frame);
		const content = `${reapplyBg(icon, bg)} ${reapplyBg(focusedLabel, bg)} `;
		return `${bg}${content}${ANSI_RESET}`;
	}

	return `${icon} ${carrierColor}${label}${ANSI_RESET}`;
}

function jobIcon(status: PanelJobViewModel["status"], frame: number, color?: string): string {
	if (status === "active") {
		const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
	}
	if (status === "done") return `${COLOR_DONE}${SYM_INDICATOR}${ANSI_RESET}`;
	if (status === "error" || status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR}${ANSI_RESET}`;
	return `${PANEL_DIM_COLOR}○${ANSI_RESET}`;
}

function trackStatusIcon(track: PanelTrackViewModel, frame: number, color?: string): string {
	if (track.isComplete) {
		if (track.status === "err") return `${COLOR_ERROR}${SYM_INDICATOR}${ANSI_RESET}`;
		return `${COLOR_DONE}${SYM_INDICATOR}${ANSI_RESET}`;
	}
	const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
	return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
}

function trackDisplayName(track: PanelTrackViewModel): string {
	if (track.kind === "backend") {
		return CLI_DISPLAY_NAMES[track.displayCli] ?? capitalize(track.displayCli);
	}
	return track.displayName;
}
