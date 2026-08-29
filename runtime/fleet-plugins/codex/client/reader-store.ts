import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { useSyncExternalStore } from "react";

import { setCodexReaderExpandedForSession } from "./codex-host.js";
import { hostCapabilities, resolveActiveLocaleFromHost } from "./host.js";

/**
 * 무엇을 읽고 있는가. 예전에는 코어 콘솔 스토어의 필드였다 — Codex가 나가면서 그 지식도
 * 함께 나온다. 코어는 이제 "확대 표면 슬롯이 하나 있다"까지만 알고, 그 안이 어느 문서인지는
 * 모른다.
 */
export type CodexReaderRequest =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "drydock"; readonly patchId?: string }
  | { readonly kind: "conflicts"; readonly id?: string }
  | { readonly kind: "schema"; readonly templateId?: string };

const SURFACE_ID = "codex";

interface ReaderState {
  readonly codexReader: CodexReaderRequest | null;
  readonly codexReaderExpanded: boolean;
  /** 호스트가 아는 Theater 사실 — 능력에서 읽어 매 스냅샷에 실어 준다. */
  readonly theaters: readonly { readonly id: string; readonly label: string }[];
  readonly activeTheaterId: string | null;
}

const listeners = new Set<() => void>();
let reader: CodexReaderRequest | null = null;
let expanded = false;
let state: ReaderState = snapshot();

function snapshot(): ReaderState {
  const consoleState = hostCapabilities.bound()?.consoleState;
  return {
    codexReader: reader,
    codexReaderExpanded: expanded,
    theaters: consoleState?.getTheaters() ?? [],
    activeTheaterId: consoleState?.getActiveTheaterId() ?? null,
  };
}

function publish(): void {
  const next = snapshot();
  const same = next.codexReader === state.codexReader
    && next.codexReaderExpanded === state.codexReaderExpanded
    && next.activeTheaterId === state.activeTheaterId
    && next.theaters.length === state.theaters.length
    && next.theaters.every((t, i) => t.id === state.theaters[i]?.id && t.label === state.theaters[i]?.label);
  if (same) return;
  state = next;
  for (const listener of listeners) listener();
}



export function subscribeReader(listener: () => void): () => void {
  listeners.add(listener);
  // Theater 사실은 호스트가 바꾼다 — 그 변화도 이 스냅샷에 실려야 화면이 따라간다.
  const release = hostCapabilities.bound()?.consoleState.subscribe(publish) ?? (() => undefined);
  return () => { listeners.delete(listener); release(); };
}

export function getReaderState(): ReaderState {
  return state;
}

export function useReaderState(): ReaderState {
  return useSyncExternalStore(subscribeReader, getReaderState, getReaderState);
}

/** 문서를 연다. 확대는 별개의 동작이므로 여기서 슬롯을 만들지 않는다. */
export function openCodexReader(request: CodexReaderRequest): void {
  reader = request; expanded = false; publish();
}

export function expandCodexReader(): void {
  if (reader === null) return;
  expanded = true;
  publish();
  hostCapabilities().surfaces.open({ surfaceId: SURFACE_ID });
}

export function collapseCodexReader(): void {
  expanded = false;
  publish();
  closeSurfaceSlots();
}

/**
 * 호스트가 이미 슬롯을 닫았다는 통보를 받았을 때. 확대만 내려놓고 슬롯은 건드리지
 * 않는다 — 여기서 다시 닫으면 통보가 닫기를 부르고 닫기가 통보를 부른다.
 *
 * 이걸 놓치면 슬롯은 사라졌는데 `expanded`는 참으로 남아, 패널이 축소 리더를 그리지
 * 않는다. 사용자에겐 확대에서 돌아올 길이 사라진다.
 */
export function releaseCodexExpansion(): void {
  if (!expanded) return;
  expanded = false;
  // 세션 기록도 함께 내린다 — 시트는 곧 언마운트되므로 자기 effect로 이걸 남길
  // 기회가 없고, 남겨 두면 새로고침이 닫은 적 없는 확대를 되살린다.
  setCodexReaderExpandedForSession(false);
  publish();
}

export function closeCodexReader(): void {
  reader = null;
  expanded = false;
  publish();
  closeSurfaceSlots();
}

function closeSurfaceSlots(): void {
  // 표면 id로 닫는다 — `close`는 인스턴스 id를 받으므로(`codex#1`) 표면 id를 넘기면
  // 일치하는 슬롯이 없어 조용히 아무 일도 일어나지 않고, 빈 슬롯만 캔버스에 남는다.
  hostCapabilities().surfaces.closeSurface(SURFACE_ID);
}

export function setActiveTheater(theaterId: string): void {
  hostCapabilities().consoleState.setActiveTheater(theaterId);
}

export function useConsoleLocale(): ConsoleLocale {
  return resolveActiveLocaleFromHost();
}
