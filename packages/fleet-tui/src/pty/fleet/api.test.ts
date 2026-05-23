import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFleetPtyApi } from "./api.js";
import type { Component } from "./component.js";
import type { RoutedMouseInput } from "../../input/input-router.js";

describe("fleet pty api", () => {
  it("consumes default-region mouse events as no-op", () => {
    const api = createFleetPtyApi(
      { defaultComponent: component() },
      localUiOptions(),
    );

    assert.equal(api.dispatchMouse(mouseEvent()), true);
  });

  it("dispatches mouse events to active overlays with local coordinates", () => {
    const events: string[] = [];
    const api = createFleetPtyApi(
      { defaultComponent: component() },
      localUiOptions(),
    );

    api.pushOverlay({
      component: component({
        handleMouse(event) {
          events.push(`${event.localColumn}:${event.localRow}:${event.wheelDirection}`);
        },
      }),
      id: "overlay",
    });

    assert.equal(api.dispatchMouse(mouseEvent()), true);
    assert.deepEqual(events, ["2:1:down"]);
  });
});

function component(overrides: Partial<Component> = {}): Component {
  return {
    desiredHeight: () => 1,
    handleInput: () => undefined,
    invalidate: () => undefined,
    render: () => [""],
    ...overrides,
  };
}

function localUiOptions(): Parameters<typeof createFleetPtyApi>[1] {
  return {
    addInputListener: () => () => undefined,
    getColumns: () => 20,
    getRows: () => 5,
    requestRender: () => undefined,
    requestResize: () => undefined,
  };
}

function mouseEvent(): RoutedMouseInput {
  return {
    buttonCode: 65,
    column: 2,
    final: "M",
    localColumn: 2,
    localRow: 1,
    raw: "\x1b[<65;2;4M",
    row: 4,
    wheelDirection: "down",
  };
}
