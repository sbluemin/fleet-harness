import type { Component as TuiComponent, Focusable as TuiFocusable } from "../../types.js";
import type { RoutedMouseInput } from "../../input/input-router.js";
import type { DesiredHeight } from "../types.js";

export type Component = TuiComponent & {
  desiredHeight?(maxRows: number): DesiredHeight | undefined;
  handleMouse?(event: RoutedMouseInput): boolean | void;
};

export type Focusable = TuiFocusable;

export type DisposableComponent = Component & {
  dispose?(): void;
};

export function isFocusable(component: Component): component is Component & Focusable {
  return "focused" in component && typeof (component as Focusable).focused === "boolean";
}
