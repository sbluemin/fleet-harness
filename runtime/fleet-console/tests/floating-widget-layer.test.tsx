// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FloatingWidgetDescriptor } from "@fleet-console/sdk/floating";
import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

let floatingWidgets: readonly FloatingWidgetDescriptor[] = [];

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({ floatingWidgets }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let FloatingWidgetLayer: typeof import("../core/client/src/floating-widget-layer.js").FloatingWidgetLayer;

beforeAll(async () => {
  ({ FloatingWidgetLayer } = await import("../core/client/src/floating-widget-layer.js"));
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  floatingWidgets = [];
  vi.restoreAllMocks();
});

describe("FloatingWidgetLayer", () => {
  it("renders a plugin contribution with its registry identity", () => {
    const plugin: FleetClientPlugin = {
      id: "demo",
      floatingWidgets: [{
        id: "mascot",
        render: (context) => createElement("button", {
          type: "button",
          "data-language": context.language,
        }, "Admiral Sam"),
      }],
    };

    renderLayer([plugin]);

    const layer = container.querySelector(".floating-widget-layer");
    expect(layer?.querySelector(".floating-widget")?.textContent).toBe("Admiral Sam");
    expect(floatingWidgets[0]?.id).toBe("demo:mascot");
  });

  it("is absent when no plugin contributes a widget", () => {
    renderLayer([]);

    expect(container.querySelector(".floating-widget-layer")).toBeNull();
  });

  it("isolates a throwing widget from the rest of the shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin: FleetClientPlugin = {
      id: "broken",
      floatingWidgets: [{
        id: "widget",
        render: () => {
          throw new Error("widget failed");
        },
      }],
    };

    expect(() => renderLayer([plugin])).not.toThrow();
    expect(container.querySelector(".floating-widget-layer")).not.toBeNull();
    expect(container.querySelector(".floating-widget")?.textContent).toBe("Plugin failed to render.");
  });
});

function renderLayer(plugins: readonly FleetClientPlugin[]): void {
  floatingWidgets = plugins.flatMap((plugin) => (plugin.floatingWidgets ?? []).map((descriptor) => ({
    ...descriptor,
    id: `${plugin.id}:${descriptor.id}`,
  })));
  act(() => {
    root.render(<FloatingWidgetLayer />);
  });
}
