import { useSyncExternalStore } from "react";

import { openPane } from "../../../core/client/src/chrome/pane/pane-store.js";
import { openRailPanel } from "../../../core/client/src/chrome/rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "./settings-entry.js";
import { getViewModeSnapshot } from "../../../core/client/src/integration/view-mode-store.js";

/**
 * 설정의 문 — 어디서 부르든 설정 표면 하나가 선다.
 *
 * 데스크톱 설정은 화면 가운데 모달로 선다 — 대화의 세부 정보 자리인 오른쪽 패널은 그대로 남는다.
 * 모바일은 자기 설정 화면을 쓰고, 같은 섹션 레지스트리·본문을 공유한다.
 * 모달의 열림·섹션은 이 모듈이 진다(호스트 번들 안의 모듈 상태 — 플러그인은 pane 목표로 들어오고, 그 길은
 * plugin-capabilities 의 showTarget 이 이 문으로 돌린다).
 */

interface SettingsModalState {
  readonly open: boolean;
  /** 주소 id(코어 섹션 id 또는 `plugin:section`). null 이면 기본 섹션. */
  readonly section: string | null;
}

let modal: SettingsModalState = { open: false, section: null };
const listeners = new Set<() => void>();

function emit(next: SettingsModalState): void {
  if (next.open === modal.open && next.section === modal.section) return;
  modal = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSettingsModalSnapshot(): SettingsModalState {
  return modal;
}

export function useSettingsModal(): SettingsModalState {
  return useSyncExternalStore(subscribe, getSettingsModalSnapshot, getSettingsModalSnapshot);
}

/** 모달을 그 섹션으로 연다. 섹션을 말하지 않으면 보던 섹션을 지킨다(다시 열면 읽던 자리). */
export function openSettingsModal(section?: string | null): void {
  emit({ open: true, section: section === undefined ? modal.section : section });
}

export function closeSettingsModal(): void {
  emit({ ...modal, open: false });
}

export function setSettingsModalSection(section: string): void {
  emit({ ...modal, section });
}

/**
 * 설정을 연다 — 대화 중심 화면이면 모달, 아니면 레일 페인. 섹션은 두 그릇이 같은 주소 id 로 받는다.
 * 레일은 /operations 에만 서므로 다른 화면에서 부르는 쪽은 먼저 그 화면으로 간다(지금까지와 같은 계약).
 */
export function openSettingsSurface(section?: string): void {
  if (getViewModeSnapshot().effective === "desktop") {
    openSettingsModal(section ?? null);
    return;
  }
  openRailPanel(SETTINGS_RAIL_ENTRY_ID);
  if (section !== undefined) openPane({ paneId: SETTINGS_PANE_ID, params: { section } });
}
