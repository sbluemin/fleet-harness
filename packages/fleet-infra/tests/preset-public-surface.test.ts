import { describe, expect, it } from "vitest";

import { createInfraServices, infra } from "../src/index.js";
import { createPresetService, createPresetStore } from "../src/preset/index.js";
import { createDurableJsonStore } from "../src/fs-store/index.js";

describe("preset public surface", () => {
  it("exports preset APIs from the root and subpath barrels", () => {
    const services = createInfraServices();

    expect(infra.preset.createPresetService).toBe(createPresetService);
    expect(infra.preset.createPresetStore).toBe(createPresetStore);
    expect(typeof services.presetService.load).toBe("function");
    expect("log" in infra).toBe(false);
    expect("log" in services).toBe(false);
  });

  it("exports fs-store APIs from root barrel and infra.fsStore", () => {
    const services = createInfraServices();

    // infra.fsStore에 createDurableJsonStore가 노출되어야 한다
    expect(typeof infra.fsStore.createDurableJsonStore).toBe("function");
    expect(infra.fsStore.createDurableJsonStore).toBe(createDurableJsonStore);
    expect(typeof services.fsStore.withDirectoryLock).toBe("function");
    expect(typeof services.fsStore.writeAtomicSync).toBe("function");
  });
});
