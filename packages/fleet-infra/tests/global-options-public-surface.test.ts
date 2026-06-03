import { describe, expect, it } from "vitest";

import { createDurableJsonStore } from "../src/fs-store/index.js";
import { createGlobalOptionsService, createGlobalOptionsStore } from "../src/global-options/index.js";
import { createInfraServices, infra } from "../src/index.js";

describe("global options public surface", () => {
  it("exports global-options APIs from the root and subpath barrels", () => {
    const services = createInfraServices();

    expect(infra.globalOptions.createGlobalOptionsService).toBe(createGlobalOptionsService);
    expect(infra.globalOptions.createGlobalOptionsStore).toBe(createGlobalOptionsStore);
    expect(typeof services.globalOptionsService.load).toBe("function");
    expect("preset" in infra).toBe(false);
    expect(["preset", "Service"].join("") in services).toBe(false);
  });

  it("exports fs-store APIs from root barrel and infra.fsStore", () => {
    const services = createInfraServices();

    expect(typeof infra.fsStore.createDurableJsonStore).toBe("function");
    expect(infra.fsStore.createDurableJsonStore).toBe(createDurableJsonStore);
    expect(typeof services.fsStore.withDirectoryLock).toBe("function");
    expect(typeof services.fsStore.writeAtomicSync).toBe("function");
  });
});
