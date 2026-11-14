import { describe, expect, it } from "vitest";
import type { Translate } from "@fleet-console/i18n";
import type { CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";
import type { BrowserEngineState } from "../../browser/client/browser-engine.js";
import { browserSettingsSectionVisible, buildCoreSettingsSections, resolveSettingsSectionId } from "./sections.js";

const t = ((key: string) => key) as Translate<CoreMessageKey>;
const native: Exclude<BrowserEngineState, null> = {
  available: true,
  surfaceMode: "native",
  executionHost: { managed: true, connected: true, status: "connected", hostLabel: null, platform: "darwin", accessPath: "loopback" },
};
const local = { remoteAccess: { enabled: false } } as unknown as GlobalSettingsState;
const remote = {} as GlobalSettingsState;

describe("browser settings section", () => {
  it("shows Browser only on a managing desktop and keeps remote or web sessions on the default section", () => {
    expect(browserSettingsSectionVisible({ desktopShell: false, state: local, engine: native })).toBe(false);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: remote, engine: native })).toBe(false);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: local, engine: null })).toBe(true);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: null, engine: null })).toBe(false);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: local, engine: { ...native, surfaceMode: "viewer" } })).toBe(false);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: local, engine: { ...native, executionHost: { ...native.executionHost, status: "unmanaged" } } })).toBe(false);
    expect(browserSettingsSectionVisible({ desktopShell: true, state: local, engine: native })).toBe(true);

    const hidden = buildCoreSettingsSections(t, local, false);
    expect(hidden.map((section) => section.id)).not.toContain("browser");
    expect(hidden.find((section) => section.id === "advanced")?.entries.join(" ")).not.toMatch(/Fleet Browser|Google/);
    expect(resolveSettingsSectionId("browser", new Set(hidden.map((section) => section.id)))).toBeNull();

    const shown = buildCoreSettingsSections(t, local, true);
    const browser = shown.find((section) => section.id === "browser");
    expect(browser?.group).toBe("machine");
    expect(browser?.entries.join(" ")).toMatch(/password/);
    expect(browser?.entries.join(" ")).toMatch(/비밀번호/);
    expect(browser?.entries.join(" ")).toMatch(/자동완성/);
    expect(browser?.entries.join(" ")).toMatch(/Fleet Browser/);
    expect(shown.find((section) => section.id === "advanced")?.entries.join(" ")).not.toMatch(/Fleet Browser/);
    expect(resolveSettingsSectionId("browser", new Set(shown.map((section) => section.id)))).toBe("browser");
  });
});
