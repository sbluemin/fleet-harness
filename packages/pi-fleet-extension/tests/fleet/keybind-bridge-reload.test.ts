import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _bootstrapKeybind,
  getKeybindAPI,
  prepareKeybindBridgeForExtensionLoad,
} from "../../src/keybinds.js";
import type { CoreKeybindAPI, KeybindRegistration } from "../../src/keybinds.js";
import { addBinding, getBindings, getKey } from "../../src/keybinds.js";

describe("keybind bridge reload lifecycle", () => {
  beforeEach(() => {
    prepareKeybindBridgeForExtensionLoad();
  });

  it("clears stale keybind implementation before extension reload registrations", () => {
    const staleRegister = vi.fn(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });
    _bootstrapKeybind(makeApi(staleRegister));

    prepareKeybindBridgeForExtensionLoad();
    const binding = makeBinding();

    expect(() => getKeybindAPI().register(binding)).not.toThrow();
    expect(staleRegister).not.toHaveBeenCalled();

    const nextRegister = vi.fn();
    _bootstrapKeybind(makeApi(nextRegister));

    expect(nextRegister).toHaveBeenCalledWith(binding);
  });

  it("drops stale module-level implementation before extension reload registrations", () => {
    const staleRegister = vi.fn(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });
    _bootstrapKeybind(makeApi(staleRegister));

    prepareKeybindBridgeForExtensionLoad();
    const binding = makeBinding();

    expect(() => getKeybindAPI().register(binding)).not.toThrow();
    expect(staleRegister).not.toHaveBeenCalled();

    const nextRegister = vi.fn();
    _bootstrapKeybind(makeApi(nextRegister));

    expect(nextRegister).toHaveBeenCalledWith(binding);
  });

  it("queues registrations without fleet-core services and flushes them on bootstrap", () => {
    const firstBinding = makeBinding({ extension: "fleet", action: "panel-toggle" });
    const secondBinding = makeBinding({ extension: "fleet", action: "panel-grow" });
    const register = vi.fn();

    getKeybindAPI().register(firstBinding);
    getKeybindAPI().register(secondBinding);

    expect(getKeybindAPI().getBindings()).toEqual([]);

    _bootstrapKeybind(makeApi(register));

    expect(register).toHaveBeenNthCalledWith(1, firstBinding);
    expect(register).toHaveBeenNthCalledWith(2, secondBinding);
  });

  it("keeps the Pi-side registry independent across reload cleanup", () => {
    const conflictWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    addBinding(makeResolvedBinding({
      extension: "fleet",
      action: "panel-toggle",
      resolvedKey: "alt+p",
    }));
    addBinding(makeResolvedBinding({
      extension: "fleet",
      action: "panel-copy",
      resolvedKey: "alt+p",
    }));

    expect(getBindings()).toEqual([
      expect.objectContaining({ action: "panel-toggle", conflicted: true }),
      expect.objectContaining({ action: "panel-copy", conflicted: true }),
    ]);
    expect(getKey("fleet", "panel-toggle")).toBe("alt+p");

    addBinding(makeResolvedBinding({
      extension: "fleet",
      action: "panel-copy",
      resolvedKey: "alt+c",
    }));

    expect(getBindings()).toEqual([
      expect.objectContaining({ action: "panel-toggle", conflicted: false }),
      expect.objectContaining({ action: "panel-copy", conflicted: false }),
    ]);

    prepareKeybindBridgeForExtensionLoad();

    expect(getBindings()).toEqual([]);
    expect(getKey("fleet", "panel-toggle")).toBeUndefined();
    expect(conflictWarn).toHaveBeenCalledTimes(1);

    conflictWarn.mockRestore();
  });
});

function makeApi(register: (binding: KeybindRegistration) => void = () => {}): CoreKeybindAPI {
  return {
    register,
    getBindings: () => [],
    getKey: () => undefined,
  };
}

function makeBinding(
  overrides: Partial<KeybindRegistration> = {},
): KeybindRegistration {
  return {
    extension: "core-settings",
    action: "popup",
    defaultKey: "alt+/",
    description: "설정 오버레이 팝업 표시",
    handler: () => {},
    ...overrides,
  };
}

function makeResolvedBinding(
  overrides: Partial<KeybindRegistration> & { resolvedKey: string },
) {
  return {
    ...makeBinding(overrides),
    resolvedKey: overrides.resolvedKey,
  };
}
