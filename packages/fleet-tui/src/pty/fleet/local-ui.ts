import type { InputListener } from "../../types.js";
import type { Component } from "./component.js";

export interface FleetPtyLocalUi {
  readonly terminal: {
    readonly cols: number;
    readonly rows: number;
  };
  addInputListener(listener: InputListener): () => void;
  requestResize(): void;
  requestRender(): void;
  setFocus(component: Component | null): void;
}

export interface FleetPtyLocalUiOptions {
  readonly addInputListener: (listener: InputListener) => () => void;
  readonly getColumns: () => number;
  readonly getRows: () => number;
  readonly requestResize?: () => void;
  readonly requestRender: () => void;
}

export function createFleetPtyLocalUi(options: FleetPtyLocalUiOptions): FleetPtyLocalUi {
  let focused: Component | null = null;
  return {
    get terminal() {
      return {
        cols: options.getColumns(),
        rows: options.getRows(),
      };
    },
    addInputListener: options.addInputListener,
    requestResize: () => options.requestResize?.(),
    requestRender: options.requestRender,
    setFocus(component) {
      focused = component;
      void focused;
    },
  };
}
