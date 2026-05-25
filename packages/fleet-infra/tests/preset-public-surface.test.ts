import { describe, expect, it } from "vitest";

import { createInfraServices, infra } from "../src/index.js";
import { createPresetService, createPresetStore } from "../src/preset/index.js";

describe("preset public surface", () => {
  it("exports preset APIs from the root and subpath barrels", () => {
    const services = createInfraServices();

    expect(infra.preset.createPresetService).toBe(createPresetService);
    expect(infra.preset.createPresetStore).toBe(createPresetStore);
    expect(typeof services.presetService.load).toBe("function");
  });
});
