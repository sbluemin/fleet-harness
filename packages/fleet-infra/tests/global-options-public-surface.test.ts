import { describe, expect, it } from "vitest";

import { createDurableJsonStore, withDirectoryLock, writeAtomicSync } from "../src/fs-store/index.js";
import { createGlobalOptionsService, createGlobalOptionsStore } from "../src/global-options/index.js";
import * as rootBarrel from "../src/index.js";
import { createInfraServices } from "../src/index.js";

describe("global options public surface", () => {
  it("exports global-options APIs from the root and subpath barrels", () => {
    const services = createInfraServices();

    // 루트 barrel과 서브패스 barrel의 named export 동일성 검증
    expect(rootBarrel.createGlobalOptionsService).toBe(createGlobalOptionsService);
    expect(rootBarrel.createGlobalOptionsStore).toBe(createGlobalOptionsStore);
    expect(typeof services.globalOptionsService.load).toBe("function");
    expect("preset" in rootBarrel).toBe(false);
    expect(["preset", "Service"].join("") in services).toBe(false);
  });

  it("exports fs-store APIs from the root barrel", () => {
    // 집계 객체 없이 named export로만 일원화된 공개 표면 검증
    expect(rootBarrel.createDurableJsonStore).toBe(createDurableJsonStore);
    expect(rootBarrel.withDirectoryLock).toBe(withDirectoryLock);
    expect(rootBarrel.writeAtomicSync).toBe(writeAtomicSync);
    expect("infra" in rootBarrel).toBe(false);
  });
});
