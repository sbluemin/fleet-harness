import { centerLine, fitLine, truncateToWidth, visibleWidth } from "@dotobokuri/fleet-tui/primitives";
import type { Focusable } from "@dotobokuri/fleet-tui/components";

import type {
  CreateFleetPtyApiOptions,
  FleetPtyApi,
  FleetPtyBgColor,
  FleetPtyCustomOptions,
  FleetPtyFgColor,
  FleetPtyLocalUi,
  FleetPtyLocalUiOptions,
  FleetPtyOverlay,
  FleetPtyRegion,
  FleetPtySection,
  FleetPtyTheme,
  KeyId,
  Component,
} from "./types.js";

export { centerLine, fitLine, truncateToWidth, visibleWidth };
export type { Component, Focusable };
export type {
  FleetPtyApi,
  FleetPtyCustomFactory,
  FleetPtyCustomOptions,
  FleetPtyOverlay,
  FleetPtyRegion,
  FleetPtySection,
  FleetPtyTheme,
} from "./types.js";

interface OverlayManager {
  readonly current: () => FleetPtyOverlay | undefined;
  readonly mount: (overlay: FleetPtyOverlay) => FleetPtyOverlay;
  readonly unmount: () => FleetPtyOverlay | undefined;
}

interface RegionStack {
  readonly current: () => FleetPtyRegion;
  readonly isDefault: () => boolean;
  readonly pop: () => FleetPtyRegion;
  readonly push: (region: FleetPtyRegion) => FleetPtyRegion;
  readonly replace: (region: FleetPtyRegion) => FleetPtyRegion;
}

export interface OverlayFrameOptions {
  readonly body: readonly OverlayFrameBodyLine[];
  readonly footer?: string;
  readonly theme: FleetPtyTheme;
  readonly title: string;
  readonly width: number;
}

export type OverlayFrameBodyLine = string | {
  readonly bg?: string;
  readonly text: string;
};

export const Key = {
  alt(key: "o"): KeyId {
    return `alt+${key}` as KeyId;
  },
} as const;

const KEY_SEQUENCES: Record<KeyId, readonly string[]> = {
  "alt+o": ["\x1bo", "\x1bO"],
  backspace: ["\x7f", "\b", "\x1b[127u"],
  down: ["\x1b[B", "\x1bOB"],
  end: ["\x1b[F", "\x1b[4~", "\x1b[8~"],
  enter: ["\r", "\n", "\x1b[13u"],
  escape: ["\x1b", "\x1b[27u"],
  home: ["\x1b[H", "\x1b[1~", "\x1b[7~"],
  left: ["\x1b[D", "\x1bOD"],
  pagedown: ["\x1b[6~"],
  pageup: ["\x1b[5~"],
  right: ["\x1b[C", "\x1bOC"],
  t: ["t", "T"],
  up: ["\x1b[A", "\x1bOA"],
};

const FG: Record<FleetPtyFgColor, string> = {
  accent: "\x1b[38;5;75m",
  border: "\x1b[38;5;33m",
  dim: "\x1b[38;5;244m",
  error: "\x1b[38;5;203m",
  muted: "\x1b[38;5;110m",
  success: "\x1b[38;5;79m",
  warning: "\x1b[38;5;221m",
};
const BG: Record<FleetPtyBgColor, string> = {
  panel: "\x1b[48;5;17m",
  selected: "\x1b[48;5;24m",
};
const RESET = "\x1b[0m";
const BORDER = {
  bottomLeft: "╰",
  bottomRight: "╯",
  h: "─",
  topLeft: "╭",
  topRight: "╮",
  vertical: "│",
} as const;
const MIN_FRAME_WIDTH = 24;

export function createFleetPtyApi(
  options: CreateFleetPtyApiOptions,
  localUiOptions: FleetPtyLocalUiOptions,
): FleetPtyApi {
  const mountedSections = [...(options.sections ?? [])];
  const defaultRegion = {
    component: options.defaultComponent,
    id: "default-fleet-region",
  };
  const overlays = createOverlayManager();
  const regions = createRegionStack(defaultRegion);
  const localUi = createFleetPtyLocalUi(localUiOptions);
  const theme = createFleetPtyTheme();
  let closeActive: (() => void) | undefined;

  return {
    custom: async (factory, opts: FleetPtyCustomOptions = { overlay: false }) => {
      void opts;
      return new Promise((resolve, reject) => {
        let mounted = false;
        let settled = false;
        const finish = (result: unknown, resolveResult: boolean) => {
          if (settled) {
            return;
          }

          settled = true;
          closeActive = undefined;
          overlays.unmount();
          if (mounted) {
            regions.pop();
          }
          notifyLayoutChange(localUi);
          if (resolveResult) {
            resolve(result as never);
          } else {
            reject(result);
          }
        };
        const done = (result: unknown) => finish(result, true);

        closeActive = () => done(undefined);
        Promise.resolve(factory(localUi, theme, { Key, matchesKey }, done))
          .then((component) => {
            mounted = true;
            overlays.mount({ component, id: "custom-overlay" });
            regions.push({ component, id: "custom-overlay" });
            localUi.setFocus(component);
            notifyLayoutChange(localUi);
          })
          .catch((error: unknown) => finish(error, false));
      });
    },
    dispatchInput: (data) => {
      if (regions.isDefault()) {
        return false;
      }

      regions.current().component.handleInput?.(data);
      return true;
    },
    dispatchMouse: (event) => {
      if (regions.isDefault()) {
        return true;
      }

      const result = regions.current().component.handleMouse?.(event);
      return result !== false;
    },
    getCurrentRegion: () => regions.current(),
    getDesiredHeight: (maxRows) => regions.current().component.desiredHeight?.(maxRows),
    getSections: () => [...mountedSections],
    hasActiveOverlay: () => !regions.isDefault(),
    mountSection: (section) => {
      mountedSections.push(section);
      defaultRegion.component.invalidate();
    },
    popOverlay: () => {
      if (closeActive) {
        closeActive();
        closeActive = undefined;
        return regions.current();
      }

      closeActive = undefined;
      overlays.unmount();
      const region = regions.pop();
      notifyLayoutChange(localUi);
      return region;
    },
    pushOverlay: (overlay) => {
      overlays.mount(overlay);
      const region = regions.push({ component: overlay.component, id: overlay.id });
      notifyLayoutChange(localUi);
      return region;
    },
    replaceRegion: (region) => {
      const next = regions.replace(region);
      notifyLayoutChange(localUi);
      return next;
    },
  };
}

export function createFleetPtyLocalUi(options: FleetPtyLocalUiOptions): FleetPtyLocalUi {
  let focused: Component | undefined;
  return {
    addInputListener: options.addInputListener,
    getColumns: options.getColumns,
    getRows: options.getRows,
    requestResize: options.requestResize,
    requestRender: options.requestRender,
    setFocus(component): void {
      focused?.setFocus?.(false);
      focused = component;
      focused.setFocus?.(true);
    },
  };
}

export function createFleetPtyTheme(): FleetPtyTheme {
  return {
    accent(text): string {
      return `${FG.accent}${text}${RESET}`;
    },
    bg(name, text): string {
      return `${BG[name]}${text}${RESET}`;
    },
    bold(text): string {
      return `\x1b[1m${text}${RESET}`;
    },
    border(text): string {
      return `${FG.border}${text}${RESET}`;
    },
    dim(text): string {
      return `${FG.dim}${text}${RESET}`;
    },
    error(text): string {
      return `${FG.error}${text}${RESET}`;
    },
    fg(name, text): string {
      return `${FG[name]}${text}${RESET}`;
    },
    muted(text): string {
      return `${FG.muted}${text}${RESET}`;
    },
    reset(text): string {
      return `${text}${RESET}`;
    },
    success(text): string {
      return `${FG.success}${text}${RESET}`;
    },
    warning(text): string {
      return `${FG.warning}${text}${RESET}`;
    },
  };
}

export function matchesKey(data: string, keyId: KeyId): boolean {
  return KEY_SEQUENCES[keyId].includes(data);
}

export function isPrintable(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data);
}

export function createOverlayFrame(options: OverlayFrameOptions): string[] {
  const width = Math.max(MIN_FRAME_WIDTH, options.width);
  const innerWidth = Math.max(0, width - 4);
  const title = ` ${truncateToWidth(options.title, innerWidth)} `;
  const topFill = Math.max(0, width - 2 - visibleWidth(title));
  const leftFill = Math.floor(topFill / 2);
  const rightFill = topFill - leftFill;
  const top = options.theme.border(`${BORDER.topLeft}${BORDER.h.repeat(leftFill)}${title}${BORDER.h.repeat(rightFill)}${BORDER.topRight}`);
  const body = options.body.map((line) => frameBodyLine(line, innerWidth, options.theme));
  const footer = options.footer ? [frameBodyLine(options.theme.dim(options.footer), innerWidth, options.theme)] : [];
  const bottom = options.theme.border(`${BORDER.bottomLeft}${BORDER.h.repeat(Math.max(0, width - 2))}${BORDER.bottomRight}`);
  return [top, ...body, ...footer, bottom];
}

export function resolveOverlayFrameWidth(width: number): number {
  return Math.max(MIN_FRAME_WIDTH, width);
}

function notifyLayoutChange(localUi: FleetPtyLocalUi): void {
  localUi.requestResize();
  localUi.requestRender();
}

function createOverlayManager(): OverlayManager {
  let currentOverlay: FleetPtyOverlay | undefined;
  return {
    current: () => currentOverlay,
    mount(overlay): FleetPtyOverlay {
      disposeOverlay(currentOverlay);
      currentOverlay = overlay;
      overlay.component.setFocus?.(true);
      return overlay;
    },
    unmount(): FleetPtyOverlay | undefined {
      const overlay = currentOverlay;
      disposeOverlay(overlay);
      currentOverlay = undefined;
      return overlay;
    },
  };
}

function disposeOverlay(overlay: FleetPtyOverlay | undefined): void {
  overlay?.component.setFocus?.(false);
  overlay?.component.dispose?.();
}

function createRegionStack(defaultRegion: FleetPtyRegion): RegionStack {
  const stack: FleetPtyRegion[] = [defaultRegion];
  setFocused(defaultRegion, true);

  return {
    current: () => stack[stack.length - 1] ?? defaultRegion,
    isDefault: () => stack.length === 1,
    pop(): FleetPtyRegion {
      if (stack.length === 1) {
        return defaultRegion;
      }

      const popped = stack.pop();
      setFocused(popped, false);
      setFocused(stack[stack.length - 1], true);
      return popped ?? defaultRegion;
    },
    push(region): FleetPtyRegion {
      setFocused(stack[stack.length - 1], false);
      stack.push(region);
      setFocused(region, true);
      return region;
    },
    replace(region): FleetPtyRegion {
      const previous = stack.pop();
      setFocused(previous, false);
      stack.push(region);
      setFocused(region, true);
      return region;
    },
  };
}

function setFocused(region: FleetPtyRegion | undefined, focused: boolean): void {
  region?.component.setFocus?.(focused);
}

function frameBodyLine(line: OverlayFrameBodyLine, innerWidth: number, theme: FleetPtyTheme): string {
  const text = typeof line === "string" ? line : line.text;
  const bg = typeof line === "string" ? undefined : line.bg;
  const fitted = fitLine(text, innerWidth);
  const wrapped = bg ? `${bg}${fitted.replaceAll("\x1b[0m", `\x1b[0m${bg}`)}\x1b[0m` : fitted;
  return `${theme.border(BORDER.vertical)} ${wrapped} ${theme.border(BORDER.vertical)}`;
}
