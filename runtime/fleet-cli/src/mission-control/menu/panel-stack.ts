import type { Component } from "../../controls/index.js";

export interface MenuRenderContext {
  readonly width: number;
}

export interface MenuPanel {
  readonly id: string;
  readonly title: string;
  handleInput?(data: string): boolean;
  render(context: MenuRenderContext): readonly string[];
  dispose?(): void;
}

export interface PanelStack {
  readonly component: Component;
  readonly current: () => MenuPanel;
  readonly breadcrumbs: () => readonly string[];
  readonly depth: () => number;
  readonly pop: () => boolean;
  readonly push: (panel: MenuPanel) => void;
  readonly replace: (panel: MenuPanel) => void;
  readonly reset: (panel: MenuPanel) => void;
}

interface CreatePanelStackOptions {
  readonly root: MenuPanel;
  readonly onEmpty: () => void;
  readonly onRenderRequest: () => void;
}

export function createPanelStack(options: CreatePanelStackOptions): PanelStack {
  let stack: MenuPanel[] = [options.root];

  const api: PanelStack = {
    breadcrumbs: () => stack.map((panel) => panel.title),
    component: {
      handleInput(data: string): void {
        const currentPanel = api.current();
        if (currentPanel.handleInput?.(data) === true) {
          options.onRenderRequest();
          return;
        }
        if (isEscape(data)) {
          if (!api.pop()) {
            options.onEmpty();
          }
          options.onRenderRequest();
        }
      },
      invalidate(): void {},
      render(width: number): string[] {
        return [...api.current().render({ width })];
      },
    },
    current: () => stack[stack.length - 1] ?? options.root,
    depth: () => stack.length,
    pop(): boolean {
      if (stack.length <= 1) {
        return false;
      }
      const removed = stack.pop();
      removed?.dispose?.();
      return true;
    },
    push(panel: MenuPanel): void {
      stack.push(panel);
    },
    replace(panel: MenuPanel): void {
      const removed = stack.pop();
      removed?.dispose?.();
      stack.push(panel);
    },
    reset(panel: MenuPanel): void {
      for (const entry of stack) {
        entry.dispose?.();
      }
      stack = [panel];
    },
  };

  return api;
}

export function renderBreadcrumbs(breadcrumbs: readonly string[]): string {
  return breadcrumbs.join(" / ");
}

export function isEnter(data: string): boolean {
  return data === "\r" || data === "\n" || data === "\x1b[13u";
}

export function isEscape(data: string): boolean {
  return data === "\x1b";
}

export function isDown(data: string): boolean {
  return data === "\x1b[B" || data === "\x1bOB";
}

export function isUp(data: string): boolean {
  return data === "\x1b[A" || data === "\x1bOA";
}

export function isPrintable(data: string): boolean {
  return data.length > 0 && [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}
