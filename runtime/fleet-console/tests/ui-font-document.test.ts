import { afterEach, describe, expect, it } from "vitest";

import { applyUiFontToDocument } from "../core/client/src/store.js";
import { DEFAULT_UI_FONT, UI_FONT_SIZE_RANGE, normalizeUiFont, uiFontFamily } from "../core/client/src/ui-font.js";

const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

describe("UI font document application", () => {
  it("uses a stable source marker and inline body tokens without exposing a system family attribute", () => {
    const root = createRoot();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });

    applyUiFontToDocument({ source: "system", familyName: 'A "hostile" \\ family', size: 18 });

    expect(root.attributes.get("data-ui-font")).toBe("system");
    expect([...root.attributes.values()]).not.toContain('A "hostile" \\ family');
    expect(root.style.getPropertyValue("--font-body")).toBe('"A \\"hostile\\" \\\\ family", "Manrope Variable", "Manrope", "Pretendard Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(root.style.getPropertyValue("--font-body-size")).toBe("18px");
    expect(root.style.getPropertyValue("--font-display")).toBe("");
    expect(root.style.getPropertyValue("--font-mono")).toBe("");
  });

  it("keeps built-ins atomic and validates size boundaries", () => {
    expect(normalizeUiFont({ source: "builtin", id: "source-code-pro", size: 12 })).toEqual({ source: "builtin", id: "source-code-pro", size: 12 });
    expect(normalizeUiFont({ source: "builtin", id: "source-code-pro", size: 18 })).toEqual({ source: "builtin", id: "source-code-pro", size: 18 });
    expect(normalizeUiFont({ source: "builtin", id: "source-code-pro", size: 11 })).toEqual({ source: "builtin", id: "source-code-pro", size: UI_FONT_SIZE_RANGE.defaultValue });
    expect(normalizeUiFont({ source: "system", familyName: "\u0000", size: 14 })).toEqual(DEFAULT_UI_FONT);
  });

  it("uses a safely quoted fallback stack for system families", () => {
    expect(uiFontFamily({ source: "system", familyName: 'ACME "Sans"', size: 14 })).toContain('"ACME \\"Sans\\""');
  });
});

function createRoot() {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  return {
    attributes,
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      getPropertyValue: (name: string) => properties.get(name) ?? "",
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
}
