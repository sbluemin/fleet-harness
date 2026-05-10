/**
 * core-keybind — 중앙 집중 키바인딩 확장
 *
 * 배선(wiring)만 담당:
 *   - factory에서 실제 API 구현 주입 (큐 flush)
 *   - Alt+? 단축키로 키바인딩 editor-replace 팝업 열기
 */

import type { Component, Focusable } from "@sbluemin/fleet-tui";
import { visibleWidth } from "@sbluemin/fleet-tui";
import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";
import type { Theme } from "@sbluemin/fleet-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";

// ═══════════════════════════════════════════════════════════════════════════
// 타입
// ═══════════════════════════════════════════════════════════════════════════

/** 단축키 등록 요청 */
export interface KeybindRegistration {
  extension: string;
  action: string;
  defaultKey: string;
  description: string;
  category?: string;
  handler: (ctx: any) => void | Promise<void>;
}

/** 오버라이드가 적용된 최종 바인딩 */
export interface ResolvedBinding extends KeybindRegistration {
  resolvedKey: string;
  conflicted?: boolean;
}

/** fleet-harness가 제공하는 keybind API */
export interface CoreKeybindAPI {
  register(binding: KeybindRegistration): void;
  getBindings(): ResolvedBinding[];
  getKey(extension: string, action: string): string | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bridge (bridge.ts)
// ═══════════════════════════════════════════════════════════════════════════

const bootstrapQueue: KeybindRegistration[] = [];
const keybindState = {
  _bindings: [] as ResolvedBinding[],
};

let activeApi: CoreKeybindAPI | null = null;
let warnTimer: ReturnType<typeof setTimeout> | null = null;

const keybindService: CoreKeybindAPI & typeof keybindState = {
  ...keybindState,
  register(binding: KeybindRegistration) {
    if (activeApi) {
      activeApi.register(binding);
      return;
    }
    bootstrapQueue.push(binding);
  },
  getBindings() {
    return activeApi?.getBindings() ?? [];
  },
  getKey(ext: string, action: string) {
    return activeApi?.getKey(ext, action);
  },
};

installKeybindService();

export function getKeybindAPI(): CoreKeybindAPI {
  return installKeybindService();
}

export function getKeybindBindings(): ResolvedBinding[] {
  return keybindService._bindings;
}

export function prepareKeybindBridgeForExtensionLoad(): void {
  activeApi = null;
  bootstrapQueue.length = 0;
  keybindService._bindings.length = 0;
  installKeybindService();
  if (warnTimer) {
    clearTimeout(warnTimer);
    warnTimer = null;
  }
  warnTimer = setTimeout(() => {
    if (!activeApi && bootstrapQueue.length > 0) {
      console.warn(
        "[core-keybind] core-keybind 확장이 로드되지 않았습니다. " +
        `큐에 ${bootstrapQueue.length}개의 단축키가 등록 대기 중이지만 실제 등록되지 않습니다.`,
      );
    }
  }, 500);
}

export function _bootstrapKeybind(impl: CoreKeybindAPI): void {
  if (warnTimer) {
    clearTimeout(warnTimer);
    warnTimer = null;
  }

  activeApi = impl;

  for (const binding of bootstrapQueue) {
    impl.register(binding);
  }
  bootstrapQueue.length = 0;
}

function installKeybindService(): CoreKeybindAPI & typeof keybindState {
  return keybindService;
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry (registry.ts)
// ═══════════════════════════════════════════════════════════════════════════

function bindings(): ResolvedBinding[] {
  return getKeybindBindings();
}

export function addBinding(binding: ResolvedBinding): void {
  const bindingList = bindings();
  const idx = bindingList.findIndex(
    (b) => b.extension === binding.extension && b.action === binding.action,
  );

  if (idx >= 0) {
    bindingList[idx] = binding;
  } else {
    bindingList.push(binding);
  }

  recomputeConflicts(bindingList, binding);
}

export function getBindings(): ResolvedBinding[] {
  return [...bindings()];
}

export function getKey(extension: string, action: string): string | undefined {
  const binding = bindings().find(
    (b) => b.extension === extension && b.action === action,
  );
  return binding?.resolvedKey;
}

function recomputeConflicts(
  bindingList: ResolvedBinding[],
  changedBinding: ResolvedBinding,
): void {
  for (const binding of bindingList) {
    binding.conflicted = false;
  }

  for (let i = 0; i < bindingList.length; i += 1) {
    for (let j = i + 1; j < bindingList.length; j += 1) {
      const left = bindingList[i];
      const right = bindingList[j];
      if (left.resolvedKey !== right.resolvedKey) continue;

      left.conflicted = true;
      right.conflicted = true;
      if (isSameBinding(left, changedBinding) || isSameBinding(right, changedBinding)) {
        console.warn(
          `[core-keybind] 키 충돌: "${changedBinding.resolvedKey}" — ` +
          `${left.extension}/${left.action} ↔ ${right.extension}/${right.action}`,
        );
      }
    }
  }
}

function isSameBinding(left: ResolvedBinding, right: ResolvedBinding): boolean {
  return left.extension === right.extension && left.action === right.action;
}

// ═══════════════════════════════════════════════════════════════════════════
// Store (store.ts)
// ═══════════════════════════════════════════════════════════════════════════

export type KeybindingsConfig = Record<string, Record<string, string>>;

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KEYBINDINGS_PATH = path.resolve(EXT_DIR, "keybindings.json");
const KEYBINDINGS_DEFAULT_PATH = path.resolve(EXT_DIR, "keybindings.default.json");

function loadKeybindings(): KeybindingsConfig {
  return readKeybindingsFile(KEYBINDINGS_PATH)
    ?? readKeybindingsFile(KEYBINDINGS_DEFAULT_PATH)
    ?? {};
}

function getOverrideKey(extension: string, action: string): string | undefined {
  const extConfig = loadKeybindings()[extension];
  if (!extConfig || typeof extConfig !== "object") return undefined;
  const key = extConfig[action];
  return typeof key === "string" ? key : undefined;
}

function readKeybindingsFile(filePath: string): KeybindingsConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return null;
    return raw as KeybindingsConfig;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Editor Replace (editor-replace)
// ═══════════════════════════════════════════════════════════════════════════

const KEY_WIDTH = 14;
const MIN_EDITOR_CARD_WIDTH = 40;
const PANEL_COLOR = "\x1b[38;2;180;160;220m";
const ANSI_RESET = "\x1b[0m";

export class KeybindOverlay implements Component, Focusable {
  focused = false;

  private readonly theme: Theme;
  private readonly bindings: ResolvedBinding[];
  private readonly done: () => void;

  constructor(
    theme: Theme,
    bindings: ResolvedBinding[],
    done: () => void,
  ) {
    this.theme = theme;
    this.bindings = bindings;
    this.done = done;
  }

  handleInput(): void {
    this.done();
  }

  render(width: number): string[] {
    const frameWidth = resolveEditorCardWidth(width, MIN_EDITOR_CARD_WIDTH);

    const border = (s: string) => this.theme.fg("border", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const innerWidth = frameWidth - 4;
    const row = (content: string) => {
      const pad = Math.max(0, innerWidth - visibleWidth(content));
      return border("│ ") + content + " ".repeat(pad) + border(" │");
    };
    const emptyRow = () => row("");
    const bindingRow = (key: string, description: string, conflicted?: boolean) => {
      const displayKey = key.replace(/\b\w/g, (c) => c.toUpperCase());
      const paddedKey = " ".repeat(Math.max(0, KEY_WIDTH - displayKey.length)) + displayKey;
      const marker = conflicted ? this.theme.fg("warning", " ⚠") : "  ";
      const keyColor = conflicted ? "warning" : "accent";
      return row(`${marker}${this.theme.fg(keyColor, paddedKey)}  ${dim(description)}`);
    };

    const title = " Keybindings ";
    const titleLen = title.length;
    const sideLen = Math.max(0, Math.floor((frameWidth - 2 - titleLen) / 2));
    const rightLen = Math.max(0, frameWidth - 2 - sideLen - titleLen);
    const topBorder = border("╭" + "─".repeat(sideLen) + title + "─".repeat(rightLen) + "╮");
    const lines: string[] = [];
    lines.push(topBorder);
    lines.push(emptyRow());

    const categories = new Map<string, ResolvedBinding[]>();
    for (const binding of this.bindings) {
      const cat = binding.category ?? binding.extension;
      const list = categories.get(cat) ?? [];
      list.push(binding);
      categories.set(cat, list);
    }

    for (const [category, items] of categories) {
      lines.push(row(`  ${PANEL_COLOR}◇${ANSI_RESET} ${PANEL_COLOR}${category}${ANSI_RESET}`));
      for (const item of items) {
        lines.push(bindingRow(item.resolvedKey, item.description, item.conflicted));
      }
      lines.push(emptyRow());
    }

    if (this.bindings.length === 0) {
      lines.push(row(dim("등록된 키바인딩이 없습니다.")));
      lines.push(emptyRow());
    }

    lines.push(border("├" + "─".repeat(frameWidth - 2) + "┤"));
    lines.push(row(dim("Esc close")));
    lines.push(border("╰" + "─".repeat(frameWidth - 2) + "╯"));

    return lines;
  }

  invalidate(): void {}

  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Register (register.ts)
// ═══════════════════════════════════════════════════════════════════════════

let activePopup: Promise<void> | null = null;

export default function registerCoreKeybinds(pi: ExtensionAPI) {
  const realApi: CoreKeybindAPI = {
    register(binding: KeybindRegistration): void {
      const override = getOverrideKey(binding.extension, binding.action);
      const resolvedKey = override ?? binding.defaultKey;
      const resolved: ResolvedBinding = { ...binding, resolvedKey };

      addBinding(resolved);

      pi.registerShortcut(resolvedKey as any, {
        description: binding.description,
        handler: binding.handler,
      });
    },
    getBindings,
    getKey,
  };

  _bootstrapKeybind(realApi);

  const keybindApi = getKeybindAPI();
  keybindApi.register({
    extension: "core-keybind",
    action: "popup",
    defaultKey: "alt+.",
    description: "키바인딩 오버레이 팝업 표시",
    category: "Core",
    handler: async (ctx) => {
      await openKeybindPopup(ctx);
    },
  });

}

export function reregisterCoreKeybinds(pi: ExtensionAPI): void {
  for (const binding of getBindings()) {
    pi.registerShortcut(binding.resolvedKey as any, {
      description: binding.description,
      handler: binding.handler,
    });
  }
}

async function openKeybindPopup(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  if (activePopup) return;

  const bindings = getBindings();

  activePopup = ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) =>
      new KeybindOverlay(theme, bindings, done),
    {
      overlay: false,
    },
  );

  try {
    await activePopup;
  } finally {
    activePopup = null;
  }
}

function resolveEditorCardWidth(width: number, minWidth: number): number {
  return Math.max(minWidth, width);
}
