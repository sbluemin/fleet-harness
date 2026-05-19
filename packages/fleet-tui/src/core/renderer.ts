import { ANSI_HIDE_CURSOR, ANSI_SHOW_CURSOR, clearScreen, clearToEnd, eraseLine, moveCursorHome, moveCursorTo } from "./ansi.js";
import { getTerminalSize } from "./terminal-size.js";
import { fitLine } from "../primitives/text.js";
import type { Component, InputListener, TerminalSize } from "../types.js";

export class LocalTui {
  private children: Component[] = [];
  private inputListeners: InputListener[] = [];
  private running = false;
  private size: TerminalSize = getTerminalSize();

  public addChild(component: Component): void {
    this.children.push(component);
  }

  public setChildren(components: Component[]): void {
    this.children = components;
  }

  public addInputListener(listener: InputListener): () => void {
    this.inputListeners.push(listener);
    return () => {
      this.inputListeners = this.inputListeners.filter((candidate) => candidate !== listener);
    };
  }

  public emitInput(data: string): void {
    for (const listener of this.inputListeners) {
      const result = listener(data);
      if (result?.consume) {
        return;
      }
    }
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    process.stdout.write(`${ANSI_HIDE_CURSOR}${clearScreen()}`);
    this.requestRender();
  }

  public stop(): void {
    this.running = false;
    process.stdout.write(ANSI_SHOW_CURSOR);
  }

  public refreshSize(size: TerminalSize): void {
    this.size = size;
  }

  public requestRender(): void {
    if (!this.running) {
      return;
    }

    this.refreshSize(getTerminalSize());
    const lines = this.children.flatMap((component) => component.render(this.size.columns)).slice(0, this.size.rows);
    const frame = Array.from({ length: this.size.rows }, (_, index) => {
      const line = lines[index] ?? "";
      return `${moveCursorTo(index + 1, 1)}${eraseLine()}${fitLine(line, this.size.columns)}`;
    }).join("");
    process.stdout.write(`${moveCursorHome()}${frame}${clearToEnd()}${ANSI_HIDE_CURSOR}`);
  }

  public get columns(): number {
    return this.size.columns;
  }

  public get rows(): number {
    return this.size.rows;
  }
}
